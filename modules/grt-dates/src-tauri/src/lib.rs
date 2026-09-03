//! Rust backend for GRT Dates.

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
        InvokeBody::Json(_) => return Err("Expected a raw byte payload, got JSON".to_string()),
    };

    let target = Path::new(&decoded);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    }

    atomic_write(target, bytes)
}

/// Reports whether the file exists, so the UI can warn before overwriting.
#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Deletes a calendar file.
#[tauri::command]
fn remove_calendar(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if target.extension().and_then(|e| e.to_str()) != Some("ics") {
        return Err("Only calendar files can be removed".to_string());
    }
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot remove {}: {e}", target.display())),
    }
}

/// The directory calendars live in by default.
fn default_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("No usable directory for calendars: {e}"))?;
    Ok(base.join("GRT Calendar"))
}

/// Lists the calendars in a directory, or in the default one.
#[tauri::command]
fn list_calendars(app: AppHandle, directory: Option<String>) -> Result<serde_json::Value, String> {
    let dir = match directory {
        Some(path) => PathBuf::from(path),
        None => default_directory(&app)?,
    };

    let mut files = Vec::new();

    if dir.is_dir() {
        let entries =
            fs::read_dir(&dir).map_err(|e| format!("Cannot read {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("ics") {
                continue;
            }
            let name = match path.file_stem().and_then(|s| s.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };
            files.push(serde_json::json!({
                "name": name,
                "path": path.to_string_lossy(),
            }));
        }
    }

    // Sorted by name so the order on screen does not depend on the order the
    // filesystem happens to hand entries back in.
    files.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

    Ok(serde_json::json!({
        "directory": dir.to_string_lossy(),
        "calendars": files,
    }))
}

/// Startup facts the frontend needs.
#[tauri::command]
fn runtime_info(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "ephemeral": is_ephemeral(),
        "version": env!("CARGO_PKG_VERSION"),
        "initialFile": initial_file(),
        "defaultDirectory": default_directory(&app).ok().map(|p| p.to_string_lossy().to_string()),
    })
}

/// The calendar named on the command line, if there is one.
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

    // Overwriting an existing file must not silently widen its permissions.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file_atomic,
            file_exists,
            remove_calendar,
            list_calendars,
            runtime_info,
            read_settings,
            write_settings,
            forget_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
