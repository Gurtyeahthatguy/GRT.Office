//! Rust backend for GRT Slides.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use std::collections::HashMap;
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};

/// Whether the program was started with `--ephemeral`.
fn is_ephemeral() -> bool {
    std::env::args().any(|arg| arg == "--ephemeral")
}

/// Reads a file and hands the bytes back as a raw ArrayBuffer.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    Ok(Response::new(bytes))
}

/// Writes a file atomically.
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
        InvokeBody::Json(_) => {
            return Err("Expected a raw byte payload, got JSON".to_string())
        }
    };

    atomic_write(Path::new(&decoded), bytes)
}

/// Reports whether the file exists, so the UI can warn before overwriting.
#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Startup facts the frontend needs.
#[tauri::command]
fn runtime_info() -> serde_json::Value {
    serde_json::json!({
        "ephemeral": is_ephemeral(),
        "version": env!("CARGO_PKG_VERSION"),
        "initialFile": initial_file(),
    })
}

/// The document named on the command line, if there is one.
fn initial_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|arg| !arg.starts_with('-') && Path::new(arg).is_file())
}

/// Where preferences live.
fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No configuration directory available: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// Reads the stored preferences, or an empty object if there are none.
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

/// Stores the preferences.
#[tauri::command]
fn write_settings(app: AppHandle, settings: serde_json::Value) -> Result<bool, String> {
    if is_ephemeral() {
        return Ok(false);
    }

    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }

    let text = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Cannot serialise settings: {e}"))?;

    atomic_write(&path, text.as_bytes())?;
    Ok(true)
}

/// Deletes the settings file, returning the program to its first-run state.
#[tauri::command]
fn forget_settings(app: AppHandle) -> Result<(), String> {
    let path = settings_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Already absent is the desired end state, not a failure.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot remove {}: {e}", path.display())),
    }
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Builds a temporary name next to the target file.
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
        // Force the data out before the rename.
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&temp);
        return Err(format!("Cannot write {}: {e}", target.display()));
    }

    // Overwriting an existing file must not silently widen its permissions,
    // so the original mode is carried over to the replacement.
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

    // Syncing the directory makes the rename itself durable, not just the
    // file contents.
    #[cfg(unix)]
    if let Some(dir) = target.parent() {
        if let Ok(handle) = fs::File::open(dir) {
            let _ = handle.sync_all();
        }
    }

    Ok(())
}

/// Binary parts waiting to be written into the next document.
#[derive(Default)]
struct Staged(Mutex<HashMap<String, Vec<u8>>>);

/// Holds one binary part for the next `write_grt`.
#[tauri::command]
fn stage_part(request: Request<'_>, staged: tauri::State<'_, Staged>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-grt-name")
        .ok_or_else(|| "Missing part name".to_string())?
        .to_str()
        .map_err(|e| format!("Malformed part name: {e}"))?;

    let name = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|e| format!("Part name is not valid UTF-8: {e}"))?
        .to_string();

    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("Expected raw bytes, got JSON".to_string()),
    };

    staged
        .0
        .lock()
        .map_err(|_| "Staging area unavailable".to_string())?
        .insert(name, bytes);

    Ok(())
}

/// Forgets everything staged.
#[tauri::command]
fn clear_staged(staged: tauri::State<'_, Staged>) -> Result<(), String> {
    staged
        .0
        .lock()
        .map_err(|_| "Staging area unavailable".to_string())?
        .clear();
    Ok(())
}

/// Reads the text parts of a `.grt` document.
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

/// Reads one binary part as raw bytes.
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

/// Writes a `.grt` document, atomically and deterministically.
#[tauri::command]
fn write_grt(
    path: String,
    parts: serde_json::Value,
    staged: tauri::State<'_, Staged>,
) -> Result<(), String> {
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
        entries.push(grt_container::Entry::new(name.clone(), text.as_bytes().to_vec()));
    }

    {
        let held = staged
            .0
            .lock()
            .map_err(|_| "Staging area unavailable".to_string())?;
        for (name, bytes) in held.iter() {
            entries.push(grt_container::Entry::new(name.clone(), bytes.clone()));
        }
    }

    let bytes = grt_container::write_archive(entries)
        .map_err(|e| format!("Cannot build the document: {e}"))?;

    atomic_write(Path::new(&path), &bytes)
}

/// Reads the parts of any ZIP-based document.
#[tauri::command]
fn read_zip(path: String) -> Result<serde_json::Value, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    let entries = grt_container::read_archive(&bytes)
        .map_err(|e| format!("{path} is not a readable archive: {e}"))?;

    let mut parts = serde_json::Map::new();
    let mut binaries = Vec::new();

    for entry in entries {
        match std::str::from_utf8(&entry.data) {
            Ok(text) => {
                parts.insert(entry.name, serde_json::Value::String(text.to_string()));
            }
            Err(_) => binaries.push(serde_json::Value::String(entry.name)),
        }
    }

    Ok(serde_json::json!({ "parts": parts, "binaries": binaries }))
}

/// Opens the presenter window on a second screen.
#[tauri::command]
fn open_presenter(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("presenter") {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "presenter",
        tauri::WebviewUrl::App("present.html".into()),
    )
    .title("GRT Slides — presenter view")
    .inner_size(1100.0, 700.0)
    .build()
    .map_err(|e| format!("Cannot open the presenter view: {e}"))?;

    Ok(())
}

/// Closes the presenter window, if it is open.
#[tauri::command]
fn close_presenter(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("presenter") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Staged::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file_atomic,
            file_exists,
            runtime_info,
            read_settings,
            write_settings,
            forget_settings,
            read_grt,
            write_grt,
            read_resource,
            stage_part,
            clear_staged,
            open_presenter,
            close_presenter,
            read_zip
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
