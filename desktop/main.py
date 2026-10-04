"""Standalone Cocoa application. No credentials or notebooks live in the bundle."""
from __future__ import annotations
import os
from pathlib import Path
import sys
import threading
import uuid

# Also supports running this entry point directly during development.
if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from desktop.runtime import Backend, read_json, save_key
from backend.store import default_root


def main():
    # A packaged smoke check exercises frozen imports, assets and service shutdown.
    if "--check" in sys.argv:
        if not (os.environ.get("SLIDE_EXPLAIN_DATA_DIR") or os.environ.get("SLIDE_NOTES_DATA_DIR")):
            raise RuntimeError("Set SLIDE_EXPLAIN_DATA_DIR to an empty temporary directory for --check.")
        backend = Backend(port=int(os.environ.get("SLIDE_NOTES_CHECK_PORT", "8001")))
        try:
            backend.start()
            from urllib.request import urlopen
            with urlopen(backend.url) as response:
                assert b"<html" in response.read()
            assert read_json("/api/status", backend.url)["data_dir"] == str(default_root())
            # Check the native PDF library from inside the frozen bundle.
            import io
            import httpx
            from pypdf import PdfWriter
            buffer = io.BytesIO()
            pdf = PdfWriter()
            pdf.add_blank_page(720, 540)
            pdf.add_blank_page(540, 720)
            pdf.write(buffer)
            with httpx.Client(base_url=backend.url, headers={"X-Slide-Notes": "1"}, trust_env=False) as client:
                library = client.get("/api/library").json()
                if library["notebooks"]:
                    raise RuntimeError("Use an empty library for the packaged smoke check.")
                notebook = client.post("/api/notebooks", json={"name": "Packaged smoke check"}).json()
                imported = client.post(f"/api/notebooks/{notebook['id']}/import", files={"file": ("check.pdf", buffer.getvalue(), "application/pdf")})
                imported.raise_for_status()
                document = client.get(f"/api/documents/{imported.json()['id']}").json()
                assert [s["page_number"] for s in document["slides"]] == [1, 2]
                for slide in document["slides"]:
                    image = client.get(f"/api/slides/{slide['id']}/image")
                    assert image.status_code == 200 and image.content.startswith(b"\x89PNG")
            print("Packaged backend, interface, multipage PDF import and rendering: OK", flush=True)
        finally:
            backend.stop()
        return

    import AppKit
    from PyObjCTools import AppHelper
    import webview
    from webview.menu import Menu, MenuAction

    def alert(title, message):
        dialog = AppKit.NSAlert.alloc().init()
        dialog.setMessageText_(title)
        dialog.setInformativeText_(message)
        dialog.addButtonWithTitle_("OK")
        dialog.runModal()

    backend = Backend()
    try:
        backend.start()
    except Exception as error:
        AppKit.NSApplication.sharedApplication()
        alert("Slide Explain could not open", str(error))
        return

    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["ALLOW_FILE_URLS"] = False
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    window = webview.create_window(
        "Slide Explain", backend.url + "/?launch=" + uuid.uuid4().hex, width=1440, height=940,
        min_size=(900, 600), background_color="#fafaf7", text_select=True,
    )

    def configure_key():
        def prompt():
            dialog = AppKit.NSAlert.alloc().init()
            dialog.setMessageText_("OpenAI API key")
            dialog.setInformativeText_(
                "Stored privately on this Mac, outside notebooks and backups. "
                "After saving, quit Slide Explain and restart it. If the browser app's terminal is running, restart that too."
            )
            field = AppKit.NSSecureTextField.alloc().initWithFrame_(((0, 0), (360, 26)))
            field.setPlaceholderString_("Paste your API key")
            dialog.setAccessoryView_(field)
            dialog.addButtonWithTitle_("Save key")
            dialog.addButtonWithTitle_("Cancel")
            dialog.window().setInitialFirstResponder_(field)
            if dialog.runModal() == AppKit.NSAlertFirstButtonReturn:
                try:
                    save_key(str(field.stringValue()))
                    field.setStringValue_("")
                    alert("API key saved", "Restart Slide Explain to use the saved key.")
                except (ValueError, OSError):
                    alert("Could not save key", "Enter a key without spaces or line breaks, and check that your notes folder is writable.")
        AppHelper.callAfter(prompt)

    def may_close():
        # Blurring triggers the existing editor's autosave. Pending drafts also
        # remain in WKWebView's persistent local storage across app launches.
        try:
            pending = window.evaluate_js("""(() => {
                document.activeElement?.blur();
                return !!document.querySelector('.save-state.pending, .save-state.saving, .save-state.error, .save-state.conflict');
            })()""")
            if pending and not window.create_confirmation_dialog(
                "Unsaved edits", "Some edits have not reached the database. Their drafts will remain on this Mac. Quit anyway?"
            ):
                return False
            if backend.owned:
                jobs = read_json("/api/jobs")
                rows = jobs if isinstance(jobs, list) else jobs.get("jobs", [])
                if any(j.get("status") in {"queued", "running"} for j in rows) or read_json("/api/status").get("active_chats", 0):
                    return window.create_confirmation_dialog(
                        "Explanations are in progress",
                        "Quitting stops generation. Completed explanations are saved; interrupted requests can be retried when you reopen. Quit?",
                    )
        except Exception:
            # Do not trap the user in a broken window.
            pass
        return True

    close_approved = False
    close_checking = False

    def close_requested():
        nonlocal close_approved, close_checking
        if close_approved:
            return True
        if not close_checking:
            close_checking = True

            def check():
                nonlocal close_approved, close_checking
                try:
                    if may_close():
                        backend.stop()
                        close_approved = True
                        window.destroy()
                finally:
                    close_checking = False

            # Cocoa closing callbacks run on its main thread. JS and dialogs
            # must be checked on a worker so their UI callbacks can complete.
            threading.Thread(target=check, daemon=True).start()
        return False

    window.events.closing += close_requested
    menu = [Menu("Notebook", [
        MenuAction("Reading mode", lambda: window.run_js("document.querySelector('#enter-reading-mode, #exit-reading-mode')?.click()")),
        MenuAction("Configure API key…", configure_key),
    ])]
    try:
        webview.start(
            private_mode=False, storage_path=str(default_root() / "desktop-webview"),
            menu=menu,
        )
    finally:
        backend.stop()


if __name__ == "__main__":
    main()
