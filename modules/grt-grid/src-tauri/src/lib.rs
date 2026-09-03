//! Rust backend for GRT Grid.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager};


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
        .map_err(|e| format!("Cannot build the spreadsheet: {e}"))?;

    let target = Path::new(&path);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }
    atomic_write(target, &bytes)
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

/// Deletes the settings file, returning the program to its first-run state.
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file_atomic,
            file_exists,
            read_grt,
            read_resource,
            write_grt,
            runtime_info,
            read_settings,
            write_settings,
            forget_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
