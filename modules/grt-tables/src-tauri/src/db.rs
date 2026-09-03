//! The database itself.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OpenFlags};

pub struct Database {
    pub connection: Connection,
    pub path: Option<PathBuf>,
    pub read_only: bool,
    /// How many savepoints are open, which is how deep undo can go.
    pub depth: usize,
    /// Savepoints that have been rolled back and can be redone.
    pub redo: Vec<Vec<String>>,
}

impl Database {
    /// A new database, writable from the start because this program made it.
    pub fn create(path: Option<&Path>) -> Result<Self, String> {
        let connection = match path {
            Some(path) => Connection::open(path)
                .map_err(|e| format!("Cannot create {}: {e}", path.display()))?,
            // Ephemeral mode gets a database that never touches the disk.
            None => Connection::open_in_memory()
                .map_err(|e| format!("Cannot create a database in memory: {e}"))?,
        };

        prepare(&connection)?;

        Ok(Database {
            connection,
            path: path.map(Path::to_path_buf),
            read_only: false,
            depth: 0,
            redo: Vec::new(),
        })
    }

    /// An existing database.
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;

        prepare(&connection)?;

        Ok(Database {
            connection,
            path: Some(path.to_path_buf()),
            read_only: true,
            depth: 0,
            redo: Vec::new(),
        })
    }

    pub fn refuse_if_read_only(&self) -> Result<(), String> {
        if self.read_only {
            return Err("This database is open for reading only. Unlock it first.".to_string());
        }
        Ok(())
    }
}

/// Settings applied to every connection.
fn prepare(connection: &Connection) -> Result<(), String> {
    // Foreign keys are off by default in SQLite, which makes every foreign
    // key in the schema decorative until this runs.
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = DELETE;
             PRAGMA secure_delete = ON;",
        )
        .map_err(|e| format!("Cannot prepare the database: {e}"))?;
    Ok(())
}

/* `journal_mode = DELETE` rather than WAL, and `secure_delete = ON`. */

// Identifiers.

/// The only place a name is put into SQL text.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Refuses a name that could not possibly be a real one.
pub fn check_ident(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("A name cannot be empty".to_string());
    }
    if name.len() > 128 {
        return Err("That name is too long".to_string());
    }
    if name.contains('\0') || name.contains('\n') || name.contains('\r') {
        return Err("That name contains characters a name cannot have".to_string());
    }
    Ok(())
}

// Reading.

/// The tables in the database, alphabetically.
pub fn list_tables(connection: &Connection) -> Result<Vec<serde_json::Value>, String> {
    let mut statement = connection
        .prepare(
            "SELECT name, type FROM sqlite_master
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .map_err(|e| format!("Cannot read the schema: {e}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "name": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
            }))
        })
        .map_err(|e| format!("Cannot read the schema: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("Cannot read the schema: {e}"))?);
    }
    Ok(out)
}

/// Columns, foreign keys and indexes for one table.
pub fn describe_table(connection: &Connection, table: &str) -> Result<serde_json::Value, String> {
    check_ident(table)?;
    let quoted = quote_ident(table);

    let mut columns = Vec::new();
    {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({quoted})"))
            .map_err(|e| format!("Cannot read {table}: {e}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "name": row.get::<_, String>(1)?,
                    "type": row.get::<_, String>(2)?,
                    "notNull": row.get::<_, i64>(3)? != 0,
                    "default": row.get::<_, Option<String>>(4)?,
                    "primaryKey": row.get::<_, i64>(5)? != 0,
                }))
            })
            .map_err(|e| format!("Cannot read {table}: {e}"))?;
        for row in rows {
            columns.push(row.map_err(|e| format!("Cannot read {table}: {e}"))?);
        }
    }

    let mut foreign_keys = Vec::new();
    {
        let mut statement = connection
            .prepare(&format!("PRAGMA foreign_key_list({quoted})"))
            .map_err(|e| format!("Cannot read {table}: {e}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "column": row.get::<_, String>(3)?,
                    "table": row.get::<_, String>(2)?,
                    "toColumn": row.get::<_, Option<String>>(4)?,
                    "onUpdate": row.get::<_, String>(5)?,
                    "onDelete": row.get::<_, String>(6)?,
                }))
            })
            .map_err(|e| format!("Cannot read {table}: {e}"))?;
        for row in rows {
            foreign_keys.push(row.map_err(|e| format!("Cannot read {table}: {e}"))?);
        }
    }

    let mut indexes = Vec::new();
    {
        let mut statement = connection
            .prepare(&format!("PRAGMA index_list({quoted})"))
            .map_err(|e| format!("Cannot read {table}: {e}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "name": row.get::<_, String>(1)?,
                    "unique": row.get::<_, i64>(2)? != 0,
                }))
            })
            .map_err(|e| format!("Cannot read {table}: {e}"))?;
        for row in rows {
            indexes.push(row.map_err(|e| format!("Cannot read {table}: {e}"))?);
        }
    }

    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = ?1",
            [table],
            |row| row.get(0),
        )
        .ok();

    Ok(serde_json::json!({
        "name": table,
        "columns": columns,
        "foreignKeys": foreign_keys,
        "indexes": indexes,
        "sql": sql,
    }))
}

