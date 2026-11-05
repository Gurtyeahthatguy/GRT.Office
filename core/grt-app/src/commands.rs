//! The commands every program registers.

use std::path::Path;

use grt_container::encryption::Protection;
use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Runtime, State, Webview, Window};

use tauri::Manager;

use crate::{is_ephemeral, lock, package, recovery, recovery_dir, release, templates, CloseGuard, Recovery};

/// Holds the main window open while it has unsaved work, or lets it go.
#[tauri::command]
pub fn set_close_guard(guard: State<'_, CloseGuard>, held: bool) {
    lock(&guard.0).hold(held);
}

/// The page received a close request and is dealing with it.
#[tauri::command]
pub fn close_ack(guard: State<'_, CloseGuard>) {
    lock(&guard.0).answer();
}

/// Closes the main window, giving up the recovery slot first.
#[tauri::command]
pub fn close_window<R: Runtime>(window: Window<R>, state: State<'_, Recovery>) -> Result<(), String> {
    release(&state);
    window.destroy().map_err(|e| format!("Cannot close the window: {e}"))
}

/// Claims this program's slot and returns where its copy goes, or nothing in
/// ephemeral mode, which never writes one.
#[tauri::command]
pub fn recovery_begin<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Recovery>,
    extension: String,
) -> Result<Option<serde_json::Value>, String> {
    if is_ephemeral() {
        return Ok(None);
    }
    let mut held = lock(&state.0);
    if held.is_none() {
        let slot = recovery::begin(&recovery_dir(&app)?, &extension)
            .map_err(|e| format!("Cannot prepare a recovery copy: {e}"))?;
        *held = Some(slot);
    }
    let slot = held.as_ref().expect("claimed above");
    Ok(Some(serde_json::json!({
        "id": slot.id,
        "path": slot.data.to_string_lossy(),
    })))
}

/// Records which document the copy holds, once the copy is written.
#[tauri::command]
pub fn recovery_saved(state: State<'_, Recovery>, meta: serde_json::Value) -> Result<(), String> {
    match lock(&state.0).as_ref() {
        Some(slot) => recovery::note(slot, &meta).map_err(|e| format!("Cannot note the recovery copy: {e}")),
        None => Ok(()),
    }
}

/// Deletes this program's copy, after a save or when changes are thrown away.
#[tauri::command]
pub fn recovery_discard(state: State<'_, Recovery>) -> Result<(), String> {
    match lock(&state.0).as_ref() {
        Some(slot) => recovery::discard(slot).map_err(|e| format!("Cannot remove the recovery copy: {e}")),
        None => Ok(()),
    }
}

/// Copies left by runs of this program that ended without closing properly.
#[tauri::command]
pub fn recovery_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Recovery>,
) -> Result<Vec<serde_json::Value>, String> {
    if is_ephemeral() {
        return Ok(Vec::new());
    }
    let own = lock(&state.0).as_ref().map(|slot| slot.id.clone());
    let found = recovery::orphans(&recovery_dir(&app)?, own.as_deref())
        .map_err(|e| format!("Cannot look for recovery copies: {e}"))?;
    Ok(found
        .into_iter()
        .map(|orphan| {
            serde_json::json!({
                "id": orphan.id,
                "path": orphan.data.to_string_lossy(),
                "meta": orphan.meta,
            })
        })
        .collect())
}

/// Deletes a copy left by an earlier run.
#[tauri::command]
pub fn recovery_remove<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Recovery>,
    id: String,
) -> Result<(), String> {
    let own = lock(&state.0).as_ref().map(|slot| slot.id.clone());
    recovery::remove(&recovery_dir(&app)?, &id, own.as_deref())
        .map_err(|e| format!("Cannot remove the recovery copy: {e}"))
}

/// Reads a ZIP package (ODF, OOXML, .grt) whole, as one raw block, opening it with the password if it has one.
#[tauri::command(async)]
pub fn read_package(path: String, password: Option<String>) -> Result<Response, String> {
    package::read_block(Path::new(&path), password.as_deref())
        .map(Response::new)
        .map_err(|e| if e.starts_with("grt:") { e } else { format!("Cannot read {path}: {e}") })
}

