#!/usr/bin/env python3
"""Prints a page through WebKitGTK to a PDF, the way the programs print on Linux.

Usage: print-pdf.py <url> <setup.js> <out.pdf>

setup.js runs once the page has loaded and must open the print preview; its
value may be a promise. The paper is read from the preview's @page rule and set
on the print operation exactly as grt-app does.
"""

import json
import re
import sys

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

url, setup_path, out = sys.argv[1:4]
setup = open(setup_path, encoding='utf-8').read()

window = Gtk.OffscreenWindow()
view = WebKit2.WebView()
view.set_size_request(1100, 900)
window.add(view)
window.show_all()
status = {'code': 1}


def fail(message):
    print(message, file=sys.stderr)
    Gtk.main_quit()


def paper_size():
    def done(source, result):
        try:
            value = source.evaluate_javascript_finish(result)
            text = value.to_string()
        except GLib.Error as err:
            return fail(f'cannot read the paper: {err.message}')
        match = re.search(r'size:\s*([\d.]+)mm\s+([\d.]+)mm', text or '')
        if not match:
            return fail(f'no @page rule: {text!r}')
        print_now(float(match.group(1)), float(match.group(2)))
    view.evaluate_javascript("document.getElementById('grt-print-page')?.textContent ?? ''", -1, None, None, None, done)


def print_now(width, height):
    setup_page = Gtk.PageSetup()
    size = next((p for p in Gtk.PaperSize.get_paper_sizes(False)
                 if abs(p.get_width(Gtk.Unit.MM) - width) < 1 and abs(p.get_height(Gtk.Unit.MM) - height) < 1), None)
    if size is None:
        name = f'custom_{width:.0f}x{height:.0f}mm'
        size = Gtk.PaperSize.new_custom(name, name, width, height, Gtk.Unit.MM)
    setup_page.set_paper_size(size)
    setup_page.set_orientation(Gtk.PageOrientation.PORTRAIT)
    for side in ('top', 'bottom', 'left', 'right'):
        getattr(setup_page, f'set_{side}_margin')(0, Gtk.Unit.MM)
    settings = Gtk.PrintSettings()
    # GTK names its file printer in the user's language.
    settings.set_printer(GLib.dgettext('gtk30', 'Print to File'))
    settings.set(Gtk.PRINT_SETTINGS_OUTPUT_FILE_FORMAT, 'pdf')
    settings.set(Gtk.PRINT_SETTINGS_OUTPUT_URI, GLib.filename_to_uri(out, None))
    operation = WebKit2.PrintOperation.new(view)
    operation.set_page_setup(setup_page)
    operation.set_print_settings(settings)

    def finished(_op):
        status['code'] = 0
        print(json.dumps({'width': width, 'height': height}))
        Gtk.main_quit()
    operation.connect('finished', finished)
    operation.connect('failed', lambda _op, err: fail(f'print failed: {err.message}'))
    operation.print_()


def loaded(_view, event):
    if event != WebKit2.LoadEvent.FINISHED:
        return

    def ran(source, result):
        try:
            source.evaluate_javascript_finish(result)
        except GLib.Error as err:
            return fail(f'setup failed: {err.message}')
        # Layout and pictures settle before the pages are printed.
        GLib.timeout_add(800, lambda: paper_size() and False)
    view.call_async_javascript_function(setup, -1, None, None, None, None, ran)


view.connect('load-changed', loaded)
view.load_uri(url)
GLib.timeout_add_seconds(60, lambda: fail('timed out'))
Gtk.main()
sys.exit(status['code'])
