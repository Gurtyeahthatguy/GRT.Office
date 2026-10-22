//! Undo: every change is written at once and recorded to be played backwards.

use std::collections::{BTreeMap, HashSet};
use std::os::raw::{c_int, c_void};
use std::ptr;

use rusqlite::{ffi, Connection};

use crate::db::{quote_ident, Database};

/// How many changes can be taken back.
const LIMIT: usize = 100;

/// The column a table copy keeps each row's rowid in.
const ROWID: &str = "__grt_rowid";

/// One change, and what takes it back.
pub struct Step {
    /// The rows it changed, as a changeset that puts them back.
    inverse: Vec<u8>,
    /// The schema as it was, for a change that could alter it.
    schema: Option<Schema>,
}

/// Every object in the schema, keyed by type and name, with its table and SQL.
type Objects = BTreeMap<(String, String), (String, Option<String>)>;

struct Schema {
    objects: Objects,
    /// Tables the change could drop or alter, copied whole beforehand.
    copies: Vec<Copy>,
}

struct Copy {
    table: String,
    copy: String,
    columns: Vec<String>,
    rowid: bool,
}

/// Records what a change does to the rows of every table, through SQLite's session extension.
struct Recorder(*mut ffi::sqlite3_session);

impl Recorder {
    fn start(connection: &Connection) -> Result<Self, String> {
        let mut session = ptr::null_mut();
        // SAFETY: the handle belongs to the connection, which outlives the recorder.
        let code = unsafe { ffi::sqlite3session_create(connection.handle(), c"main".as_ptr(), &mut session) };
        if code != ffi::SQLITE_OK {
            return Err(format!("Cannot record the change (SQLite error {code})"));
        }
        let recorder = Recorder(session);
        // Tables without a primary key are followed by rowid.
        let mut on: c_int = 1;
        let code = unsafe {
            ffi::sqlite3session_object_config(session, ffi::SQLITE_SESSION_OBJCONFIG_ROWID, ptr::addr_of_mut!(on).cast::<c_void>())
        };
        if code != ffi::SQLITE_OK {
            return Err(format!("Cannot record the change (SQLite error {code})"));
        }
        let code = unsafe { ffi::sqlite3session_attach(session, ptr::null()) };
        if code != ffi::SQLITE_OK {
            return Err(format!("Cannot record the change (SQLite error {code})"));
        }
        Ok(recorder)
    }

    /// The recorded changes, turned round.
    fn inverse(self) -> Result<Vec<u8>, String> {
        let mut size: c_int = 0;
        let mut changes: *mut c_void = ptr::null_mut();
        let code = unsafe { ffi::sqlite3session_changeset(self.0, &mut size, &mut changes) };
        let result = if code != ffi::SQLITE_OK {
            Err(format!("Cannot record the change (SQLite error {code})"))
        } else if size == 0 {
            Ok(Vec::new())
        } else {
            let mut turned_size: c_int = 0;
            let mut turned: *mut c_void = ptr::null_mut();
            let code = unsafe { ffi::sqlite3changeset_invert(size, changes, &mut turned_size, &mut turned) };
            let out = if code == ffi::SQLITE_OK {
                // SAFETY: SQLite returned a buffer of exactly this size.
                Ok(unsafe { std::slice::from_raw_parts(turned.cast::<u8>(), turned_size as usize) }.to_vec())
            } else {
                Err(format!("Cannot record the change (SQLite error {code})"))
            };
            unsafe { ffi::sqlite3_free(turned) };
            out
        };
        unsafe { ffi::sqlite3_free(changes) };
        result
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        // SAFETY: created by sqlite3session_create and deleted once, here.
        unsafe { ffi::sqlite3session_delete(self.0) };
    }
}

/// A row that is not as expected is left as it is.
unsafe extern "C" fn leave_it(_: *mut c_void, _: c_int, _: *mut ffi::sqlite3_changeset_iter) -> c_int {
    ffi::SQLITE_CHANGESET_OMIT
}

fn apply(connection: &Connection, inverse: &mut [u8]) -> Result<(), String> {
    if inverse.is_empty() {
        return Ok(());
    }
    let size = c_int::try_from(inverse.len()).map_err(|_| "That change is too large to undo".to_string())?;
    let code = unsafe {
        ffi::sqlite3changeset_apply(connection.handle(), size, inverse.as_mut_ptr().cast::<c_void>(), None, Some(leave_it), ptr::null_mut())
    };
    if code == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(format!("Cannot undo (SQLite error {code})"))
    }
}

