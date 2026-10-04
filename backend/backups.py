from __future__ import annotations
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import tempfile
import zipfile
from .store import Store, durable_write, now, sha256, uid, sync_directory, migrate

ASSET = re.compile(r"assets/[a-f0-9]{32}/(?:original\.pdf|[1-9][0-9]*\.png)$")


def recover_restore(root: Path):
    """A journal makes a power loss during the file swap recoverable on next launch."""
    journal = root / ".restore-journal.json"
    if not journal.exists():
        return
    old = root / ".restore-old"
    if (old / "notes.sqlite3").exists():
        for suffix in ("-wal", "-shm"):
            (root / ("notes.sqlite3" + suffix)).unlink(missing_ok=True)
        os.replace(old / "notes.sqlite3", root / "notes.sqlite3")
    if (old / "assets").exists():
        shutil.rmtree(root / "assets", ignore_errors=True)
        os.replace(old / "assets", root / "assets")
    journal.unlink()
    shutil.rmtree(old, ignore_errors=True)


def create_backup(store: Store, safety=False):
    with store.lock:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        name = f"{'safety' if safety else 'backup'}-{stamp}.zip"
        output = store.backups / name
        with tempfile.TemporaryDirectory(prefix=".backup-", dir=store.root) as temp:
            stage = Path(temp)
            with store.connect() as source:
                target = sqlite3.connect(stage / "notes.sqlite3")
                try:
                    source.backup(target)
                finally:
                    target.close()
            files = [(stage / "notes.sqlite3", "notes.sqlite3")]
            # Referenced assets only, including recoverable trash.
            for doc in store.rows("SELECT id,name,page_count FROM documents"):
                for filename in ["original.pdf"] + [
                    f"{i}.png" for i in range(1, doc["page_count"] + 1)
                ]:
                    path = store.assets / doc["id"] / filename
                    if not path.is_file():
                        raise ValueError(
                            "A source asset is missing. Backup stopped to avoid creating an incomplete archive."
                        )
                    files.append((path, f"assets/{doc['id']}/{filename}"))
                readable = [f"# {doc['name']}\n"]
                for note in store.rows(
                    "SELECT s.page_number,n.kind,n.body FROM slides s JOIN notes n ON n.slide_id=s.id WHERE s.document_id=? ORDER BY s.page_number,CASE n.kind WHEN 'explanation' THEN 0 WHEN 'detail' THEN 1 ELSE 2 END",
                    (doc["id"],),
                ):
                    label = {"explanation": "Explanation", "detail": "Detailed explanation", "personal": "Personal notes"}[note["kind"]]
                    readable.append(f"## Slide {note['page_number']} — {label}\n\n{note['body']}\n")
                # Include readable marking quotes alongside the lossless database.
                has_marks = store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='annotations'")
                if has_marks:
                    for mark in store.rows("SELECT a.*,s.page_number FROM annotations a JOIN slides s ON s.id=a.slide_id JOIN notes n ON n.slide_id=a.slide_id AND n.kind=a.kind WHERE s.document_id=? ORDER BY s.page_number,a.created_at", (doc["id"],)):
                        import hashlib
                        current = store.note(mark["slide_id"], mark["kind"])
                        if mark["body_hash"] == hashlib.sha256(current["body"].encode()).hexdigest():
                            readable.append(f"### Slide {mark['page_number']} — {mark['kind']} {mark['style']} ({mark['color']})\n\n{mark['quote']}\n")
                if store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_turns'"):
                    for turn in store.rows("SELECT c.*,s.page_number FROM chat_turns c JOIN slides s ON s.id=c.slide_id WHERE s.document_id=? ORDER BY c.created_at", (doc["id"],)):
                        readable.append(f"### Slide {turn['page_number']} — Chat\n\nQuestion: {turn['question']}\n\n{turn['answer'] or turn['status']}\n")
                exported = stage / f"{doc['id']}.md"
                exported.write_text("\n".join(readable), encoding="utf-8")
                files.append((exported, f"exports/{doc['id']}/notes.md"))
            readme = stage / "README.txt"
            readme.write_text(
                "Slide Explain complete backup\n\n"
                "assets/<document-id>/original.pdf: original PDFs\n"
                "assets/<document-id>/<page>.png: slide images\n"
                "exports/<document-id>/notes.md: readable explanations, detailed explanations and personal notes\n"
                "notes.sqlite3: complete library, note history, settings and generation records\n"
                "manifest.json: integrity checksums\n\n"
                "Restore this ZIP through Settings & backups. Do not edit the archive before restoring.\n"
                "API keys are not included.\n", encoding="utf-8")
            files.append((readme, "README.txt"))
            manifest = {
                "format": 1,
                "created_at": now(),
                "files": {name: sha256(path) for path, name in files},
            }
            temp_archive = output.with_suffix(".tmp")
            try:
                with zipfile.ZipFile(
                    temp_archive, "w", compression=zipfile.ZIP_DEFLATED
                ) as archive:
                    for path, entry in files:
                        archive.write(path, entry)
                    archive.writestr("manifest.json", json.dumps(manifest))
                with temp_archive.open("rb") as f:
                    os.fsync(f.fileno())
                os.replace(temp_archive, output)
                sync_directory(store.backups)
            finally:
                temp_archive.unlink(missing_ok=True)
        if not safety:
            store.set_setting("last_backup", now())
            store.set_setting("backup_error", None)
            secondary = store.setting("backup_folder", "")
            if secondary:
                try:
                    folder = Path(secondary)
                    if not folder.is_dir():
                        raise OSError("Backup folder is unavailable")
                    dest = folder / name
                    shutil.copyfile(output, dest.with_suffix(".tmp"))
                    os.replace(dest.with_suffix(".tmp"), dest)
                    prune(folder)
                except OSError:
                    store.set_setting(
                        "backup_error",
                        "Local backup succeeded, but the second backup folder is unavailable. Reconnect it and back up again.",
                    )
        prune(store.backups)
        return output


