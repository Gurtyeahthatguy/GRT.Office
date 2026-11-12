//! What every GRT program's backend shares: the close guard, recovery copies and packages.

pub mod close;
pub mod commands;
#[cfg(feature = "everywhere")]
pub mod everywhere;
#[cfg(any(feature = "spelling", feature = "writing-tools"))]
mod gz;
#[cfg(feature = "spelling")]
pub mod spelling;
#[cfg(feature = "writing-tools")]
pub mod wordtools;
pub mod package;
pub mod print;
pub mod recovery;
pub mod templates;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};

/// The event the page receives when the user asks to close a window it holds.
pub const CLOSE_REQUESTED: &str = "grt://close-requested";

/// The document window; other windows, such as a presenter view, close freely.
const MAIN: &str = "main";

/// Run once at start-up by every program: GTK keeps no list of recently used files for it,
/// since GRT leaves no recents; the file chooser and the print-to-file printer would add to it.
pub fn setup<R: Runtime>(_app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    forget_recent_files();
    Ok(())
}

/// Turns GTK's list of recently used files off for this process.
pub fn forget_recent_files() {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        if let Some(settings) = gtk::Settings::default() {
            settings.set_gtk_recent_files_enabled(false);
            settings.set_gtk_recent_files_max_age(0);
        }
    }
}

/// Whether the program was started with `--ephemeral`.
pub fn is_ephemeral() -> bool {
    std::env::args().any(|arg| arg == "--ephemeral")
}

/// The close guard, managed by every program.
#[derive(Default)]
pub struct CloseGuard(Mutex<close::Guard>);

/// This program's recovery slot, claimed on first use.
#[derive(Default)]
pub struct Recovery(Mutex<Option<recovery::Slot>>);

/// Handles the main window's close request and its destruction.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            let state = window.state::<CloseGuard>();
            let decision = lock(&state.0).request(Instant::now());
            if decision == close::Decision::Ask {
                api.prevent_close();
                let _ = window.emit(CLOSE_REQUESTED, ());
            }
        }
        WindowEvent::Destroyed => release(&window.state::<Recovery>()),
        _ => {}
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn release(state: &Recovery) {
    if let Some(slot) = lock(&state.0).take() {
        let _ = recovery::release(slot);
    }
}

pub(crate) fn recovery_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join("recovery"))
        .map_err(|e| format!("No cache directory available: {e}"))
}
