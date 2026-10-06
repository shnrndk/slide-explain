"""Versioned SQLite storage. Every mutation participates in the same maintenance lock."""

from __future__ import annotations
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import uuid
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return uuid.uuid4().hex


def default_root():
    override = os.environ.get("SLIDE_EXPLAIN_DATA_DIR") or os.environ.get("SLIDE_NOTES_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    support = Path.home() / "Library/Application Support"
    legacy = support / "Slide Notes"
    # Continue using existing libraries and private keys after the product rename.
    root = legacy if (legacy / "notes.sqlite3").exists() or (legacy / "config.env").exists() else support / "Slide Explain"
    return root.resolve()


SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notebooks(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id), name TEXT NOT NULL, original_name TEXT NOT NULL, sha256 TEXT NOT NULL, page_count INTEGER NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS slides(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), page_number INTEGER NOT NULL, text TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, UNIQUE(document_id,page_number));
CREATE TABLE IF NOT EXISTS notes(slide_id TEXT NOT NULL REFERENCES slides(id), kind TEXT NOT NULL CHECK(kind IN ('explanation','personal')), body TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(slide_id,kind));
CREATE TABLE IF NOT EXISTS note_versions(id TEXT PRIMARY KEY, slide_id TEXT NOT NULL REFERENCES slides(id), kind TEXT NOT NULL, body TEXT NOT NULL, origin TEXT NOT NULL, model TEXT, reasoning TEXT, prompt_version TEXT, usage TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, slide_id TEXT NOT NULL REFERENCES slides(id), status TEXT NOT NULL, reasoning TEXT NOT NULL, base_revision INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,created_at);
CREATE INDEX IF NOT EXISTS versions_slide ON note_versions(slide_id,kind,created_at);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def migrate(db):
    """Upgrade v1 in one transaction, preserving every original note and job."""
    if db.execute("PRAGMA user_version").fetchone()[0] < 2:
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE notes_v2(slide_id TEXT NOT NULL REFERENCES slides(id), kind TEXT NOT NULL CHECK(kind IN ('explanation','personal','detail')), body TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(slide_id,kind))")
        db.execute("INSERT INTO notes_v2 SELECT * FROM notes")
        db.execute("INSERT INTO notes_v2 SELECT id,'detail','',0,? FROM slides", (now(),))
        db.execute("DROP TABLE notes")
        db.execute("ALTER TABLE notes_v2 RENAME TO notes")
        db.execute("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'explanation' CHECK(kind IN ('explanation','detail'))")
        db.execute("DROP INDEX IF EXISTS one_active_job")
        db.execute("CREATE UNIQUE INDEX one_active_job ON jobs(slide_id,kind) WHERE status IN ('queued','running')")
        db.execute("INSERT INTO schema_migrations VALUES (2,?)", (now(),))
        db.execute("PRAGMA user_version=2")

    if db.execute("PRAGMA user_version").fetchone()[0] < 3:
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE annotations(id TEXT PRIMARY KEY, slide_id TEXT NOT NULL REFERENCES slides(id), kind TEXT NOT NULL CHECK(kind IN ('explanation','personal','detail')), body_hash TEXT NOT NULL, start_offset INTEGER NOT NULL CHECK(start_offset>=0), end_offset INTEGER NOT NULL CHECK(end_offset>start_offset), quote TEXT NOT NULL, style TEXT NOT NULL CHECK(style IN ('highlight','underline')), color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink')), created_at TEXT NOT NULL)")
        db.execute("CREATE INDEX annotations_note ON annotations(slide_id,kind,body_hash)")
        db.execute("INSERT INTO schema_migrations VALUES (3,?)", (now(),))
        db.execute("PRAGMA user_version=3")

    if db.execute("PRAGMA user_version").fetchone()[0] < 4:
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE chat_turns(id TEXT PRIMARY KEY, slide_id TEXT NOT NULL REFERENCES slides(id), question TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, reasoning TEXT NOT NULL, error TEXT, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
        db.execute("CREATE UNIQUE INDEX one_active_chat ON chat_turns(slide_id) WHERE status IN ('queued','running')")
        db.execute("CREATE TABLE chat_clips(id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES chat_turns(id), created_at TEXT NOT NULL)")
        db.execute("INSERT INTO schema_migrations VALUES (4,?)", (now(),))
        db.execute("PRAGMA user_version=4")

    if db.execute("PRAGMA user_version").fetchone()[0] < 5:
        if "length" not in {row[1] for row in db.execute("PRAGMA table_info(jobs)")}:
            db.execute("ALTER TABLE jobs ADD COLUMN length TEXT NOT NULL DEFAULT 'medium' CHECK(length IN ('brief','medium','long'))")
            db.execute("UPDATE jobs SET length='long' WHERE kind='detail'")
        db.execute("INSERT OR IGNORE INTO schema_migrations VALUES (5,?)", (now(),))
        db.execute("PRAGMA user_version=5")

    if db.execute("PRAGMA user_version").fetchone()[0] < 6:
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE pdf_text_layers(slide_id TEXT PRIMARY KEY REFERENCES slides(id), text TEXT NOT NULL, characters TEXT NOT NULL)")
        db.execute("CREATE TABLE pdf_annotations(id TEXT PRIMARY KEY, slide_id TEXT NOT NULL REFERENCES pdf_text_layers(slide_id), text_hash TEXT NOT NULL, start_offset INTEGER NOT NULL CHECK(start_offset>=0), end_offset INTEGER NOT NULL CHECK(end_offset>start_offset), quote TEXT NOT NULL, style TEXT NOT NULL CHECK(style IN ('highlight','underline')), color TEXT NOT NULL CHECK(color IN ('yellow','green','blue','pink')), created_at TEXT NOT NULL)")
        db.execute("CREATE INDEX pdf_annotations_slide ON pdf_annotations(slide_id,text_hash)")
        db.execute("INSERT INTO schema_migrations VALUES (6,?)", (now(),))
        db.execute("PRAGMA user_version=6")


class Conflict(Exception):
    def __init__(self, current):
        self.current = current


class Store:
    def __init__(self, root: Path):
        self.root = root
        self.assets = root / "assets"
        self.backups = root / "backups"
        self.db_path = root / "notes.sqlite3"
        self.lock = threading.RLock()
        for path in (root, self.assets, self.backups):
            path.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > 6:
                raise RuntimeError(
                    "This database was created by a newer version of Slide Explain."
                )
            db.executescript(SCHEMA)
            db.execute("INSERT OR IGNORE INTO schema_migrations VALUES (1,?)", (now(),))
            migrate(db)
            db.execute(
                "UPDATE jobs SET status='interrupted', error='App stopped during generation. Retry when ready.', updated_at=? WHERE status='running'",
                (now(),),
            )
            db.execute("UPDATE chat_turns SET status='interrupted',error='App restarted during this answer. Retry when ready.',updated_at=? WHERE status='running'", (now(),))
        self.set_default("reasoning", "high")
        self.set_default("queue_paused", False)
        self.set_default("backup_folder", "")
        # An interrupted import never became a visible document. Clean only managed staging files.
        import shutil

        for stage in root.glob(".import-*"):
            if stage.is_dir():
                shutil.rmtree(stage)

    @contextlib.contextmanager
    def connect(self):
        with self.lock:
            db = sqlite3.connect(self.db_path, timeout=30)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=FULL")
            try:
                with db:
                    yield db
            finally:
                db.close()

    def rows(self, sql, args=()):
        with self.connect() as db:
            return [dict(r) for r in db.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        rows = self.rows(sql, args)
        return rows[0] if rows else None

    def setting(self, key, default=None):
        row = self.one("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key, value):
        with self.connect() as db:
            db.execute(
                "INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value)),
            )

    def set_default(self, key, value):
        with self.connect() as db:
            db.execute(
                "INSERT OR IGNORE INTO settings VALUES (?,?)", (key, json.dumps(value))
            )

    def note(self, slide_id, kind):
        return self.one(
            "SELECT * FROM notes WHERE slide_id=? AND kind=?", (slide_id, kind)
        )

    def save_note(self, slide_id, kind, body, revision, origin="edit", metadata=None):
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM notes WHERE slide_id=? AND kind=?", (slide_id, kind)
            ).fetchone()
            if row is None:
                raise KeyError(slide_id)
            if row["revision"] != revision:
                raise Conflict(dict(row))
            if row["body"] == body:
                return dict(row)
            self.add_version(db, slide_id, kind, body, origin, metadata)
            db.execute(
                "UPDATE notes SET body=?,revision=revision+1,updated_at=? WHERE slide_id=? AND kind=?",
                (body, now(), slide_id, kind),
            )
            return dict(
                db.execute(
                    "SELECT * FROM notes WHERE slide_id=? AND kind=?", (slide_id, kind)
                ).fetchone()
            )

    @staticmethod
    def add_version(db, slide_id, kind, body, origin, metadata=None):
        meta = metadata or {}
        db.execute(
            "INSERT INTO note_versions VALUES (?,?,?,?,?,?,?,?,?,?)",
            (
                uid(),
                slide_id,
                kind,
                body,
                origin,
                meta.get("model"),
                meta.get("reasoning"),
                meta.get("prompt_version"),
                json.dumps(meta["usage"]) if meta.get("usage") else None,
                now(),
            ),
        )


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_write(path, data):
    temp = path.with_suffix(path.suffix + ".tmp")
    with open(temp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
    sync_directory(path.parent)