def prune(folder: Path):
    files = sorted(folder.glob("backup-*.zip"), reverse=True)
    days, weeks, keep = set(), set(), set()
    for path in files:
        try:
            dt = datetime.strptime(path.stem[7:], "%Y%m%dT%H%M%S%fZ")
        except ValueError:
            continue
        day, week = dt.date(), dt.isocalendar()[:2]
        if day not in days and len(days) < 7:
            days.add(day)
            keep.add(path)
        if week not in weeks and len(weeks) < 4:
            weeks.add(week)
            keep.add(path)
    for path in files:
        if path not in keep:
            path.unlink()
    # Safety snapshots have an independent retention policy.
    for path in sorted(folder.glob("safety-*.zip"), reverse=True)[5:]:
        path.unlink()


def validate_archive(archive_path: Path, target: Path):
    try:
        with zipfile.ZipFile(archive_path) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if len(names) != len(set(names)) or len(names) > 100_000:
                raise ValueError("Invalid or duplicated backup entries.")
            if sum(e.file_size for e in entries) > 10 * 1024**3:
                raise ValueError("Backup is too large to restore (10 GB limit).")
            if (
                "manifest.json" not in names
                or archive.getinfo("manifest.json").file_size > 20 * 1024**2
            ):
                raise ValueError("Missing or invalid backup manifest.")
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("format") != 1 or not isinstance(
                manifest.get("files"), dict
            ):
                raise ValueError("Unsupported backup format.")
            if (
                set(names) != set(manifest["files"]) | {"manifest.json"}
                or "notes.sqlite3" not in names
            ):
                raise ValueError("Backup contents do not match the manifest.")
            for name, checksum in manifest["files"].items():
                if name not in {"notes.sqlite3", "README.txt"} and not ASSET.fullmatch(name) and not re.fullmatch(r"exports/[a-f0-9]{32}/notes\.md", name):
                    raise ValueError("Unsafe file path in backup.")
                dest = target / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(name) as source, dest.open("wb") as output:
                    shutil.copyfileobj(source, output)
                if sha256(dest) != checksum:
                    raise ValueError(
                        "Backup checksum failed. The archive may be damaged."
                    )
        db = sqlite3.connect(f"file:{target / 'notes.sqlite3'}?mode=ro", uri=True)
        try:
            if (
                db.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
                or db.execute("PRAGMA foreign_key_check").fetchall()
            ):
                raise ValueError("Backup database integrity check failed.")
            if db.execute("PRAGMA user_version").fetchone()[0] not in (1, 2, 3, 4, 5):
                raise ValueError("Backup requires a different version of Slide Explain.")
            if db.execute("PRAGMA user_version").fetchone()[0] >= 5:
                db.execute("SELECT length FROM jobs LIMIT 0")
            required = {
                "schema_migrations",
                "notebooks",
                "documents",
                "slides",
                "notes",
                "note_versions",
                "jobs",
                "settings",
            }
            if db.execute("PRAGMA user_version").fetchone()[0] >= 3:
                required.add("annotations")
                db.execute("SELECT id,slide_id,kind,body_hash,start_offset,end_offset,quote,style,color,created_at FROM annotations LIMIT 0")
            if db.execute("PRAGMA user_version").fetchone()[0] >= 4:
                required.update({"chat_turns", "chat_clips"})
                db.execute("SELECT id,slide_id,question,answer,status,reasoning,error,metadata,created_at,updated_at FROM chat_turns LIMIT 0")
                db.execute("SELECT id,turn_id,created_at FROM chat_clips LIMIT 0")
            actual = {
                r[0]
                for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            if not required <= actual:
                raise ValueError("Backup is missing required database tables.")
            if db.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('trigger','view')"
            ).fetchone():
                raise ValueError("Unexpected database objects in backup.")
            for doc_id, count in db.execute("SELECT id,page_count FROM documents"):
                if not re.fullmatch(r"[a-f0-9]{32}", doc_id) or not 1 <= count <= 500:
                    raise ValueError("Invalid document in backup.")
                pages = [
                    r[0]
                    for r in db.execute(
                        "SELECT page_number FROM slides WHERE document_id=? ORDER BY page_number",
                        (doc_id,),
                    )
                ]
                if pages != list(range(1, count + 1)):
                    raise ValueError("Backup is missing slide records.")
                expected = [f"assets/{doc_id}/original.pdf"] + [
                    f"assets/{doc_id}/{i}.png" for i in pages
                ]
                if any(e not in manifest["files"] for e in expected):
                    raise ValueError("Backup is missing document assets.")
            for table, columns in {
                "notes": "slide_id,kind,body,revision,updated_at",
                "note_versions": "id,slide_id,kind,body,origin,model,reasoning,prompt_version,usage,created_at",
                "jobs": "id,slide_id,status,reasoning,base_revision,attempts,error,created_at,updated_at",
                "settings": "key,value",
                "notebooks": "id,name,created_at,deleted_at",
            }.items():
                db.execute(f"SELECT {columns} FROM {table} LIMIT 0")
        finally:
            db.close()
    except (
        zipfile.BadZipFile,
        KeyError,
        json.JSONDecodeError,
        sqlite3.Error,
        TypeError,
    ) as exc:
        raise ValueError("This is not a valid Slide Explain backup.") from exc


