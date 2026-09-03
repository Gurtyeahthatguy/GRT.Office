//! Rust backend for GRT Tables.

pub mod db;
pub mod export;

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};

use db::Database;

#[derive(Default)]
struct Open(Mutex<Option<Database>>);

fn is_ephemeral() -> bool {
    std::env::args().any(|arg| arg == "--ephemeral")
}

/// Runs an action against the open database.
fn with_db<T>(
    state: &State<'_, Open>,
    action: impl FnOnce(&mut Database) -> Result<T, String>,
) -> Result<T, String> {
    let mut held = state
        .0
        .lock()
        .map_err(|_| "The database is unavailable".to_string())?;
    let database = held
        .as_mut()
        .ok_or_else(|| "No database is open".to_string())?;
    action(database)
}

// Opening and creating.

fn describe(database: &Database) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "path": database.path.as_ref().map(|p| p.to_string_lossy().to_string()),
        "readOnly": database.read_only,
        "tables": db::list_tables(&database.connection)?,
        "inMemory": database.path.is_none(),
    }))
}

/// A new database.
#[tauri::command]
fn create_database(
    state: State<'_, Open>,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    let target = if is_ephemeral() { None } else { path };
    let database = Database::create(target.as_deref().map(Path::new))?;
    let described = describe(&database)?;

    *state
        .0
        .lock()
        .map_err(|_| "The database is unavailable".to_string())? = Some(database);

    Ok(described)
}

/// Opens an existing database.
#[tauri::command]
fn open_database(state: State<'_, Open>, path: String) -> Result<serde_json::Value, String> {
    let database = Database::open(Path::new(&path))?;
    let described = describe(&database)?;

    *state
        .0
        .lock()
        .map_err(|_| "The database is unavailable".to_string())? = Some(database);

    Ok(described)
}

/// Lets the user write to a database that was opened rather than created.
#[tauri::command]
fn unlock_database(state: State<'_, Open>) -> Result<bool, String> {
    with_db(&state, |database| {
        database.read_only = false;
        Ok(true)
    })
}

/// Closes the database, removing the journal files SQLite leaves beside it.
#[tauri::command]
fn close_database(state: State<'_, Open>) -> Result<serde_json::Value, String> {
    let mut held = state
        .0
        .lock()
        .map_err(|_| "The database is unavailable".to_string())?;

    let Some(database) = held.take() else {
        return Ok(serde_json::json!({ "removed": [] }));
    };

    let path = database.path.clone();
    drop(database);

    let removed = match path {
        Some(path) => db::remove_side_files(&path),
        None => Vec::new(),
    };

    Ok(serde_json::json!({ "removed": removed }))
}

#[tauri::command]
fn database_info(state: State<'_, Open>) -> Result<serde_json::Value, String> {
    with_db(&state, |database| describe(database))
}

// Reading.

