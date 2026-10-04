from __future__ import annotations
import asyncio
import hashlib
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
import os
import fcntl
from pathlib import Path
import tempfile
from typing import Literal
from urllib.parse import urlparse
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, Field
from .store import Store, Conflict, default_root, now, uid
from .importer import import_pdf, MAX_BYTES
from .generation import Generation, MODEL
from .backups import create_backup, restore_backup, recover_restore

PROJECT = Path(__file__).resolve().parents[1]
load_dotenv(default_root() / "config.env")
load_dotenv(PROJECT / ".env")


class Name(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class NoteEdit(BaseModel):
    body: str = Field(max_length=200_000)
    revision: int = Field(ge=0)
    epoch: str


class ReadingPosition(BaseModel):
    epoch: str
    page: int = Field(ge=1, le=500)
    fraction: float = Field(ge=0, le=1)


class Generate(BaseModel):
    length: Literal["brief", "medium", "long"] = "brief"
    kind: Literal["explanation", "detail"] = "explanation"
    mode: Literal["all", "selected", "missing", "failed"] = "missing"
    slide_ids: list[str] = Field(default_factory=list, max_length=500)
    reasoning: Literal["medium", "high", "xhigh"] = "high"


class Settings(BaseModel):
    reasoning: Literal["medium", "high", "xhigh"] = "high"
    backup_folder: str = Field(default="", max_length=4096)


class AnnotationEdit(BaseModel):
    revision: int = Field(ge=0)
    epoch: str
    start: int = Field(ge=0, le=2_000_000)
    end: int = Field(gt=0, le=2_000_000)
    quote: str = Field(min_length=1, max_length=100_000)
    style: Literal["highlight", "underline"] = "highlight"
    color: Literal["yellow", "green", "blue", "pink"] = "yellow"
    action: Literal["mark", "clear"] = "mark"


class ChatQuestion(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9-]{32,36}$")
    question: str = Field(min_length=1, max_length=8000)
    epoch: str
    reasoning: Literal["medium", "high", "xhigh"] = "high"


class ChatClip(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9-]{32,36}$")
    text: str = Field(min_length=1,max_length=100_000)
    revision: int = Field(ge=0)
    epoch: str


class AcceptDetail(BaseModel):
    epoch: str
    revision: int = Field(ge=0)
    detail_revision: int = Field(ge=0)


class RestoreVersion(BaseModel):
    revision: int
    epoch: str


@contextmanager
def exclusive_root(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".app.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError(
                "Slide Explain is already running for this data directory. Open the existing app or stop it first."
            ) from exc
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def create_app(data_dir=None, client=None, workers=True):
    @asynccontextmanager
    async def lifespan(app):
        root = Path(data_dir) if data_dir else default_root()
        with exclusive_root(root):
            recover_restore(root)
            store = Store(root)
            store.set_default("data_epoch", uid())
            app.state.store = store
            gen = Generation(store, client)
            app.state.generation = gen

            async def backup_loop():
                while True:
                    try:
                        last = store.setting("last_backup")
                        if (
                            not last
                            or (
                                datetime.now(timezone.utc)
                                - datetime.fromisoformat(last)
                            ).total_seconds()
                            >= 86400
                        ):
                            await asyncio.to_thread(create_backup, store)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        store.set_setting(
                            "backup_error",
                            "Automatic backup failed. Check disk space and use Back up now to retry.",
                        )
                    await asyncio.sleep(60)

            task = None
            if workers:
                gen.start()
                task = asyncio.create_task(backup_loop())
            try:
                yield
            finally:
                if task:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                await gen.stop()

    app = FastAPI(title="Slide Explain", lifespan=lifespan)
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"]
    )

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if request.headers.get("x-slide-notes") != "1" or (
                origin
                and urlparse(origin).netloc
                not in {
                    "127.0.0.1:8000",
                    "localhost:8000",
                    "127.0.0.1:5173",
                    "localhost:5173",
                }
            ):
                return JSONResponse(
                    status_code=403,
                    content={
                        "detail": "This action must come from the local Slide Explain app."
                    },
                )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        if request.url.path.startswith("/api") or request.url.path in {"/", "/index.html"}:
            response.headers["Cache-Control"] = "no-store"
        return response

    def store():
        return app.state.store

    def require(sql, args):
        result = store().one(sql, args)
        if not result:
            raise HTTPException(404, "Not found.")
        return result

    def epoch(value):
        if value != store().setting("data_epoch"):
            raise HTTPException(
                409,
                "The library was restored. Reload before saving; your local draft is preserved.",
            )

    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    @app.exception_handler(KeyError)
    async def missing(request, exc):
        return JSONResponse(status_code=404, content={"detail": "Not found."})

    @app.exception_handler(Conflict)
    async def conflict(request, exc):
        return JSONResponse(
            status_code=409,
            content={
                "detail": "This note changed elsewhere. Your draft is preserved.",
                "current": exc.current,
            },
        )

    @app.get("/api/status")
    def status():
        return {
            "api_version": 7,
            "active_chats": store().one("SELECT COUNT(*) AS count FROM chat_turns WHERE status IN ('queued','running')")["count"],
            "api_key_configured": bool(os.environ.get("OPENAI_API_KEY") or client),
            "model": MODEL,
            "data_dir": str(store().root),
            "epoch": store().setting("data_epoch"),
            "queue_paused": store().setting("queue_paused"),
            "reasoning": store().setting("reasoning"),
            "last_document": store().setting("last_document"),
            "backup_folder": store().setting("backup_folder"),
            "last_backup": store().setting("last_backup"),
            "backup_error": store().setting("backup_error"),
        }

    @app.get("/api/library")
    def library():
        return {
            "notebooks": store().rows("SELECT * FROM notebooks ORDER BY created_at"),
            "documents": store().rows(
                "SELECT d.*, (SELECT COUNT(*) FROM slides s JOIN notes n ON n.slide_id=s.id AND n.kind='explanation' WHERE s.document_id=d.id AND n.body!='') explained_count FROM documents d ORDER BY d.created_at"
            ),
        }

    @app.post("/api/notebooks")
    def new_notebook(body: Name):
        name = body.name.strip()
        if not name:
            raise ValueError("Enter a notebook name.")
        ident = uid()
        with store().connect() as db:
            db.execute(
                "INSERT INTO notebooks VALUES (?,?,?,NULL)", (ident, name, now())
            )
        return store().one("SELECT * FROM notebooks WHERE id=?", (ident,))

    @app.patch("/api/{kind}/{ident}")
    def rename(kind: Literal["notebooks", "documents"], ident: str, body: Name):
        require(f"SELECT id FROM {kind} WHERE id=?", (ident,))
        if not body.name.strip():
            raise ValueError("Enter a name.")
        with store().connect() as db:
            db.execute(
                f"UPDATE {kind} SET name=? WHERE id=?", (body.name.strip(), ident)
            )
        return {"ok": True}

    @app.delete("/api/{kind}/{ident}")
    def trash(kind: Literal["notebooks", "documents"], ident: str):
        require(f"SELECT id FROM {kind} WHERE id=?", (ident,))
        with store().connect() as db:
            db.execute(f"UPDATE {kind} SET deleted_at=? WHERE id=?", (now(), ident))
            where = "d.id=?" if kind == "documents" else "d.notebook_id=?"
            db.execute(
                f"UPDATE jobs SET status='cancelled',updated_at=? WHERE status IN ('queued','running') AND slide_id IN (SELECT s.id FROM slides s JOIN documents d ON d.id=s.document_id WHERE {where})",
                (now(), ident),
            )
            db.execute(
                f"UPDATE chat_turns SET status='cancelled',updated_at=? WHERE status IN ('queued','running') AND slide_id IN (SELECT s.id FROM slides s JOIN documents d ON d.id=s.document_id WHERE {where})",
                (now(), ident),
            )
        return {"ok": True}

    @app.post("/api/{kind}/{ident}/untrash")
    def untrash(kind: Literal["notebooks", "documents"], ident: str):
        item = require(f"SELECT * FROM {kind} WHERE id=?", (ident,))
        with store().connect() as db:
            db.execute(f"UPDATE {kind} SET deleted_at=NULL WHERE id=?", (ident,))
            if kind == "documents":
                db.execute(
                    "UPDATE notebooks SET deleted_at=NULL WHERE id=?",
                    (item["notebook_id"],),
                )
        return {"ok": True}

    @app.post("/api/notebooks/{notebook_id}/import")
    def upload(notebook_id: str, file: UploadFile = File(...)):
        content = file.file.read(MAX_BYTES + 1)
        return import_pdf(
            store(), notebook_id, file.filename or "Untitled.pdf", content
        )

    @app.get("/api/documents/{document_id}/reading-position")
    def reading_position(document_id: str):
        require("SELECT id FROM documents WHERE id=?", (document_id,))
        return store().setting("reading:" + document_id, None)

    @app.put("/api/documents/{document_id}/reading-position")
    def save_reading_position(document_id: str, body: ReadingPosition):
        with store().lock:
            epoch(body.epoch)
            require("SELECT id FROM slides WHERE document_id=? AND page_number=?", (document_id,body.page))
            with store().connect() as db:
                import json
                for key,value in [("reading:" + document_id,{"page":body.page,"fraction":body.fraction}), ("last_document",document_id)]:
                    db.execute("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key,json.dumps(value)))
            return {"ok":True}

    @app.get("/api/documents/{document_id}")
    def document(document_id: str):
        with store().lock:
            doc = require("SELECT * FROM documents WHERE id=?", (document_id,))
            slides = store().rows(
                "SELECT id,document_id,page_number,width,height FROM slides WHERE document_id=? ORDER BY page_number",
                (document_id,),
            )
            notes = store().rows(
                "SELECT n.* FROM notes n JOIN slides s ON s.id=n.slide_id WHERE s.document_id=?",
                (document_id,),
            )
            by_slide = {(n["slide_id"], n["kind"]): n for n in notes}
            for slide in slides:
                slide["explanation"] = by_slide[(slide["id"], "explanation")]
                slide["personal"] = by_slide[(slide["id"], "personal")]
                slide["detail"] = by_slide[(slide["id"], "detail")]
            return {**doc, "slides": slides, "epoch": store().setting("data_epoch")}

    @app.get("/api/slides/{slide_id}/image")
    def slide_image(slide_id: str):
        slide = require("SELECT * FROM slides WHERE id=?", (slide_id,))
        return FileResponse(
            store().assets / slide["document_id"] / f"{slide['page_number']}.png",
            media_type="image/png",
        )

    @app.get("/api/documents/{document_id}/original")
    def original(document_id: str):
        doc = require("SELECT * FROM documents WHERE id=?", (document_id,))
        return FileResponse(
            store().assets / doc["id"] / "original.pdf",
            media_type="application/pdf",
            filename=doc["original_name"],
        )

    @app.put("/api/slides/{slide_id}/notes/{kind}")
    def save_note(
        slide_id: str, kind: Literal["explanation", "personal", "detail"], body: NoteEdit
    ):
        with store().lock:
            epoch(body.epoch)
            return store().save_note(slide_id, kind, body.body, body.revision)

    def annotation_note(slide_id, kind, revision):
        note = store().note(slide_id, kind)
        if note is None:
            raise HTTPException(404, "Note not found.")
        if note["revision"] != revision:
            raise HTTPException(409, "The explanation changed. Reopen it and select the text again.")
        return hashlib.sha256(note["body"].encode()).hexdigest()

    @app.get("/api/slides/{slide_id}/notes/{kind}/annotations")
    def annotations(slide_id: str, kind: Literal["explanation", "personal", "detail"], revision: int, epoch_id: str):
        with store().lock:
            epoch(epoch_id)
            digest = annotation_note(slide_id, kind, revision)
            return store().rows("SELECT * FROM annotations WHERE slide_id=? AND kind=? AND body_hash=? ORDER BY created_at,id", (slide_id, kind, digest))

    @app.post("/api/slides/{slide_id}/notes/{kind}/annotations")
    def annotate(slide_id: str, kind: Literal["explanation", "personal", "detail"], body: AnnotationEdit):
        # Offsets use the browser's UTF-16 rendered text, not Markdown source.
        if body.end <= body.start or body.end - body.start != len(body.quote.encode("utf-16-le")) // 2:
            raise HTTPException(400, "The selected text range is invalid. Select the text again.")
        with store().lock:
            epoch(body.epoch)
            digest = annotation_note(slide_id, kind, body.revision)
            with store().connect() as db:
                if body.action == "clear":
                    db.execute("DELETE FROM annotations WHERE slide_id=? AND kind=? AND body_hash=? AND start_offset<? AND end_offset>?", (slide_id, kind, digest, body.end, body.start))
                else:
                    # Repeated clicks and recoloring the same selection are idempotent.
                    db.execute("DELETE FROM annotations WHERE slide_id=? AND kind=? AND body_hash=? AND start_offset=? AND end_offset=? AND style=?", (slide_id, kind, digest, body.start, body.end, body.style))
                    db.execute("INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?,?,?)", (uid(), slide_id, kind, digest, body.start, body.end, body.quote, body.style, body.color, now()))
                return [dict(row) for row in db.execute("SELECT * FROM annotations WHERE slide_id=? AND kind=? AND body_hash=? ORDER BY created_at,id", (slide_id, kind, digest))]

    @app.get("/api/slides/{slide_id}/chat")
    def chat_history(slide_id: str):
        require("SELECT id FROM slides WHERE id=?", (slide_id,))
        return store().rows("SELECT * FROM chat_turns WHERE slide_id=? ORDER BY created_at,id",(slide_id,))

    @app.post("/api/slides/{slide_id}/chat")
    def ask(slide_id: str, body: ChatQuestion):
        with store().lock:
            epoch(body.epoch)
            require("SELECT s.id FROM slides s JOIN documents d ON d.id=s.document_id JOIN notebooks n ON n.id=d.notebook_id WHERE s.id=? AND d.deleted_at IS NULL AND n.deleted_at IS NULL", (slide_id,))
            existing=store().one("SELECT * FROM chat_turns WHERE id=?",(body.id,))
            if existing:
                if existing["slide_id"] != slide_id or existing["question"] != body.question.strip():
                    raise HTTPException(409,"Request ID already used for another question.")
                return existing
            if not body.question.strip(): raise HTTPException(400,"Type a question first.")
            if not os.environ.get("OPENAI_API_KEY") and client is None: raise HTTPException(400,"Configure your API key before asking a question.")
            if store().one("SELECT id FROM chat_turns WHERE slide_id=? AND status IN ('queued','running')", (slide_id,)):
                raise HTTPException(409,"This slide already has an answer in progress.")
            with store().connect() as db:
                db.execute("INSERT INTO chat_turns VALUES (?,?,?,'','queued',?,NULL,NULL,?,?)",(body.id,slide_id,body.question.strip(),body.reasoning,now(),now()))
            return store().one("SELECT * FROM chat_turns WHERE id=?",(body.id,))

    @app.post("/api/chat/{turn_id}/retry")
    def retry_chat(turn_id: str, body: RestoreVersion):
        with store().lock:
            epoch(body.epoch)
            turn=require("SELECT * FROM chat_turns WHERE id=?",(turn_id,))
            require("SELECT s.id FROM slides s JOIN documents d ON d.id=s.document_id JOIN notebooks n ON n.id=d.notebook_id WHERE s.id=? AND d.deleted_at IS NULL AND n.deleted_at IS NULL", (turn["slide_id"],))
            if turn["status"] not in ("failed","interrupted"): return turn
            if store().one("SELECT id FROM chat_turns WHERE slide_id=? AND status IN ('queued','running')",(turn["slide_id"],)):
                raise HTTPException(409,"An answer is already in progress for this slide.")
            with store().connect() as db:
                db.execute("UPDATE chat_turns SET status='queued',error=NULL,updated_at=? WHERE id=?",(now(),turn_id))
            return store().one("SELECT * FROM chat_turns WHERE id=?",(turn_id,))

    @app.post("/api/chat/{turn_id}/notes")
    def clip_chat(turn_id: str, body: ChatClip):
        with store().lock:
            epoch(body.epoch)
            turn=require("SELECT * FROM chat_turns WHERE id=? AND status='completed'", (turn_id,))
            with store().connect() as db:
                note=dict(db.execute("SELECT * FROM notes WHERE slide_id=? AND kind='personal'",(turn["slide_id"],)).fetchone())
                if db.execute("SELECT id FROM chat_clips WHERE id=? AND turn_id=?",(body.id,turn_id)).fetchone(): return note
                if note["revision"] != body.revision: raise Conflict(note)
                text=note["body"].rstrip()+ ("\n\n" if note["body"].strip() else "") + body.text.strip()
                if len(text)>200_000: raise HTTPException(400,"Your notes are too long. Shorten them before adding this selection.")
                store().add_version(db,turn["slide_id"],"personal",text,"chat_selection")
                db.execute("UPDATE notes SET body=?,revision=revision+1,updated_at=? WHERE slide_id=? AND kind='personal'",(text,now(),turn["slide_id"]))
                db.execute("INSERT INTO chat_clips VALUES (?,?,?)",(body.id,turn_id,now()))
                old_hash=hashlib.sha256(note["body"].encode()).hexdigest()
                new_hash=hashlib.sha256(text.encode()).hexdigest()
                for mark in db.execute("SELECT * FROM annotations WHERE slide_id=? AND kind='personal' AND body_hash=?",(turn["slide_id"],old_hash)).fetchall():
                    db.execute("INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?,?,?)",(uid(),turn["slide_id"],"personal",new_hash,mark["start_offset"],mark["end_offset"],mark["quote"],mark["style"],mark["color"],now()))
                return dict(db.execute("SELECT * FROM notes WHERE slide_id=? AND kind='personal'",(turn["slide_id"],)).fetchone())

    @app.post("/api/slides/{slide_id}/use-detail")
    def use_detail(slide_id: str, body: AcceptDetail):
        with store().lock:
            epoch(body.epoch)
            detail = store().note(slide_id, "detail")
            if detail["revision"] != body.detail_revision:
                raise HTTPException(409, "The long explanation changed. Reopen it before replacing.")
            if not detail["body"].strip(): raise HTTPException(400, "Generate a long explanation first.")
            with store().connect() as db:
                current = dict(db.execute("SELECT * FROM notes WHERE slide_id=? AND kind='explanation'", (slide_id,)).fetchone())
                if current["revision"] != body.revision: raise Conflict(current)
                if current["body"] != detail["body"]:
                    store().add_version(db, slide_id, "explanation", detail["body"], "accepted_long")
                    db.execute("UPDATE notes SET body=?,revision=revision+1,updated_at=? WHERE slide_id=? AND kind='explanation'", (detail["body"],now(),slide_id))
                digest = hashlib.sha256(detail["body"].encode()).hexdigest()
                for mark in db.execute("SELECT * FROM annotations WHERE slide_id=? AND kind='detail' AND body_hash=?", (slide_id,digest)).fetchall():
                    if not db.execute("SELECT id FROM annotations WHERE slide_id=? AND kind='explanation' AND body_hash=? AND start_offset=? AND end_offset=? AND style=? AND color=?", (slide_id,digest,mark["start_offset"],mark["end_offset"],mark["style"],mark["color"])).fetchone():
                        db.execute("INSERT INTO annotations VALUES (?,?,?,?,?,?,?,?,?,?)", (uid(),slide_id,"explanation",digest,mark["start_offset"],mark["end_offset"],mark["quote"],mark["style"],mark["color"],now()))
            return store().note(slide_id, "explanation")

    @app.get("/api/slides/{slide_id}/notes/{kind}/history")
    def history(slide_id: str, kind: Literal["explanation", "personal", "detail"]):
        return store().rows(
            "SELECT * FROM note_versions WHERE slide_id=? AND kind=? ORDER BY created_at DESC",
            (slide_id, kind),
        )

    @app.post("/api/versions/{version_id}/restore")
    def restore_version(version_id: str, body: RestoreVersion):
        with store().lock:
            epoch(body.epoch)
            version = require("SELECT * FROM note_versions WHERE id=?", (version_id,))
            return store().save_note(
                version["slide_id"],
                version["kind"],
                version["body"],
                body.revision,
                "restore",
            )

    @app.post("/api/documents/{document_id}/generate")
    def generate(document_id: str, body: Generate):
        if not os.environ.get("OPENAI_API_KEY") and client is None:
            raise HTTPException(
                400, "Add OPENAI_API_KEY to .env and restart the app before generating."
            )
        return {
            "job_ids": app.state.generation.enqueue(
                document_id, body.slide_ids, body.mode, body.reasoning, body.kind, body.length
            )
        }

    @app.get("/api/jobs")
    def jobs(document_id: str | None = None):
        sql = "SELECT j.*,s.page_number,s.document_id FROM jobs j JOIN slides s ON s.id=j.slide_id"
        return store().rows(
            sql
            + (" WHERE s.document_id=?" if document_id else "")
            + " ORDER BY j.created_at DESC",
            (document_id,) if document_id else (),
        )

    @app.post("/api/queue/{action}")
    def queue(action: Literal["pause", "resume", "cancel"]):
        if action == "cancel":
            with store().connect() as db:
                db.execute("UPDATE chat_turns SET status='cancelled',updated_at=? WHERE status IN ('queued','running')",(now(),))
            with store().connect() as db:
                db.execute(
                    "UPDATE jobs SET status='cancelled',updated_at=? WHERE status IN ('queued','running')",
                    (now(),),
                )
        else:
            store().set_setting("queue_paused", action == "pause")
        return {"ok": True}

    @app.put("/api/settings")
    def settings(body: Settings):
        folder = body.backup_folder.strip()
        if folder:
            path = Path(folder).expanduser()
            if not path.is_absolute() or not path.is_dir():
                raise ValueError(
                    "Choose an existing absolute folder path for secondary backups."
                )
            path = path.resolve()
            if path == store().root or store().root in path.parents:
                raise ValueError(
                    "Choose a secondary backup folder outside the app's data directory."
                )
            folder = str(path)
        store().set_setting("reasoning", body.reasoning)
        store().set_setting("backup_folder", folder)
        return status()

    @app.get("/api/backups")
    def backups():
        return [
            {"name": p.name, "size": p.stat().st_size}
            for p in sorted(store().backups.glob("*.zip"), reverse=True)
        ]

    @app.post("/api/backups")
    def backup():
        try:
            path = create_backup(store())
        except Exception:
            store().set_setting(
                "backup_error",
                "Backup failed. Check available disk space and try again.",
            )
            raise HTTPException(
                500, "Backup failed. Existing backups and notes are unchanged."
            )
        return {"name": path.name, "warning": store().setting("backup_error")}

    @app.get("/api/backups/{name}")
    def download_backup(name: str):
        if Path(name).name != name or not name.endswith(".zip"):
            raise HTTPException(404)
        path = store().backups / name
        if not path.is_file():
            raise HTTPException(404)
        return FileResponse(path, filename=name, media_type="application/zip")

    @app.post("/api/restore")
    def restore(file: UploadFile = File(...)):
        with tempfile.NamedTemporaryFile(suffix=".zip", dir=store().root) as temp:
            total = 0
            while chunk := file.file.read(1024 * 1024):
                total += len(chunk)
                if total > 2 * 1024**3:
                    raise ValueError("Backup archive must be 2 GB or smaller.")
                temp.write(chunk)
            temp.flush()
            safety = restore_backup(store(), Path(temp.name))
        return {"ok": True, "safety_backup": safety}

    dist = PROJECT / "frontend/dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    return app


app = create_app()