def restore_backup(store: Store, archive_path: Path):
    with store.lock:
        if store.one("SELECT id FROM jobs WHERE status='running'") or store.one("SELECT id FROM chat_turns WHERE status='running'"):
            raise ValueError(
                "Pause generation and wait for running slides to finish before restoring."
            )
        with tempfile.TemporaryDirectory(prefix=".restore-", dir=store.root) as temp:
            stage = Path(temp)
            validate_archive(archive_path, stage)
            # Preserve machine-specific settings; never adopt an archive's filesystem destination.
            backup_folder = store.setting("backup_folder", "")
            safety = create_backup(store, safety=True)
            with store.connect() as db:
                db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            old = store.root / ".restore-old"
            old.mkdir(exist_ok=True)
            journal = store.root / ".restore-journal.json"
            durable_write(journal, json.dumps({"started_at": now()}).encode())
            try:
                for suffix in ("-wal", "-shm"):
                    (store.root / ("notes.sqlite3" + suffix)).unlink(missing_ok=True)
                os.replace(store.db_path, old / "notes.sqlite3")
                os.replace(store.assets, old / "assets")
                sync_directory(old)
                sync_directory(store.root)
                (stage / "assets").mkdir(exist_ok=True)
                os.replace(stage / "notes.sqlite3", store.db_path)
                os.replace(stage / "assets", store.assets)
                with store.connect() as db:
                    migrate(db)
                    db.execute("UPDATE chat_turns SET status='interrupted',error='Restored from backup. Retry when ready.' WHERE status IN ('queued','running')")
                    db.execute(
                        "UPDATE jobs SET status='interrupted',error='Restored from backup. Retry when ready.' WHERE status IN ('queued','running')"
                    )
                store.set_setting("queue_paused", True)
                store.set_setting("backup_folder", backup_folder)
                store.set_setting("last_backup", None)
                store.set_setting("backup_error", None)
                store.set_setting("data_epoch", uid())
                sync_directory(store.root)
                journal.unlink()
                sync_directory(store.root)
                shutil.rmtree(old)
            except Exception:
                recover_restore(store.root)
                raise
        return safety.name
