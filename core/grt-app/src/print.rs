//! Printing the page as it is, on paper of the size its pages are drawn at.

use tauri::{Runtime, Webview};

/// Opens the system's print dialog for the webview, paper set to the pages' size in millimetres.
pub fn print<R: Runtime>(webview: &Webview<R>, width: f64, height: f64) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    {
        webview.with_webview(move |platform| linux::print(&platform.inner(), width, height))
    }
    #[cfg(not(target_os = "linux"))]
    {
        // WebView2 and WKWebView take the paper from the page's own @page rule.
        let _ = (width, height);
        webview.print()
    }
}

/// Prints the webview to a PDF file with no dialog, the paper as `print` sets it; returns when the file is written.
pub fn print_to_pdf<R: Runtime>(webview: &Webview<R>, width: f64, height: f64, path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let (done, wait) = std::sync::mpsc::channel::<Result<(), String>>();
        let target = path.to_path_buf();
        webview
            .with_webview(move |platform| linux::print_to_file(&platform.inner(), width, height, &target, done))
            .map_err(|e| e.to_string())?;
        wait.recv_timeout(std::time::Duration::from_secs(300))
            .map_err(|_| "The PDF took too long to write".to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (webview, width, height, path);
        Err("Saving a PDF straight from the pages is not available here; print to PDF instead".to_string())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::cell::RefCell;

    use gtk::prelude::*;
    use gtk::{PageOrientation, PageSetup, PaperSize, PrintSettings, Unit};
    use webkit2gtk::{PrintOperation, PrintOperationExt, PrintOperationResponse, WebView};

    thread_local! {
        // The printer and its options, kept for the next print while the program runs.
        static SETTINGS: RefCell<Option<PrintSettings>> = const { RefCell::new(None) };
    }

    /// The named paper of a size, or a custom one; a wide page gets paper as wide as it is.
    fn paper(width: f64, height: f64) -> PaperSize {
        let close = |a: f64, b: f64| (a - b).abs() < 1.0;
        let named = |w: f64, h: f64| {
            PaperSize::paper_sizes(false)
                .into_iter()
                .find(|p| close(p.width(Unit::Mm), w) && close(p.height(Unit::Mm), h))
        };
        if let Some(size) = named(width, height) {
            return size;
        }
        let label = named(height, width)
            .and_then(|turned| turned.display_name())
            .map_or_else(|| format!("{width:.0} × {height:.0} mm"), |name| format!("{name}, landscape"));
        PaperSize::new_custom(&format!("custom_{width:.0}x{height:.0}mm"), &label, width, height, Unit::Mm)
    }

    /// The page setup every print uses: the pages' own paper, no margins, portrait.
    fn page_setup(width: f64, height: f64) -> (PageSetup, PaperSize) {
        let setup = PageSetup::new();
        let size = paper(width, height);
        setup.set_paper_size(&size);
        setup.set_orientation(PageOrientation::Portrait);
        for set in [PageSetup::set_top_margin, PageSetup::set_bottom_margin, PageSetup::set_left_margin, PageSetup::set_right_margin] {
            set(&setup, 0.0, Unit::Mm);
        }
        (setup, size)
    }

    /// Prints to a PDF file through GTK's own file printer; nothing leaves the machine.
    pub fn print_to_file(
        webview: &WebView,
        width: f64,
        height: f64,
        path: &std::path::Path,
        done: std::sync::mpsc::Sender<Result<(), String>>,
    ) {
        let (setup, size) = page_setup(width, height);
        let settings = PrintSettings::new();
        // GTK names its file printer in the desktop's language, so the name is asked of GTK's own translation.
        settings.set_printer(&gtk::glib::dgettext(Some("gtk30"), "Print to File"));
        settings.set("output-file-format", Some("pdf"));
        let uri = gtk::glib::filename_to_uri(path, None).map(|u| u.to_string()).unwrap_or_default();
        settings.set("output-uri", Some(&uri));
        settings.set_paper_size(&size);
        settings.set_orientation(PageOrientation::Portrait);
        let operation = PrintOperation::new(webview);
        operation.set_page_setup(&setup);
        operation.set_print_settings(&settings);
        let finished = done.clone();
        operation.connect_finished(move |_| {
            let _ = finished.send(Ok(()));
        });
        operation.connect_failed(move |_, error| {
            let _ = done.send(Err(format!("The PDF could not be written: {error}")));
        });
        operation.print();
    }

    pub fn print(webview: &WebView, width: f64, height: f64) {
        // Wide pages get wide paper rather than a landscape setup.
        let (setup, size) = page_setup(width, height);

        let operation = PrintOperation::new(webview);
        operation.set_page_setup(&setup);
        SETTINGS.with(|kept| {
            if let Some(settings) = kept.borrow().as_ref().and_then(PrintSettings::copy) {
                settings.set_paper_size(&size);
                settings.set_orientation(PageOrientation::Portrait);
                operation.set_print_settings(&settings);
            }
        });
        let parent = webview.toplevel().and_then(|w| w.downcast::<gtk::Window>().ok());
        if operation.run_dialog(parent.as_ref()) == PrintOperationResponse::Print {
            SETTINGS.with(|kept| *kept.borrow_mut() = operation.print_settings());
        }
    }
}