fn objects(connection: &Connection) -> Result<Objects, String> {
    let mut statement = connection
        .prepare("SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
        .map_err(|e| format!("{e}"))?;
    let rows = statement
        .query_map([], |row| Ok(((row.get::<_, String>(0)?, row.get::<_, String>(1)?), (row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?))))
        .map_err(|e| format!("{e}"))?;
    rows.collect::<Result<Objects, _>>().map_err(|e| format!("{e}"))
}

/// The words of a statement, with strings and comments left out and quoted names unquoted.
fn words(sql: &str) -> Vec<String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else if c == '\'' {
            i += 1;
            while i < chars.len() {
                if chars[i] == '\'' && chars.get(i + 1) == Some(&'\'') {
                    i += 2;
                } else if chars[i] == '\'' {
                    break;
                } else {
                    i += 1;
                }
            }
            i += 1;
            out.push("'".to_string());
        } else if c == '"' || c == '`' || c == '[' {
            let close = if c == '[' { ']' } else { c };
            let mut word = String::new();
            i += 1;
            while i < chars.len() {
                if chars[i] == close && close != ']' && chars.get(i + 1) == Some(&close) {
                    word.push(close);
                    i += 2;
                } else if chars[i] == close {
                    break;
                } else {
                    word.push(chars[i]);
                    i += 1;
                }
            }
            i += 1;
            out.push(word);
        } else if c.is_alphanumeric() || c == '_' {
            let mut word = String::new();
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                word.push(chars[i]);
                i += 1;
            }
            out.push(word);
        } else {
            if !c.is_whitespace() {
                out.push(c.to_string());
            }
            i += 1;
        }
    }
    out
}

/// The tables a statement names after DROP TABLE or ALTER TABLE, in lower case.
pub fn dropped_or_altered(sql: &str) -> HashSet<String> {
    let words = words(sql);
    let is = |at: usize, wanted: &str| words.get(at).is_some_and(|w| w.eq_ignore_ascii_case(wanted));
    let mut found = HashSet::new();
    for at in 0..words.len() {
        if !((is(at, "drop") || is(at, "alter")) && is(at + 1, "table")) {
            continue;
        }
        let mut name = at + 2;
        if is(at, "drop") && is(name, "if") && is(name + 1, "exists") {
            name += 2;
        }
        // A schema name comes first when there is a dot after it.
        if words.get(name + 1).is_some_and(|w| w == ".") {
            name += 2;
        }
        if let Some(table) = words.get(name) {
            found.insert(table.to_lowercase());
        }
    }
    found
}

fn copy_table(database: &mut Database, table: &str, sql: &str) -> Result<Copy, String> {
    let copy = format!("grt_undo_{}", database.copies);
    database.copies += 1;
    let connection = &database.connection;

    let mut statement = connection
        .prepare(&format!("SELECT name, hidden FROM main.pragma_table_xinfo({})", quote_literal(table)))
        .map_err(|e| format!("{e}"))?;
    let columns: Vec<String> = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| format!("{e}"))?
        .filter_map(Result::ok)
        .filter(|(_, hidden)| *hidden == 0)
        .map(|(name, _)| name)
        .collect();
    let rowid = !sql.to_uppercase().contains("WITHOUT ROWID");

    let list = columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
    let select = if rowid {
        format!("SELECT rowid AS {ROWID}, {list} FROM main.{}", quote_ident(table))
    } else {
        format!("SELECT {list} FROM main.{}", quote_ident(table))
    };
    connection
        .execute_batch(&format!("CREATE TEMP TABLE {copy} AS {select};"))
        .map_err(|e| format!("Cannot keep a copy for undo: {e}"))?;

    Ok(Copy { table: table.to_string(), copy, columns, rowid })
}

fn quote_literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Notes the schema, and copies what the statement could drop or alter.
fn snapshot(database: &mut Database, sql: &str) -> Result<Schema, String> {
    let objects = objects(&database.connection)?;
    let wanted = dropped_or_altered(sql);
    let tables: Vec<(String, String)> = objects
        .iter()
        .filter(|((kind, name), _)| kind == "table" && wanted.contains(&name.to_lowercase()))
        .map(|((_, name), (_, sql))| (name.clone(), sql.clone().unwrap_or_default()))
        .collect();
    let mut copies = Vec::new();
    for (table, sql) in tables {
        match copy_table(database, &table, &sql) {
            Ok(copy) => copies.push(copy),
            Err(problem) => {
                forget_copies(&database.connection, &copies);
                return Err(problem);
            }
        }
    }
    Ok(Schema { objects, copies })
}

fn forget_copies(connection: &Connection, copies: &[Copy]) {
    for copy in copies {
        let _ = connection.execute_batch(&format!("DROP TABLE IF EXISTS temp.{};", copy.copy));
    }
}

fn forget(connection: &Connection, step: &Step) {
    if let Some(schema) = &step.schema {
        forget_copies(connection, &schema.copies);
    }
}