#[tauri::command]
fn table_schema(state: State<'_, Open>, table: String) -> Result<serde_json::Value, String> {
    with_db(&state, |database| {
        db::describe_table(&database.connection, &table)
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn table_page(
    state: State<'_, Open>,
    table: String,
    limit: Option<i64>,
    offset: Option<i64>,
    order_by: Option<String>,
    descending: Option<bool>,
    filter_column: Option<String>,
    filter_value: Option<String>,
) -> Result<serde_json::Value, String> {
    with_db(&state, |database| {
        db::select_page(
            &database.connection,
            &table,
            limit.unwrap_or(100).clamp(1, 1000),
            offset.unwrap_or(0).max(0),
            order_by.as_deref(),
            descending.unwrap_or(false),
            filter_column.as_deref(),
            filter_value.as_deref(),
        )
    })
}

// Writing.

#[tauri::command]
fn insert_row(
    state: State<'_, Open>,
    table: String,
    values: HashMap<String, serde_json::Value>,
) -> Result<i64, String> {
    with_db(&state, |database| {
        database.refuse_if_read_only()?;
        db::begin_step(database)?;
        let result = db::insert_row(&database.connection, &table, &values);
        finish(database, result)
    })
}

#[tauri::command]
fn update_row(
    state: State<'_, Open>,
    table: String,
    rowid: i64,
    values: HashMap<String, serde_json::Value>,
) -> Result<usize, String> {
    with_db(&state, |database| {
        database.refuse_if_read_only()?;
        db::begin_step(database)?;
        let result = db::update_row(&database.connection, &table, rowid, &values);
        finish(database, result)
    })
}

#[tauri::command]
fn delete_row(state: State<'_, Open>, table: String, rowid: i64) -> Result<usize, String> {
    with_db(&state, |database| {
        database.refuse_if_read_only()?;
        db::begin_step(database)?;
        let result = db::delete_row(&database.connection, &table, rowid);
        finish(database, result)
    })
}

/// Keeps a change if it worked, throws it away if it did not.
fn finish<T>(database: &mut Database, result: Result<T, String>) -> Result<T, String> {
    match result {
        Ok(value) => {
            db::commit_step(database)?;
            Ok(value)
        }
        Err(problem) => {
            let _ = db::undo_step(database);
            Err(problem)
        }
    }
}

// Schema.

/// Runs a schema statement written by the designer.
#[tauri::command]
fn run_schema(state: State<'_, Open>, sql: String) -> Result<serde_json::Value, String> {
    with_db(&state, |database| {
        database.refuse_if_read_only()?;
        db::begin_step(database)?;
        let result = database
            .connection
            .execute_batch(&sql)
            .map_err(|e| format!("{e}"));
        finish(database, result)?;
        Ok(serde_json::json!({ "ok": true }))
    })
}

// Queries.

/// What a statement is, before it is run.
#[tauri::command]
fn inspect_sql(sql: String) -> serde_json::Value {
    serde_json::json!({
        "writes": db::is_write(&sql),
        "unbounded": db::is_unbounded_write(&sql),
    })
}

#[tauri::command]
fn run_query(
    state: State<'_, Open>,
    sql: String,
    params: Option<Vec<serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    with_db(&state, |database| {
        let bound = params.unwrap_or_default();

        if !db::is_write(&sql) {
            return db::run(&database.connection, &sql, &bound);
        }

        database.refuse_if_read_only()?;
        db::begin_step(database)?;
        let result = db::run(&database.connection, &sql, &bound);
        finish(database, result)
    })
}

// Undo.

#[tauri::command]
fn undo(state: State<'_, Open>) -> Result<bool, String> {
    with_db(&state, db::undo_step)
}

#[tauri::command]
fn undo_depth(state: State<'_, Open>) -> Result<usize, String> {
    with_db(&state, |database| Ok(database.depth))
}

// Sharing.

/// 's "prepare for sharing": compact the file and remove what is beside it.
#[tauri::command]
fn prepare_for_sharing(state: State<'_, Open>) -> Result<serde_json::Value, String> {
    with_db(&state, |database| {
        database.refuse_if_read_only()?;

        // VACUUM cannot run inside a transaction, so any open step is closed
        // first.
        while database.depth > 0 {
            db::commit_step(database)?;
        }

        db::vacuum(&database.connection)?;

        let removed = match &database.path {
            Some(path) => db::remove_side_files(path),
            None => Vec::new(),
        };

        Ok(serde_json::json!({ "removed": removed }))
    })
}

// The readable archive.

#[tauri::command]
fn export_grt(state: State<'_, Open>, path: String) -> Result<(), String> {
    let parts = with_db(&state, |database| export::parts_of(&database.connection))?;

    let mut entries = vec![grt_container::Entry::new(
        grt_container::README_NAME,
        grt_container::README_TEXT.as_bytes().to_vec(),
    )];

    for (name, text) in parts {
        entries.push(grt_container::Entry::new(name, text.into_bytes()));
    }

    let bytes = grt_container::write_archive(entries)
        .map_err(|e| format!("Cannot build the archive: {e}"))?;

    atomic_write(Path::new(&path), &bytes)
}

#[tauri::command]
fn import_grt(
    state: State<'_, Open>,
    archive: String,
    into: Option<String>,
) -> Result<serde_json::Value, String> {
    let bytes = fs::read(&archive).map_err(|e| format!("Cannot read {archive}: {e}"))?;
    let parts = grt_container::read_archive(&bytes)
        .map_err(|e| format!("{archive} is not a readable GRT archive: {e}"))?;

    let text_of = |wanted: &str| -> Option<String> {
        parts
            .iter()
            .find(|entry| entry.name == wanted)
            .and_then(|entry| String::from_utf8(entry.data.clone()).ok())
    };

    let schema = text_of(export::SCHEMA)
        .ok_or_else(|| "That archive has no schema in it".to_string())?;
    let data = text_of(export::DATA).unwrap_or_default();

    let target = if is_ephemeral() { None } else { into };
    let database = Database::create(target.as_deref().map(Path::new))?;
    export::restore(&database.connection, &schema, &data)?;

    let described = describe(&database)?;
    *state
        .0
        .lock()
        .map_err(|_| "The database is unavailable".to_string())? = Some(database);

    Ok(described)
}

// Files.

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
fn write_file_atomic(request: Request<'_>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-grt-path")
        .ok_or_else(|| "Missing destination path".to_string())?
        .to_str()
        .map_err(|e| format!("Malformed destination path: {e}"))?;

    let decoded = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|e| format!("Destination path is not valid UTF-8: {e}"))?
        .to_string();

    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("Expected a raw byte payload, got JSON".to_string()),
    };

    atomic_write(Path::new(&decoded), bytes)
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

// Settings and startup.

#[tauri::command]
fn runtime_info() -> serde_json::Value {
    serde_json::json!({
        "ephemeral": is_ephemeral(),
        "version": env!("CARGO_PKG_VERSION"),
        "initialFile": initial_file(),
    })
}

fn initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && Path::new(arg).is_file())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No configuration directory available: {e}"))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn read_settings(app: AppHandle) -> serde_json::Value {
    if is_ephemeral() {
        return serde_json::json!({});
    }
    settings_path(&app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
fn write_settings(app: AppHandle, settings: serde_json::Value) -> Result<bool, String> {
    if is_ephemeral() {
        return Ok(false);
    }
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Cannot serialise settings: {e}"))?;
    atomic_write(&path, text.as_bytes())?;
    Ok(true)
}

#[tauri::command]
fn forget_settings(app: AppHandle) -> Result<(), String> {
    let path = settings_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot remove {}: {e}", path.display())),
    }
}

// Atomic writing.

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_path_beside(target: &Path) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = format!(".grt-write-{}-{}", std::process::id(), n);
    match target.parent() {
        Some(dir) => dir.join(name),
        None => PathBuf::from(name),
    }
}

fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = temp_path_beside(target);

    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(format!("Cannot write {}: {e}", target.display()));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(target) {
            let mode = meta.permissions().mode();
            let _ = fs::set_permissions(&temp, fs::Permissions::from_mode(mode));
        }
    }

    if let Err(e) = fs::rename(&temp, target) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Cannot replace {}: {e}", target.display()));
    }

    #[cfg(unix)]
    if let Some(dir) = target.parent() {
        if let Ok(handle) = fs::File::open(dir) {
            let _ = handle.sync_all();
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Open::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            create_database,
            open_database,
            unlock_database,
            close_database,
            database_info,
            table_schema,
            table_page,
            insert_row,
            update_row,
            delete_row,
            run_schema,
            inspect_sql,
            run_query,
            undo,
            undo_depth,
            prepare_for_sharing,
            export_grt,
            import_grt,
            read_file,
            write_file_atomic,
            file_exists,
            runtime_info,
            read_settings,
            write_settings,
            forget_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
