//! Rust backend for GRT Notes.

mod index;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State};

use index::Index;

/// Whether the program was started with `--ephemeral`.
fn is_ephemeral() -> bool {
    std::env::args().any(|arg| arg == "--ephemeral")
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

    let target = Path::new(&decoded);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    atomic_write(target, bytes)
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

// The archive.

/// Where notebooks live by default.
fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("No usable directory for the archive: {e}"))?;
    Ok(base.join("GRT Notes"))
}

fn modified_seconds(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn page_entry(path: &Path) -> Option<serde_json::Value> {
    if path.extension().and_then(|e| e.to_str()) != Some("grt") {
        return None;
    }
    let stem = path.file_stem()?.to_str()?.to_string();
    Some(serde_json::json!({
        "path": path.to_string_lossy(),
        "file": stem,
        "modified": modified_seconds(path),
    }))
}

/// Reads the archive: notebooks, their sections, and the notes in each.
#[tauri::command]
fn read_archive(app: AppHandle, root: Option<String>) -> Result<serde_json::Value, String> {
    let root = match root {
        Some(path) => PathBuf::from(path),
        None => default_root(&app)?,
    };

    let mut notebooks = Vec::new();

    if root.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(&root)
            .map_err(|e| format!("Cannot read {}: {e}", root.display()))?
            .flatten()
            .map(|entry| entry.path())
            .collect();
        entries.sort();

        for notebook in entries {
            let name = match notebook.file_name().and_then(|n| n.to_str()) {
                Some(name) if !name.starts_with('.') => name.to_string(),
                _ => continue,
            };
            if !notebook.is_dir() {
                continue;
            }

            let mut sections = Vec::new();
            let mut pages = Vec::new();

            let mut inner: Vec<PathBuf> = fs::read_dir(&notebook)
                .map_err(|e| format!("Cannot read {}: {e}", notebook.display()))?
                .flatten()
                .map(|entry| entry.path())
                .collect();
            inner.sort();

            for child in inner {
                let child_name = match child.file_name().and_then(|n| n.to_str()) {
                    Some(name) if !name.starts_with('.') => name.to_string(),
                    _ => continue,
                };

                if child.is_dir() {
                    let mut section_pages = Vec::new();
                    let mut leaves: Vec<PathBuf> = fs::read_dir(&child)
                        .map_err(|e| format!("Cannot read {}: {e}", child.display()))?
                        .flatten()
                        .map(|entry| entry.path())
                        .collect();
                    leaves.sort();

                    for leaf in leaves {
                        if let Some(entry) = page_entry(&leaf) {
                            section_pages.push(entry);
                        }
                    }

                    sections.push(serde_json::json!({
                        "name": child_name,
                        "path": child.to_string_lossy(),
                        "pages": section_pages,
                    }));
                } else if let Some(entry) = page_entry(&child) {
                    pages.push(entry);
                }
            }

            notebooks.push(serde_json::json!({
                "name": name,
                "path": notebook.to_string_lossy(),
                "sections": sections,
                "pages": pages,
            }));
        }
    }

    Ok(serde_json::json!({
        "root": root.to_string_lossy(),
        "notebooks": notebooks,
    }))
}

#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("Cannot create {path}: {e}"))
}

/// Renames or moves a note or a folder.
#[tauri::command]
fn rename_entry(from: String, to: String) -> Result<(), String> {
    let target = Path::new(&to);
    if target.exists() {
        return Err(format!("{to} already exists"));
    }
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    fs::rename(&from, &to).map_err(|e| format!("Cannot move {from}: {e}"))
}

/// Deletes a note, or an empty folder.
#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    let target = Path::new(&path);

    if target.is_dir() {
        let empty = fs::read_dir(target)
            .map_err(|e| format!("Cannot read {path}: {e}"))?
            .flatten()
            .all(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|n| n.starts_with('.'))
                    .unwrap_or(false)
            });
        if !empty {
            return Err("That folder still has notes in it".to_string());
        }
        return fs::remove_dir_all(target).map_err(|e| format!("Cannot remove {path}: {e}"));
    }

    if target.extension().and_then(|e| e.to_str()) != Some("grt") {
        return Err("Only notes and folders can be removed".to_string());
    }

    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot remove {path}: {e}")),
    }
}

// Documents.

#[tauri::command]
fn read_grt(path: String) -> Result<serde_json::Value, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    let entries = grt_container::read_archive(&bytes)
        .map_err(|e| format!("{path} is not a readable GRT document: {e}"))?;

    let mut parts = serde_json::Map::new();
    let mut resources = Vec::new();

    for entry in entries {
        match std::str::from_utf8(&entry.data) {
            Ok(text) if !entry.name.starts_with("resources/") => {
                parts.insert(entry.name, serde_json::Value::String(text.to_string()));
            }
            _ => resources.push(serde_json::Value::String(entry.name)),
        }
    }

    Ok(serde_json::json!({ "parts": parts, "resources": resources }))
}

