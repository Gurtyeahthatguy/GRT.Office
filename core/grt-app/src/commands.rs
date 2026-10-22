//! The commands every program registers.

use std::path::Path;

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Runtime, State, Webview, Window};

use crate::{is_ephemeral, lock, package, recovery, recovery_dir, release, CloseGuard, Recovery};

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

/// Reads a ZIP package (ODF, OOXML, .grt) whole, as one raw block.
#[tauri::command]
pub fn read_package(path: String) -> Result<Response, String> {
    package::read_block(Path::new(&path))
        .map(Response::new)
        .map_err(|e| format!("Cannot read {path}: {e}"))
}

/// Writes a ZIP package from a raw block, its path in the `x-grt-path` header.
#[tauri::command]
pub fn write_package(request: Request<'_>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-grt-path")
        .ok_or_else(|| "Missing destination path".to_string())?
        .to_str()
        .map_err(|e| format!("Malformed destination path: {e}"))?;
    let path = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|e| format!("Destination path is not valid UTF-8: {e}"))?
        .to_string();
    let InvokeBody::Raw(block) = request.body() else {
        return Err("Expected a raw byte payload, got JSON".to_string());
    };
    package::write_block(Path::new(&path), block).map_err(|e| format!("Cannot write {path}: {e}"))
}

/// Prints the page, on paper of the given width and height in millimetres.
#[tauri::command]
pub async fn print_page<R: Runtime>(webview: Webview<R>, width: f64, height: f64) -> Result<(), String> {
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return Err("The paper has no size".to_string());
    }
    crate::print::print(&webview, width, height).map_err(|e| format!("Cannot print: {e}"))
}