/// One page of a table.
pub fn select_page(
    connection: &Connection,
    table: &str,
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
    descending: bool,
    filter_column: Option<&str>,
    filter_value: Option<&str>,
) -> Result<serde_json::Value, String> {
    check_ident(table)?;
    let quoted = quote_ident(table);

    let mut where_clause = String::new();
    let mut params: Vec<Value> = Vec::new();

    if let (Some(column), Some(value)) = (filter_column, filter_value) {
        check_ident(column)?;
        // The column name is quoted; the value is bound.
        where_clause = format!(" WHERE CAST({} AS TEXT) LIKE ?1", quote_ident(column));
        params.push(Value::Text(format!("%{value}%")));
    }

    let order = match order_by {
        Some(column) => {
            check_ident(column)?;
            format!(
                " ORDER BY {} {}",
                quote_ident(column),
                if descending { "DESC" } else { "ASC" }
            )
        }
        None => String::new(),
    };

    let total: i64 = {
        let sql = format!("SELECT COUNT(*) FROM {quoted}{where_clause}");
        let mut statement = connection
            .prepare(&sql)
            .map_err(|e| format!("Cannot count {table}: {e}"))?;
        statement
            .query_row(rusqlite::params_from_iter(params.iter()), |row| row.get(0))
            .map_err(|e| format!("Cannot count {table}: {e}"))?
    };

    let sql = format!("SELECT rowid, * FROM {quoted}{where_clause}{order} LIMIT ?{} OFFSET ?{}",
        params.len() + 1, params.len() + 2);

    let mut statement = connection
        .prepare(&sql)
        .map_err(|e| format!("Cannot read {table}: {e}"))?;

    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect();

    let mut all = params.clone();
    all.push(Value::Integer(limit));
    all.push(Value::Integer(offset));

    let rows = statement
        .query_map(rusqlite::params_from_iter(all.iter()), |row| {
            let mut values = Vec::new();
            for i in 0..names.len() {
                values.push(json_of(row.get_ref(i)?));
            }
            Ok(serde_json::Value::Array(values))
        })
        .map_err(|e| format!("Cannot read {table}: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("Cannot read {table}: {e}"))?);
    }

    Ok(serde_json::json!({
        "columns": names,
        "rows": out,
        "total": total,
        "offset": offset,
        "limit": limit,
    }))
}

/// A SQLite value as JSON.
fn json_of(value: ValueRef<'_>) -> serde_json::Value {
    match value {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(n) => serde_json::json!(n),
        ValueRef::Real(n) => serde_json::json!(n),
        ValueRef::Text(bytes) => {
            serde_json::Value::String(String::from_utf8_lossy(bytes).to_string())
        }
        // Sending a megabyte of image through the interface to draw one cell
        // would be the pagination mistake in a different costume.
        ValueRef::Blob(bytes) => serde_json::json!(format!("«{} bytes»", bytes.len())),
    }
}

/// Turns a JSON value from the interface into something SQLite can bind.
pub fn value_of(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else {
                Value::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

// Writing.

/// Inserts a row. Column names are quoted, every value is bound.
pub fn insert_row(
    connection: &Connection,
    table: &str,
    values: &HashMap<String, serde_json::Value>,
) -> Result<i64, String> {
    check_ident(table)?;
    if values.is_empty() {
        return Err("Nothing to insert".to_string());
    }

    let mut names: Vec<&String> = values.keys().collect();
    names.sort();
    for name in &names {
        check_ident(name)?;
    }

    let columns: Vec<String> = names.iter().map(|n| quote_ident(n)).collect();
    let holes: Vec<String> = (1..=names.len()).map(|i| format!("?{i}")).collect();
    let bound: Vec<Value> = names.iter().map(|n| value_of(&values[*n])).collect();

    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quote_ident(table),
        columns.join(", "),
        holes.join(", ")
    );

    connection
        .execute(&sql, rusqlite::params_from_iter(bound.iter()))
        .map_err(|e| format!("Cannot insert into {table}: {e}"))?;

    Ok(connection.last_insert_rowid())
}

/// Updates one row, found by rowid.
pub fn update_row(
    connection: &Connection,
    table: &str,
    rowid: i64,
    values: &HashMap<String, serde_json::Value>,
) -> Result<usize, String> {
    check_ident(table)?;
    if values.is_empty() {
        return Ok(0);
    }

    let mut names: Vec<&String> = values.keys().collect();
    names.sort();
    for name in &names {
        check_ident(name)?;
    }

    let sets: Vec<String> = names
        .iter()
        .enumerate()
        .map(|(i, name)| format!("{} = ?{}", quote_ident(name), i + 1))
        .collect();

    let mut bound: Vec<Value> = names.iter().map(|n| value_of(&values[*n])).collect();
    bound.push(Value::Integer(rowid));

    let sql = format!(
        "UPDATE {} SET {} WHERE rowid = ?{}",
        quote_ident(table),
        sets.join(", "),
        bound.len()
    );

    connection
        .execute(&sql, rusqlite::params_from_iter(bound.iter()))
        .map_err(|e| format!("Cannot update {table}: {e}"))
}

pub fn delete_row(connection: &Connection, table: &str, rowid: i64) -> Result<usize, String> {
    check_ident(table)?;
    connection
        .execute(
            &format!("DELETE FROM {} WHERE rowid = ?1", quote_ident(table)),
            [rowid],
        )
        .map_err(|e| format!("Cannot delete from {table}: {e}"))
}

// Running what the user wrote.

/// Whether a statement changes anything.
pub fn is_write(sql: &str) -> bool {
    let head = sql
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_uppercase();
    !matches!(head.as_str(), "SELECT" | "WITH" | "EXPLAIN" | "PRAGMA")
}

/// Whether a statement would change every row, which deserves a warning.
pub fn is_unbounded_write(sql: &str) -> bool {
    let text = sql.trim().to_uppercase();
    let unbounded = (text.starts_with("DELETE") || text.starts_with("UPDATE"))
        && !text.contains(" WHERE ");
    unbounded || text.starts_with("DROP ") || text.starts_with("TRUNCATE")
}

/// Runs a statement and returns either rows or a count.
pub fn run(
    connection: &Connection,
    sql: &str,
    params: &[serde_json::Value],
) -> Result<serde_json::Value, String> {
    let bound: Vec<Value> = params.iter().map(value_of).collect();

    if is_write(sql) {
        let changed = connection
            .execute(sql, rusqlite::params_from_iter(bound.iter()))
            .map_err(|e| format!("{e}"))?;
        return Ok(serde_json::json!({ "changed": changed, "columns": [], "rows": [] }));
    }

    let mut statement = connection.prepare(sql).map_err(|e| format!("{e}"))?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect();

    let rows = statement
        .query_map(rusqlite::params_from_iter(bound.iter()), |row| {
            let mut values = Vec::new();
            for i in 0..names.len() {
                values.push(json_of(row.get_ref(i)?));
            }
            Ok(serde_json::Value::Array(values))
        })
        .map_err(|e| format!("{e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("{e}"))?);
    }

    Ok(serde_json::json!({ "columns": names, "rows": out, "changed": 0 }))
}

// Undo.

/* the other modules undo against a model held in memory. */

pub fn begin_step(database: &mut Database) -> Result<(), String> {
    database.refuse_if_read_only()?;
    let name = format!("step{}", database.depth);
    database
        .connection
        .execute_batch(&format!("SAVEPOINT {name};"))
        .map_err(|e| format!("Cannot start a change: {e}"))?;
    database.depth += 1;
    Ok(())
}

pub fn commit_step(database: &mut Database) -> Result<(), String> {
    if database.depth == 0 {
        return Ok(());
    }
    let name = format!("step{}", database.depth - 1);
    database
        .connection
        .execute_batch(&format!("RELEASE {name};"))
        .map_err(|e| format!("Cannot finish a change: {e}"))?;
    database.depth -= 1;
    Ok(())
}

/// Undoes the last change by rolling back to its savepoint.
pub fn undo_step(database: &mut Database) -> Result<bool, String> {
    database.refuse_if_read_only()?;
    if database.depth == 0 {
        return Ok(false);
    }
    let name = format!("step{}", database.depth - 1);
    database
        .connection
        .execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name};"))
        .map_err(|e| format!("Cannot undo: {e}"))?;
    database.depth -= 1;
    Ok(true)
}

// Preparing to share.

/// 's "prepare for sharing".
/// allows.
pub fn vacuum(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch("VACUUM;")
        .map_err(|e| format!("Cannot compact the database: {e}"))
}

/// Removes the journal files SQLite may have left beside the database.
pub fn remove_side_files(path: &Path) -> Vec<String> {
    let mut removed = Vec::new();
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut beside = path.as_os_str().to_os_string();
        beside.push(suffix);
        let beside = PathBuf::from(beside);
        if beside.exists() && std::fs::remove_file(&beside).is_ok() {
            removed.push(beside.to_string_lossy().to_string());
        }
    }
    removed
}
