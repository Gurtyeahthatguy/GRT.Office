//! The clipboard read for a Paste button: the page cannot read it itself, so the program does, only when asked.

use tauri::{Runtime, Webview};

const MAX_TEXT: usize = 20 * 1024 * 1024;

/// The text and HTML on the clipboard, read on the main thread where GTK keeps it.
#[tauri::command]
pub async fn clipboard_read<R: Runtime>(webview: Webview<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let (send, wait) = std::sync::mpsc::channel::<(Option<String>, Option<String>)>();
        webview
            .with_webview(move |_| {
                let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
                let text = clipboard.wait_for_text().map(|t| t.to_string());
                let html = clipboard
                    .wait_for_contents(&gtk::gdk::Atom::intern("text/html"))
                    .map(|data| String::from_utf8_lossy(&data.data()).into_owned());
                let _ = send.send((text, html));
            })
            .map_err(|e| e.to_string())?;
        let (text, html) = wait
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "The clipboard did not answer".to_string())?;
        let cut = |s: Option<String>| s.filter(|s| s.len() <= MAX_TEXT);
        Ok(serde_json::json!({ "text": cut(text), "html": cut(html) }))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = webview;
        Err("Paste with Ctrl+V here".to_string())
    }
}
