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

    pub fn print(webview: &WebView, width: f64, height: f64) {
        // Wide pages get wide paper rather than a landscape setup.
        let setup = PageSetup::new();
        let size = paper(width, height);
        setup.set_paper_size(&size);
        setup.set_orientation(PageOrientation::Portrait);
        for set in [PageSetup::set_top_margin, PageSetup::set_bottom_margin, PageSetup::set_left_margin, PageSetup::set_right_margin] {
            set(&setup, 0.0, Unit::Mm);
        }

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
