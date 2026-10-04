from __future__ import annotations
from contextlib import closing
import os
from pathlib import Path
import shutil
import threading
from pypdf import PdfReader
import pypdfium2 as pdfium
from .store import Store, now, uid, sha256, durable_write, sync_directory

# PDFium is not thread-safe, including when separate documents are used.
PDF_LOCK = threading.Lock()
MAX_BYTES = 100 * 1024 * 1024
MAX_PAGES = 500


def import_pdf(store: Store, notebook_id: str, filename: str, content: bytes):
    if len(content) > MAX_BYTES:
        raise ValueError("PDF must be 100 MB or smaller.")
    if not content.lstrip().startswith(b"%PDF-"):
        raise ValueError(
            "Please choose a valid PDF. Export PowerPoint or Keynote to PDF first."
        )
    doc_id = uid()
    stage = store.root / f".import-{doc_id}"
    destination = store.assets / doc_id
    # Hold maintenance lock across import so backups cannot observe half an import.
    with store.lock, PDF_LOCK:
        notebook = store.one(
            "SELECT id FROM notebooks WHERE id=? AND deleted_at IS NULL", (notebook_id,)
        )
        if not notebook:
            raise KeyError(notebook_id)
        stage.mkdir()
        try:
            original = stage / "original.pdf"
            durable_write(original, content)
            reader = PdfReader(original)
            if reader.is_encrypted:
                raise ValueError(
                    "This PDF is password-protected. Export an unlocked copy and try again."
                )
            page_count = len(reader.pages)
            if not 1 <= page_count <= MAX_PAGES:
                raise ValueError(f"Choose a PDF with 1–{MAX_PAGES} pages.")
            pages = []
            with closing(pdfium.PdfDocument(original)) as pdf:
                for index in range(page_count):
                    page = pdf[index]
                    try:
                        w, h = page.get_size()
                        bitmap = page.render(scale=min(2.5, 2000 / max(w, h)))
                        try:
                            image = bitmap.to_pil()
                            image.save(stage / f"{index + 1}.png")
                            width, height = image.size
                        finally:
                            bitmap.close()
                        try:
                            text = reader.pages[index].extract_text() or ""
                        except Exception:
                            text = ""
                        pages.append((uid(), doc_id, index + 1, text, width, height))
                    finally:
                        page.close()
            # Flush generated assets before the database references them.
            for file in stage.iterdir():
                with file.open("rb") as f:
                    os.fsync(f.fileno())
            sync_directory(stage)
            os.replace(stage, destination)
            sync_directory(store.assets)
            sync_directory(store.root)
            with store.connect() as db:
                db.execute(
                    "INSERT INTO documents VALUES (?,?,?,?,?,?,?,NULL)",
                    (
                        doc_id,
                        notebook_id,
                        Path(filename).stem[:200] or "Untitled PDF",
                        Path(filename).name,
                        sha256(destination / "original.pdf"),
                        page_count,
                        now(),
                    ),
                )
                db.executemany("INSERT INTO slides VALUES (?,?,?,?,?,?)", pages)
                for slide in pages:
                    for kind in ("explanation", "personal", "detail"):
                        db.execute(
                            "INSERT INTO notes VALUES (?,?, '',0,?)",
                            (slide[0], kind, now()),
                        )
            return store.one("SELECT * FROM documents WHERE id=?", (doc_id,))
        except Exception as exc:
            shutil.rmtree(stage, ignore_errors=True)
            # No visible database record -> no managed asset should remain.
            if not store.one("SELECT id FROM documents WHERE id=?", (doc_id,)):
                shutil.rmtree(destination, ignore_errors=True)
            if isinstance(exc, (ValueError, KeyError)):
                raise
            raise ValueError(
                "This PDF could not be read. It may be corrupt; try exporting a fresh PDF."
            ) from exc