#[tauri::command]
fn read_resource(path: String, name: String) -> Result<Response, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    let entries = grt_container::read_archive(&bytes)
        .map_err(|e| format!("{path} is not a readable GRT document: {e}"))?;

    entries
        .into_iter()
        .find(|entry| entry.name == name)
        .map(|entry| Response::new(entry.data))
        .ok_or_else(|| format!("{name} is not in this document"))
}

#[tauri::command]
fn write_grt(path: String, parts: serde_json::Value) -> Result<(), String> {
    let map = parts
        .as_object()
        .ok_or_else(|| "Document parts must be an object".to_string())?;

    let mut entries = vec![grt_container::Entry::new(
        grt_container::README_NAME,
        grt_container::README_TEXT.as_bytes().to_vec(),
    )];

    for (name, value) in map {
        let text = value
            .as_str()
            .ok_or_else(|| format!("Part {name} is not text"))?;
        entries.push(grt_container::Entry::new(
            name.clone(),
            text.as_bytes().to_vec(),
        ));
    }

    let bytes = grt_container::write_archive(entries)
        .map_err(|e| format!("Cannot build the note: {e}"))?;

    let target = Path::new(&path);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    atomic_write(target, &bytes)
}

// Search.

fn with_index<T>(
    app: &AppHandle,
    state: &State<'_, Index>,
    action: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut held = state
        .0
        .lock()
        .map_err(|_| "The index is unavailable".to_string())?;

    if held.is_none() {
        let connection = if is_ephemeral() {
            index::open(None)?
        } else {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("No data directory available: {e}"))?;
            index::open(Some(&index::path_in(&dir)))?
        };
        *held = Some(connection);
    }

    action(held.as_ref().expect("just opened"))
}

#[tauri::command]
fn index_state(app: AppHandle, state: State<'_, Index>) -> Result<serde_json::Value, String> {
    let rows = with_index(&app, &state, index::state)?;
    Ok(serde_json::json!(rows
        .into_iter()
        .map(|(path, modified)| serde_json::json!({ "path": path, "modified": modified }))
        .collect::<Vec<_>>()))
}

#[tauri::command]
fn index_upsert(
    app: AppHandle,
    state: State<'_, Index>,
    path: String,
    title: String,
    tags: String,
    body: String,
    modified: i64,
) -> Result<(), String> {
    with_index(&app, &state, |connection| {
        index::upsert(connection, &path, &title, &tags, &body, modified)
    })
}

#[tauri::command]
fn index_remove(app: AppHandle, state: State<'_, Index>, path: String) -> Result<(), String> {
    with_index(&app, &state, |connection| index::remove(connection, &path))
}

#[tauri::command]
fn index_search(
    app: AppHandle,
    state: State<'_, Index>,
    query: String,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let hits = with_index(&app, &state, |connection| {
        index::search(connection, &query, limit.unwrap_or(60))
    })?;

    Ok(serde_json::json!(hits
        .into_iter()
        .map(|hit| serde_json::json!({
            "path": hit.path,
            "title": hit.title,
            "tags": hit.tags,
            "snippet": hit.snippet,
        }))
        .collect::<Vec<_>>()))
}

#[tauri::command]
fn index_dump(app: AppHandle, state: State<'_, Index>) -> Result<serde_json::Value, String> {
    let rows = with_index(&app, &state, index::dump)?;
    Ok(serde_json::json!(rows
        .into_iter()
        .map(|(path, title, body)| serde_json::json!({
            "path": path, "title": title, "body": body,
        }))
        .collect::<Vec<_>>()))
}

/// Empties the index.
#[tauri::command]
fn index_forget(app: AppHandle, state: State<'_, Index>) -> Result<(), String> {
    with_index(&app, &state, index::clear)
}

// Settings and startup.

#[tauri::command]
fn runtime_info(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "ephemeral": is_ephemeral(),
        "version": env!("CARGO_PKG_VERSION"),
        "initialFile": initial_file(),
        "defaultRoot": default_root(&app).ok().map(|p| p.to_string_lossy().to_string()),
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

/// Deletes the settings **and** the search index.
#[tauri::command]
fn forget_settings(app: AppHandle, state: State<'_, Index>) -> Result<(), String> {
    let path = settings_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cannot remove {}: {e}", path.display())),
    }

    with_index(&app, &state, index::clear)?;

    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::remove_file(index::path_in(&dir));
    }

    Ok(())
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
        .manage(Index::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file_atomic,
            file_exists,
            read_archive,
            create_folder,
            rename_entry,
            delete_entry,
            read_grt,
            read_resource,
            write_grt,
            index_state,
            index_upsert,
            index_remove,
            index_search,
            index_dump,
            index_forget,
            runtime_info,
            read_settings,
            write_settings,
            forget_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