fn header(request: &Request<'_>, name: &str) -> Result<Option<String>, String> {
    let Some(value) = request.headers().get(name) else { return Ok(None) };
    let raw = value.to_str().map_err(|e| format!("Malformed {name}: {e}"))?;
    percent_decode_str(raw)
        .decode_utf8()
        .map(|text| Some(text.to_string()))
        .map_err(|e| format!("{name} is not valid UTF-8: {e}"))
}

/// Writes a ZIP package from a raw block, its path in `x-grt-path`, sealed with `x-grt-protection` and `x-grt-password` when they are given.
#[tauri::command(async)]
pub fn write_package(request: Request<'_>) -> Result<(), String> {
    let path = header(&request, "x-grt-path")?.ok_or_else(|| "Missing destination path".to_string())?;
    let protection = header(&request, "x-grt-protection")?;
    let password = header(&request, "x-grt-password")?;
    let seal = match (protection.as_deref(), password.as_deref()) {
        (Some(kind), Some(password)) if !password.is_empty() => {
            let kind = Protection::from_name(kind).ok_or_else(|| format!("Unknown protection {kind}"))?;
            Some((kind, password))
        }
        _ => None,
    };
    let InvokeBody::Raw(block) = request.body() else {
        return Err("Expected a raw byte payload, got JSON".to_string());
    };
    package::write_block(Path::new(&path), block, seal).map_err(|e| if e.starts_with("grt:") { e } else { format!("Cannot write {path}: {e}") })
}

/// Reads a PDF in the clear, opening it with the password if it has one.
#[tauri::command(async)]
pub fn read_pdf(path: String, password: Option<String>) -> Result<Response, String> {
    package::read_pdf(Path::new(&path), password.as_deref()).map(Response::new)
}

/// Writes a PDF from raw bytes, its path in `x-grt-path`, sealed when `x-grt-password` is given.
#[tauri::command(async)]
pub fn write_pdf(request: Request<'_>) -> Result<(), String> {
    let path = header(&request, "x-grt-path")?.ok_or_else(|| "Missing destination path".to_string())?;
    let password = header(&request, "x-grt-password")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected a raw byte payload, got JSON".to_string());
    };
    package::write_pdf(Path::new(&path), bytes, password.as_deref())
}

/// Prints the page straight to a PDF file, on paper of the given width and height in millimetres.
#[tauri::command]
pub async fn print_to_pdf<R: Runtime>(webview: Webview<R>, width: f64, height: f64, path: String) -> Result<(), String> {
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return Err("The paper has no size".to_string());
    }
    crate::print::print_to_pdf(&webview, width, height, Path::new(&path))
}

/// Prints the page, on paper of the given width and height in millimetres.
#[tauri::command]
pub async fn print_page<R: Runtime>(webview: Webview<R>, width: f64, height: f64) -> Result<(), String> {
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return Err("The paper has no size".to_string());
    }
    crate::print::print(&webview, width, height).map_err(|e| format!("Cannot print: {e}"))
}

/// The templates folder, Templates in the user's Documents, and the templates in it with one of the extensions given.
#[tauri::command(async)]
pub fn list_templates<R: Runtime>(app: AppHandle<R>, extensions: Vec<String>) -> Result<serde_json::Value, String> {
    let folder = app.path().document_dir().map_err(|e| format!("No Documents folder: {e}"))?.join("Templates");
    let items = templates::list(&folder, &extensions);
    Ok(serde_json::json!({ "folder": folder.to_string_lossy(), "items": items }))
}

/// Makes the templates folder if it is not there, and says where it is.
#[tauri::command(async)]
pub fn templates_folder<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let folder = app.path().document_dir().map_err(|e| format!("No Documents folder: {e}"))?.join("Templates");
    std::fs::create_dir_all(&folder).map_err(|e| format!("Cannot make {}: {e}", folder.display()))?;
    Ok(folder.to_string_lossy().into_owned())
}