/// Runs a change as one step that can be undone. `sql` is given when the change may alter the schema.
pub fn step<T>(
    database: &mut Database,
    sql: Option<&str>,
    change: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    database.refuse_if_read_only()?;
    let schema = match sql {
        Some(sql) => Some(snapshot(database, sql)?),
        None => None,
    };

    let connection = &database.connection;
    if let Err(e) = connection.execute_batch("SAVEPOINT grt_step;") {
        if let Some(schema) = &schema {
            forget_copies(connection, &schema.copies);
        }
        return Err(format!("Cannot start a change: {e}"));
    }

    let outcome = Recorder::start(connection).and_then(|recorder| {
        let value = change(connection)?;
        Ok((value, recorder.inverse()?))
    });

    match outcome {
        Ok((value, inverse)) => {
            connection
                .execute_batch("RELEASE grt_step;")
                .map_err(|e| format!("Cannot finish a change: {e}"))?;
            database.undo.push(Step { inverse, schema });
            if database.undo.len() > LIMIT {
                let oldest = database.undo.remove(0);
                forget(&database.connection, &oldest);
            }
            Ok(value)
        }
        Err(problem) => {
            let _ = connection.execute_batch("ROLLBACK TO grt_step; RELEASE grt_step;");
            if let Some(schema) = &schema {
                forget_copies(connection, &schema.copies);
            }
            Err(problem)
        }
    }
}

/// Puts the schema back as it was, and the copied tables with their rows.
fn restore(connection: &Connection, schema: &Schema) -> Result<(), String> {
    let run = |sql: String| connection.execute_batch(&sql).map_err(|e| format!("Cannot undo: {e}"));
    let copied: HashSet<String> = schema.copies.iter().map(|c| c.table.to_lowercase()).collect();

    // What the change added or rewrote goes, triggers and views before the tables they read.
    let now = objects(connection)?;
    for kind in ["trigger", "view", "index", "table"] {
        for ((t, name), (_, sql)) in &now {
            if t != kind || (kind == "table" && copied.contains(&name.to_lowercase())) {
                continue;
            }
            let unchanged = schema.objects.get(&(t.clone(), name.clone())).is_some_and(|(_, before)| before == sql);
            if !unchanged {
                run(format!("DROP {} IF EXISTS main.{};", kind.to_uppercase(), quote_ident(name)))?;
            }
        }
    }

    for copy in &schema.copies {
        let Some((_, Some(create))) = schema.objects.get(&("table".to_string(), copy.table.clone())) else {
            continue;
        };
        run(format!("DROP TABLE IF EXISTS main.{};", quote_ident(&copy.table)))?;
        run(format!("{create};"))?;
        let list = copy.columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
        if copy.rowid {
            run(format!(
                "INSERT INTO main.{} (rowid, {list}) SELECT {ROWID}, {list} FROM temp.{};",
                quote_ident(&copy.table),
                copy.copy
            ))?;
        } else {
            run(format!("INSERT INTO main.{} ({list}) SELECT {list} FROM temp.{};", quote_ident(&copy.table), copy.copy))?;
        }
    }

    // What the change removed comes back, tables before what is built on them.
    let now = objects(connection)?;
    for kind in ["table", "index", "view", "trigger"] {
        for ((t, name), (_, sql)) in &schema.objects {
            if t != kind || now.contains_key(&(t.clone(), name.clone())) {
                continue;
            }
            if let Some(sql) = sql {
                run(format!("{sql};"))?;
            }
        }
    }
    Ok(())
}

/// Takes back the last change. False when there is nothing to take back.
pub fn undo(database: &mut Database) -> Result<bool, String> {
    database.refuse_if_read_only()?;
    let Some(mut last) = database.undo.pop() else {
        return Ok(false);
    };
    let connection = &database.connection;

    // Rebuilding a table must not cascade into the tables that refer to it.
    let keys: i64 = connection
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .map_err(|e| format!("{e}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys = OFF; BEGIN;")
        .map_err(|e| format!("Cannot undo: {e}"))?;

    let result = apply(connection, &mut last.inverse).and_then(|()| match &last.schema {
        Some(schema) => restore(connection, schema),
        None => Ok(()),
    });

    let finished = match &result {
        Ok(()) => connection.execute_batch("COMMIT;"),
        Err(_) => connection.execute_batch("ROLLBACK;"),
    };
    let _ = connection.execute_batch(&format!("PRAGMA foreign_keys = {keys};"));

    match result.and_then(|()| finished.map_err(|e| format!("Cannot undo: {e}"))) {
        Ok(()) => {
            forget(connection, &last);
            Ok(true)
        }
        Err(problem) => {
            database.undo.push(last);
            Err(problem)
        }
    }
}

/// Forgets every change, as compacting the file renumbers rows.
pub fn clear(database: &mut Database) {
    for step in std::mem::take(&mut database.undo) {
        forget(&database.connection, &step);
    }
}
