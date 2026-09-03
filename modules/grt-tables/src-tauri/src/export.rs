//! The readable archive beside the opaque working file.

use rusqlite::types::ValueRef;
use rusqlite::Connection;

use crate::db::{quote_ident, list_tables};

pub const MANIFEST: &str = "manifest.json";
pub const SCHEMA: &str = "content/schema.sql";
pub const DATA: &str = "content/data.sql";

/// Builds the text parts of an archive from a live database.
pub fn parts_of(connection: &Connection) -> Result<Vec<(String, String)>, String> {
    let tables = list_tables(connection)?;

    let mut names: Vec<String> = tables
        .iter()
        .filter(|entry| entry["kind"] == "table")
        .filter_map(|entry| entry["name"].as_str().map(str::to_string))
        .collect();
    names.sort();

    let mut views: Vec<String> = tables
        .iter()
        .filter(|entry| entry["kind"] == "view")
        .filter_map(|entry| entry["name"].as_str().map(str::to_string))
        .collect();
    views.sort();

    let mut schema = String::from(
        "-- Schema, written by GRT Tables.\n\
         -- Tables in alphabetical order, so two exports of the same database\n\
         -- produce the same bytes.\n\n",
    );

    for name in names.iter().chain(views.iter()) {
        let sql: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = ?1",
                [name.as_str()],
                |row| row.get(0),
            )
            .map_err(|e| format!("Cannot read the definition of {name}: {e}"))?;

        if let Some(sql) = sql {
            schema.push_str(sql.trim());
            schema.push_str(";\n\n");
        }
    }

    // Indexes, after the tables they belong to.
    {
        let mut statement = connection
            .prepare(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .map_err(|e| format!("Cannot read the indexes: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("Cannot read the indexes: {e}"))?;
        for row in rows {
            schema.push_str(row.map_err(|e| format!("Cannot read the indexes: {e}"))?.trim());
            schema.push_str(";\n");
        }
    }

    let mut data = String::from(
        "-- Data, written by GRT Tables.\n\
         -- Rows in primary-key order, for the same reason.\n\n",
    );

    for name in &names {
        data.push_str(&format!("-- {name}\n"));
        data.push_str(&rows_of(connection, name)?);
        data.push('\n');
    }

    let manifest = serde_json::json!({
        "version": 1,
        "type": "tables",
        "tables": names,
        "views": views,
    });

    Ok(vec![
        (
            MANIFEST.to_string(),
            format!("{}\n", serde_json::to_string_pretty(&manifest)
                .map_err(|e| format!("Cannot write the manifest: {e}"))?),
        ),
        (SCHEMA.to_string(), schema),
        (DATA.to_string(), data),
    ])
}

/// Every row of one table, as INSERT statements in a stable order.
fn rows_of(connection: &Connection, table: &str) -> Result<String, String> {
    let quoted = quote_ident(table);

    let columns: Vec<String> = {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({quoted})"))
            .map_err(|e| format!("Cannot read {table}: {e}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("Cannot read {table}: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("Cannot read {table}: {e}"))?);
        }
        out
    };

    if columns.is_empty() {
        return Ok(String::new());
    }

    let names: Vec<String> = columns.iter().map(|c| quote_ident(c)).collect();

    // Ordered by rowid, which for a table with an INTEGER PRIMARY KEY is the
    // primary key itself and otherwise is a stable insertion order.
    let sql = format!("SELECT {} FROM {quoted} ORDER BY rowid", names.join(", "));
    let mut statement = connection
        .prepare(&sql)
        .map_err(|e| format!("Cannot read {table}: {e}"))?;

    let rows = statement
        .query_map([], |row| {
            let mut values = Vec::new();
            for i in 0..columns.len() {
                values.push(literal(row.get_ref(i)?));
            }
            Ok(values.join(", "))
        })
        .map_err(|e| format!("Cannot read {table}: {e}"))?;

    let mut out = String::new();
    for row in rows {
        let values = row.map_err(|e| format!("Cannot read {table}: {e}"))?;
        out.push_str(&format!(
            "INSERT INTO {quoted} ({}) VALUES ({values});\n",
            names.join(", ")
        ));
    }

    Ok(out)
}

/// A value as a SQL literal.
fn literal(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "NULL".to_string(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(n) => {
            // `{:?}` on a float round-trips exactly, which `{}` does not.
            let text = format!("{n:?}");
            if text.contains('.') || text.contains('e') || text.contains("inf") || text.contains("NaN") {
                text
            } else {
                format!("{text}.0")
            }
        }
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            format!("'{}'", text.replace('\'', "''"))
        }
        ValueRef::Blob(bytes) => {
            let mut hex = String::with_capacity(bytes.len() * 2 + 3);
            hex.push_str("X'");
            for byte in bytes {
                hex.push_str(&format!("{byte:02X}"));
            }
            hex.push('\'');
            hex
        }
    }
}

/// Rebuilds a database from the text parts of an archive.
pub fn restore(connection: &Connection, schema: &str, data: &str) -> Result<(), String> {
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|e| format!("Cannot prepare the import: {e}"))?;

    connection
        .execute_batch(schema)
        .map_err(|e| format!("The schema in that archive could not be applied: {e}"))?;

    connection
        .execute_batch(data)
        .map_err(|e| format!("The data in that archive could not be applied: {e}"))?;

    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("Cannot finish the import: {e}"))?;

    Ok(())
}
