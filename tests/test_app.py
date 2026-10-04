import asyncio
import io
import json
from pathlib import Path
import sqlite3
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from PIL import Image
from backend.store import Store, now, uid
from backend.generation import Generation, MODEL
from backend.backups import (
    create_backup,
    restore_backup,
    validate_archive,
    recover_restore,
)
from conftest import make_pdf


def edit(client, doc, slide, kind="personal", body="My durable notes", revision=0):
    return client.put(
        f"/api/slides/{slide['id']}/notes/{kind}",
        json={"body": body, "revision": revision, "epoch": doc["epoch"]},
    )


def test_import_order_images_and_original(client, imported):
    notebook, doc = imported
    assert [s["page_number"] for s in doc["slides"]] == [1, 2]
    assert doc["slides"][0]["width"] > doc["slides"][0]["height"]
    assert doc["slides"][1]["width"] < doc["slides"][1]["height"]
    assert (
        client.get(f"/api/slides/{doc['slides'][0]['id']}/image").headers[
            "content-type"
        ]
        == "image/png"
    )
    assert client.get(f"/api/documents/{doc['id']}/original").content.startswith(
        b"%PDF-"
    )
    text = client.app.state.store.one(
        "SELECT text FROM slides WHERE id=?", (doc["slides"][0]["id"],)
    )["text"]
    assert "Concurrent Access" in text


@pytest.mark.parametrize(
    "data", [b"garbage", b"%PDF-1.7\nbroken", make_pdf(encrypted=True)]
)
def test_invalid_pdf_publishes_nothing(client, data):
    notebook = client.post("/api/notebooks", json={"name": "Test"}).json()
    response = client.post(
        f"/api/notebooks/{notebook['id']}/import", files={"file": ("bad.pdf", data)}
    )
    assert response.status_code == 400
    assert client.get("/api/library").json()["documents"] == []
    assert list(client.app.state.store.assets.iterdir()) == []
    assert list(client.app.state.store.root.glob(".import-*")) == []


def test_scanned_pdf(client):
    image = Image.new("RGB", (500, 700), "white")
    data = io.BytesIO()
    image.save(data, format="PDF")
    notebook = client.post("/api/notebooks", json={"name": "Scan"}).json()
    response = client.post(
        f"/api/notebooks/{notebook['id']}/import",
        files={"file": ("scan.pdf", data.getvalue())},
    )
    assert response.status_code == 200
    assert client.app.state.store.rows("SELECT text FROM slides")[0]["text"] == ""


def test_revision_conflict_history_and_restart(client, imported):
    _, doc = imported
    s = doc["slides"][0]
    first = edit(client, doc, s)
    assert first.status_code == 200
    conflict = edit(client, doc, s, body="A stale browser tab")
    assert (
        conflict.status_code == 409
        and conflict.json()["current"]["body"] == "My durable notes"
    )
    assert edit(client, doc, s, body="Second version", revision=1).status_code == 200
    versions = client.get(f"/api/slides/{s['id']}/notes/personal/history").json()
    assert len(versions) == 2
    restored = client.post(
        f"/api/versions/{versions[-1]['id']}/restore",
        json={"revision": 2, "epoch": doc["epoch"]},
    )
    assert restored.json()["body"] == "My durable notes"
    reopened = Store(client.app.state.store.root)
    assert reopened.note(s["id"], "personal")["body"] == "My durable notes"
    with reopened.connect() as db:
        assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert db.execute("PRAGMA synchronous").fetchone()[0] == 2


def test_trash_restores_notebook_and_notes(client, imported):
    notebook, doc = imported
    edit(client, doc, doc["slides"][0])
    assert client.delete(f"/api/notebooks/{notebook['id']}").status_code == 200
    assert client.get("/api/library").json()["notebooks"][0]["deleted_at"]
    assert client.post(f"/api/notebooks/{notebook['id']}/untrash").status_code == 200
    assert (
        client.get(f"/api/documents/{doc['id']}").json()["slides"][0]["personal"][
            "body"
        ]
        == "My durable notes"
    )
    client.delete(f"/api/documents/{doc['id']}")
    client.post(f"/api/documents/{doc['id']}/untrash")
    assert not client.get("/api/library").json()["documents"][0]["deleted_at"]


def fake_client(text="## Main idea\n\nTwo threads share a balance."):
    response = SimpleNamespace(
        status="completed",
        output_text=text,
        usage=SimpleNamespace(
            model_dump=lambda: {"input_tokens": 100, "output_tokens": 200}
        ),
    )
    return SimpleNamespace(
        responses=SimpleNamespace(create=AsyncMock(return_value=response))
    )


def test_queue_duplicate_and_completed_metadata(client, imported):
    _, doc = imported
    store = client.app.state.store
    mock = fake_client()
    gen = Generation(store, mock)
    assert len(gen.enqueue(doc["id"], [], "all", "high")) == 2
    assert gen.enqueue(doc["id"], [], "all", "high") == []
    job = gen.claim()
    asyncio.run(gen.run_job(job))
    assert (
        store.one("SELECT status FROM jobs WHERE id=?", (job["id"],))["status"]
        == "completed"
    )
    version = store.one(
        "SELECT * FROM note_versions WHERE slide_id=?", (job["slide_id"],)
    )
    assert version["model"] == MODEL and version["reasoning"] == "high"
    assert json.loads(version["usage"])["output_tokens"] == 200
    call = mock.responses.create.call_args.kwargs
    assert call["store"] is False and call["reasoning"] == {"effort": "high"}
    assert call["input"][0]["content"][1]["image_url"].startswith(
        "data:image/png;base64,"
    )
    assert "Adjacent slide 2" in call["input"][0]["content"][0]["text"]


def test_generation_keeps_edits_in_flight(client, imported):
    _, doc = imported
    store = client.app.state.store
    gen = Generation(store, fake_client())
    gen.enqueue(doc["id"], [doc["slides"][0]["id"]], "selected", "high")
    job = gen.claim()
    edit(client, doc, doc["slides"][0], kind="explanation", body="My own explanation")
    edit(client, doc, doc["slides"][0], body="My personal note")
    asyncio.run(gen.run_job(job))
    assert store.note(job["slide_id"], "explanation")["body"] == "My own explanation"
    assert store.note(job["slide_id"], "personal")["body"] == "My personal note"
    assert (
        len(
            store.rows(
                "SELECT * FROM note_versions WHERE slide_id=? AND kind=?",
                (job["slide_id"], "explanation"),
            )
        )
        == 2
    )


def test_interrupted_queue_pause_cancel_and_retry(client, imported):
    _, doc = imported
    store = client.app.state.store
    gen = Generation(store, fake_client())
    gen.enqueue(doc["id"], [], "all", "medium")
    client.post("/api/queue/pause")
    assert gen.claim() is None
    client.post("/api/queue/resume")
    job = gen.claim()
    reopened = Store(store.root)
    assert (
        reopened.one("SELECT status FROM jobs WHERE id=?", (job["id"],))["status"]
        == "interrupted"
    )
    assert len(gen.enqueue(doc["id"], [], "failed", "high")) == 1
    client.post("/api/queue/cancel")
    assert not store.rows("SELECT id FROM jobs WHERE status IN ('queued','running')")
    # A late HTTP result cannot resurrect a cancelled job.
    asyncio.run(gen.run_job(job))
    assert store.note(job["slide_id"], "explanation")["body"] == ""


def test_failure_does_not_erase_notes(client, imported):
    _, doc = imported
    store = client.app.state.store
    edit(client, doc, doc["slides"][0], kind="explanation", body="Keep me")
    mock = fake_client()
    mock.responses.create.side_effect = ValueError("Temporary test failure")
    gen = Generation(store, mock)
    gen.enqueue(doc["id"], [doc["slides"][0]["id"]], "selected", "xhigh")
    job = gen.claim()
    asyncio.run(gen.run_job(job))
    assert (
        store.one("SELECT status FROM jobs WHERE id=?", (job["id"],))["status"]
        == "failed"
    )
    assert store.note(job["slide_id"], "explanation")["body"] == "Keep me"


def test_two_worker_limit(client, imported):
    notebook, doc = imported
    store = client.app.state.store
    r = client.post(
        f"/api/notebooks/{notebook['id']}/import",
        files={"file": ("three.pdf", make_pdf(3))},
    )
    mock = fake_client()
    gen = Generation(store, mock)
    gen.enqueue(r.json()["id"], [], "all", "high")
    active = 0
    max_active = 0
    response = mock.responses.create.return_value

    async def slow(**kwargs):
        nonlocal active, max_active
        active += 1
        max_active = max(active, max_active)
        await asyncio.sleep(0.05)
        active -= 1
        return response

    mock.responses.create.side_effect = slow

    async def execute():
        gen.start()
        for _ in range(100):
            if len(store.rows("SELECT id FROM jobs WHERE status='completed'")) == 3:
                break
            await asyncio.sleep(0.02)
        await gen.stop()

    asyncio.run(execute())
    assert max_active == 2
    assert len(store.rows("SELECT id FROM jobs WHERE status='completed'")) == 3


def test_backup_restore_into_clean_library_and_epoch(client, imported, tmp_path):
    _, doc = imported
    store = client.app.state.store
    s = doc["slides"][0]
    edit(client, doc, s)
    edit(client, doc, s, kind="explanation", body="Saved explanation")
    archive = create_backup(store)
    clean = Store(tmp_path / "clean")
    restore_backup(clean, archive)
    assert clean.note(s["id"], "personal")["body"] == "My durable notes"
    assert clean.note(s["id"], "explanation")["body"] == "Saved explanation"
    assert (clean.assets / doc["id"] / "original.pdf").read_bytes() == (
        store.assets / doc["id"] / "original.pdf"
    ).read_bytes()
    assert len(clean.rows("SELECT * FROM note_versions")) == 2
    assert clean.setting("queue_paused") is True
    assert list(clean.backups.glob("safety-*.zip"))
    assert "OPENAI_API_KEY" not in zipfile.ZipFile(archive).namelist()
    response = client.post(
        "/api/restore", files={"file": ("backup.zip", archive.read_bytes())}
    )
    assert response.status_code == 200, response.text
    assert (
        edit(client, doc, s, body="Stale pre-restore tab", revision=1).status_code
        == 409
    )


def test_corrupt_and_unsafe_backup_rejected_without_changes(client, imported, tmp_path):
    _, doc = imported
    store = client.app.state.store
    archive = create_backup(store)
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(bad, "w") as target:
        for name in source.namelist():
            target.writestr(
                name, b"corruption" if name == "notes.sqlite3" else source.read(name)
            )
    with pytest.raises(ValueError, match="checksum"):
        restore_backup(store, bad)
    assert store.one("SELECT id FROM documents")["id"] == doc["id"]
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr(
            "manifest.json",
            json.dumps({"format": 1, "files": {"notes.sqlite3": "", "../escape": ""}}),
        )
        z.writestr("notes.sqlite3", b"")
        z.writestr("../escape", b"")
    with pytest.raises(ValueError):
        restore_backup(store, bad)
    assert not (tmp_path / "escape").exists()


def test_restore_crash_rolls_back(client, imported):
    _, doc = imported
    store = client.app.state.store
    with store.connect() as db:
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    old = store.root / ".restore-old"
    old.mkdir()
    store.db_path.rename(old / "notes.sqlite3")
    store.assets.rename(old / "assets")
    store.db_path.write_bytes(b"incomplete replacement")
    (store.root / ".restore-journal.json").write_text("{}")
    recover_restore(store.root)
    assert store.one("SELECT id FROM documents")["id"] == doc["id"]
    assert (store.assets / doc["id"] / "1.png").is_file()


def test_secondary_backup_failure_reported(client, imported, tmp_path):
    store = client.app.state.store
    store.set_setting("backup_folder", str(tmp_path / "disconnected-drive"))
    path = create_backup(store)
    assert path.is_file() and store.setting("last_backup")
    assert "second backup folder" in store.setting("backup_error")


def test_restore_refuses_running_generation(client, imported):
    _, doc = imported
    store = client.app.state.store
    archive = create_backup(store)
    gen = Generation(store, fake_client())
    gen.enqueue(doc["id"], [], "all", "high")
    gen.claim()
    with pytest.raises(ValueError, match="Pause generation"):
        restore_backup(store, archive)


def test_local_request_boundary_and_missing_key(client, imported):
    _, doc = imported
    assert (
        client.post(
            "/api/notebooks",
            json={"name": "Bad"},
            headers={"Origin": "https://evil.example"},
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/api/notebooks", json={"name": "Bad"}, headers={"X-Slide-Notes": ""}
        ).status_code
        == 403
    )
    assert (
        client.get("/api/status", headers={"Host": "evil.example"}).status_code == 400
    )
    response = client.post(f"/api/documents/{doc['id']}/generate", json={"mode": "all"})
    assert response.status_code == 400 and "OPENAI_API_KEY" in response.json()["detail"]


def test_import_render_failure_rolls_back(client, monkeypatch):
    import backend.importer as importer

    notebook = client.post("/api/notebooks", json={"name": "Import failure"}).json()

    def fail(*args, **kwargs):
        raise RuntimeError("simulated render failure")

    monkeypatch.setattr(importer.pdfium, "PdfDocument", fail)
    response = client.post(
        f"/api/notebooks/{notebook['id']}/import",
        files={"file": ("valid.pdf", make_pdf())},
    )
    assert response.status_code == 400
    assert client.app.state.store.rows("SELECT * FROM documents") == []
    assert list(client.app.state.store.assets.iterdir()) == []


def test_rate_limit_retries_and_incomplete_response(client, imported, monkeypatch):
    import httpx
    from openai import RateLimitError

    _, doc = imported
    store = client.app.state.store
    mock = fake_client()
    gen = Generation(store, mock)
    request = httpx.Request("POST", "https://api.openai.com/v1/responses")
    limit = RateLimitError(
        "rate limited", response=httpx.Response(429, request=request), body=None
    )
    response = mock.responses.create.return_value
    mock.responses.create.side_effect = [limit, limit, response]
    monkeypatch.setattr("backend.generation.asyncio.sleep", AsyncMock())
    gen.enqueue(doc["id"], [doc["slides"][0]["id"]], "selected", "high")
    job = gen.claim()
    asyncio.run(gen.run_job(job))
    assert mock.responses.create.await_count == 3
    assert (
        store.one("SELECT status FROM jobs WHERE id=?", (job["id"],))["status"]
        == "completed"
    )
    mock.responses.create.side_effect = None
    mock.responses.create.return_value = SimpleNamespace(
        status="incomplete", output_text="Partial answer", usage=None
    )
    gen.enqueue(doc["id"], [doc["slides"][0]["id"]], "selected", "high")
    job = gen.claim()
    asyncio.run(gen.run_job(job))
    assert (
        store.one("SELECT status FROM jobs WHERE id=?", (job["id"],))["status"]
        == "failed"
    )
    assert store.note(job["slide_id"], "explanation")["body"] == response.output_text


def test_exclusive_process_lock(tmp_path):
    from backend.app import exclusive_root

    with exclusive_root(tmp_path):
        with pytest.raises(RuntimeError, match="already running"):
            with exclusive_root(tmp_path):
                pass
    with exclusive_root(tmp_path):
        pass


def test_backup_retention(tmp_path):
    from datetime import datetime, timedelta
    from backend.backups import prune

    start = datetime(2026, 10, 3, 12, 0, 0)
    for i in range(45):
        dt = start - timedelta(days=i)
        (tmp_path / f"backup-{dt.strftime('%Y%m%dT%H%M%S%fZ')}.zip").touch()
    prune(tmp_path)
    files = sorted(tmp_path.glob("backup-*.zip"))
    assert 7 <= len(files) <= 11
    for i in range(7):
        dt = start - timedelta(days=i)
        assert (tmp_path / f"backup-{dt.strftime('%Y%m%dT%H%M%S%fZ')}.zip").exists()


def test_details_are_separate_durable_and_backed_up(client, imported, tmp_path):
    _, doc = imported
    slide = doc['slides'][0]
    store = client.app.state.store
    edit(client, doc, slide, body='Personal thought')
    edit(client, doc, slide, kind='explanation', body='Short explanation')
    mock = fake_client()
    gen = Generation(store, mock)
    assert gen.enqueue(doc['id'], [slide['id']], 'selected', 'high', 'detail')
    assert gen.enqueue(doc['id'], [slide['id']], 'selected', 'high', 'detail') == []
    job = gen.claim()
    asyncio.run(gen.run_job(job))
    assert store.note(slide['id'], 'detail')['body']
    assert store.note(slide['id'], 'explanation')['body'] == 'Short explanation'
    assert store.note(slide['id'], 'personal')['body'] == 'Personal thought'
    call = mock.responses.create.call_args.kwargs
    assert '600–1000' in call['instructions']
    assert 'Short explanation' in call['input'][0]['content'][0]['text']
    assert edit(client, doc, slide, kind='detail', body='Edited details', revision=1).status_code == 200
    assert edit(client, doc, slide, kind='detail', body='Stale tab', revision=1).status_code == 409
    archive = create_backup(store)
    with zipfile.ZipFile(archive) as z:
        assert f"assets/{doc['id']}/original.pdf" in z.namelist()
        readable = z.read(f"exports/{doc['id']}/notes.md").decode()
        assert all(text in readable for text in ['Short explanation', 'Personal thought', 'Edited details'])
    clean = Store(tmp_path / 'detail-restore')
    restore_backup(clean, archive)
    assert clean.note(slide['id'], 'detail')['body'] == 'Edited details'
    assert len(clean.rows("SELECT * FROM note_versions WHERE kind='detail'")) == 2
    restarted = Store(clean.root)
    assert restarted.note(slide['id'], 'detail')['body'] == 'Edited details'


def test_v1_migration_preserves_notes_and_jobs(tmp_path):
    from backend.store import SCHEMA
    root = tmp_path / 'legacy'
    root.mkdir()
    with sqlite3.connect(root / 'notes.sqlite3') as db:
        db.executescript(SCHEMA)
        db.execute('PRAGMA user_version=1')
        db.execute('INSERT INTO schema_migrations VALUES (1,?)', (now(),))
        db.execute('INSERT INTO notebooks VALUES (?,?,?,NULL)', ('n', 'Legacy', now()))
        db.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,?,NULL)', ('d', 'n', 'PDF', 'a.pdf', 'hash', 1, now()))
        db.execute('INSERT INTO slides VALUES (?,?,?,?,?,?)', ('s', 'd', 1, 'text', 800, 600))
        db.execute('INSERT INTO notes VALUES (?,?,?,?,?)', ('s', 'personal', 'Keep me', 4, now()))
        db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)', ('j', 's', 'completed', 'high', 0, 1, None, now(), now()))
    store = Store(root)
    assert store.note('s', 'personal')['body'] == 'Keep me'
    assert store.note('s', 'personal')['revision'] == 4
    assert store.note('s', 'detail')['body'] == ''
    assert store.one('SELECT kind FROM jobs')['kind'] == 'explanation'
    assert store.one('PRAGMA user_version')['user_version'] == 5


def test_legacy_backup_restores_and_migrates(client, imported, tmp_path):
    from backend.store import sha256
    _, doc = imported
    slide = doc['slides'][0]
    edit(client, doc, slide, body='Legacy personal note')
    current = create_backup(client.app.state.store)
    stage=tmp_path/'legacy-stage'
    stage.mkdir()
    with zipfile.ZipFile(current) as z:
        z.extractall(stage)
    with sqlite3.connect(stage/'notes.sqlite3') as db:
        db.execute('DROP TABLE chat_clips')
        db.execute('DROP TABLE chat_turns')
        db.execute('DELETE FROM schema_migrations WHERE version=4')
        db.execute('DROP TABLE annotations')
        db.execute('DELETE FROM schema_migrations WHERE version=3')
        db.execute("DELETE FROM notes WHERE kind='detail'")
        db.execute('DROP INDEX one_active_job')
        db.execute('ALTER TABLE jobs DROP COLUMN kind')
        db.execute("CREATE UNIQUE INDEX one_active_job ON jobs(slide_id) WHERE status IN ('queued','running')")
        db.execute('DELETE FROM schema_migrations WHERE version=2')
        db.execute('PRAGMA user_version=1')
    db.close()
    manifest=json.loads((stage/'manifest.json').read_text())
    manifest['files']['notes.sqlite3']=sha256(stage/'notes.sqlite3')
    (stage/'manifest.json').write_text(json.dumps(manifest))
    legacy=tmp_path/'legacy.zip'
    with zipfile.ZipFile(legacy,'w') as z:
        for path in stage.rglob('*'):
            if path.is_file(): z.write(path,path.relative_to(stage))
    target=Store(tmp_path/'legacy-restored')
    restore_backup(target,legacy)
    assert target.note(slide['id'],'personal')['body']=='Legacy personal note'
    assert target.note(slide['id'],'detail')['revision']==0
    assert target.one('PRAGMA user_version')['user_version']==5


def test_details_take_next_slot_before_bulk_without_interrupting(client, imported):
    _, doc = imported
    gen = Generation(client.app.state.store, fake_client())
    gen.enqueue(doc['id'], [], 'all', 'high')
    running_bulk = gen.claim()
    ids = [s['id'] for s in doc['slides']]
    first = gen.enqueue(doc['id'], [ids[0]], 'selected', 'high', 'detail')[0]
    second = gen.enqueue(doc['id'], [ids[1]], 'selected', 'high', 'detail')[0]
    assert gen.claim()['id'] == first
    assert gen.claim()['id'] == second
    assert gen.claim()['kind'] == 'explanation'
    assert gen.store.one('SELECT status FROM jobs WHERE id=?', (running_bulk['id'],))['status'] == 'running'


def test_annotations_persist_restore_and_do_not_change_notes(client, imported, tmp_path):
    _,doc=imported
    slide=doc['slides'][0]
    edit(client,doc,slide,kind='explanation',body='Important **shared data** needs a lock.')
    path=f"/api/slides/{slide['id']}/notes/explanation/annotations"
    payload={'revision':1,'epoch':doc['epoch'],'start':10,'end':21,'quote':'shared data','style':'highlight','color':'yellow'}
    response=client.post(path,json=payload)
    assert response.status_code==200,response.text
    assert len(response.json())==1
    payload['color']='blue'
    assert len(client.post(path,json=payload).json())==1
    payload['style']='underline'
    assert len(client.post(path,json=payload).json())==2
    store=client.app.state.store
    assert store.note(slide['id'],'explanation')['revision']==1
    backup=create_backup(store)
    clean=Store(tmp_path/'annotations-restored')
    restore_backup(clean,backup)
    assert len(clean.rows('SELECT * FROM annotations'))==2
    with zipfile.ZipFile(backup) as z:
        assert 'highlight (blue)' in z.read(f"exports/{doc['id']}/notes.md").decode()
    # An edited body does not inherit unrelated old offsets, but restoring the
    # original content brings its marks back (including after backend restart).
    original=store.rows("SELECT * FROM note_versions WHERE kind='explanation'")[0]
    edit(client,doc,slide,kind='explanation',body='Different explanation',revision=1)
    assert client.get(path,params={'revision':2,'epoch_id':doc['epoch']}).json()==[]
    assert client.post(path,json=payload).status_code==409
    client.post(f"/api/versions/{original['id']}/restore",json={'revision':2,'epoch':doc['epoch']}).raise_for_status()
    assert len(client.get(path,params={'revision':3,'epoch_id':doc['epoch']}).json())==2
    payload.update(revision=3,action='clear')
    assert client.post(path,json=payload).json()==[]


def test_annotation_guards_and_unicode_offsets(client, imported):
    _,doc=imported
    slide=doc['slides'][0]
    edit(client,doc,slide,kind='detail',body='A 🧠 example')
    path=f"/api/slides/{slide['id']}/notes/detail/annotations"
    data={'revision':1,'epoch':doc['epoch'],'start':2,'end':4,'quote':'🧠','style':'underline'}
    assert client.post(path,json=data).status_code==200
    assert client.post(path,json={**data,'end':3}).status_code==400
    assert client.post(path,json={**data,'color':'javascript:bad'}).status_code==422
    assert client.post(path,json={**data,'epoch':'stale'}).status_code==409
    assert client.get(path,params={'revision':1,'epoch_id':'stale'}).status_code==409


def test_v2_library_migrates_without_losing_details_or_versions(client, imported, tmp_path):
    _,doc=imported
    slide=doc['slides'][0]
    edit(client,doc,slide,kind='detail',body='Saved deeper explanation')
    root=tmp_path/'v2-library'
    root.mkdir()
    with client.app.state.store.connect() as source:
        target=sqlite3.connect(root/'notes.sqlite3')
        source.backup(target)
        target.execute('DROP TABLE chat_clips')
        target.execute('DROP TABLE chat_turns')
        target.execute('DELETE FROM schema_migrations WHERE version=4')
        target.execute('DROP TABLE annotations')
        target.execute('DELETE FROM schema_migrations WHERE version=3')
        target.execute('PRAGMA user_version=2')
        target.commit();target.close()
    upgraded=Store(root)
    assert upgraded.note(slide['id'],'detail')['body']=='Saved deeper explanation'
    assert upgraded.rows("SELECT body FROM note_versions WHERE kind='detail'")[0]['body']=='Saved deeper explanation'
    assert upgraded.rows('SELECT * FROM annotations')==[]



def test_chat_context_saved_answer_and_idempotent_note_append(client, imported, monkeypatch, tmp_path):
    _,doc=imported
    slide=doc['slides'][0]
    monkeypatch.setenv('OPENAI_API_KEY','test-placeholder')
    ident=uid()
    data={'id':ident,'question':'Why does this happen?','epoch':doc['epoch'],'reasoning':'high'}
    path=f"/api/slides/{slide['id']}/chat"
    assert client.post(path,json=data).status_code==200
    assert client.post(path,json=data).status_code==200
    assert client.post(path,json={**data,'id':uid()}).status_code==409
    mock=fake_client()
    gen=Generation(client.app.state.store,mock)
    gen.enqueue(doc['id'],[],'all','high')
    job=gen.claim()
    assert job['kind']=='chat'
    asyncio.run(gen.run_chat(job))
    answer=client.get(path).json()[0]
    assert answer['status']=='completed' and answer['answer']
    assert 'Why does this happen?'==mock.responses.create.call_args.kwargs['input'][-1]['content']
    assert json.loads(answer['metadata'])['prompt_version']=='slide-chat-v1'
    edit(client,doc,slide,body='Keep my existing notes')
    payload={'id':uid(),'text':'Useful answer excerpt','revision':1,'epoch':doc['epoch']}
    clipped=client.post(f'/api/chat/{ident}/notes',json=payload)
    assert clipped.status_code==200
    assert clipped.json()['body']=='Keep my existing notes\n\nUseful answer excerpt'
    assert client.post(f'/api/chat/{ident}/notes',json=payload).json()['revision']==2
    assert client.post(f'/api/chat/{ident}/notes',json={**payload,'id':uid()}).status_code==409
    archive=create_backup(client.app.state.store)
    clean=Store(tmp_path/'chat-restored')
    restore_backup(clean,archive)
    assert clean.one('SELECT answer FROM chat_turns')['answer']==answer['answer']
    assert clean.note(slide['id'],'personal')['body']==clipped.json()['body']


def test_chat_restart_marks_running_interrupted(client, imported, monkeypatch):
    _,doc=imported
    slide=doc['slides'][0]
    monkeypatch.setenv('OPENAI_API_KEY','test-placeholder')
    turn=client.post(f"/api/slides/{slide['id']}/chat",json={'id':uid(),'question':'Explain this','epoch':doc['epoch']}).json()
    gen=Generation(client.app.state.store,fake_client())
    assert gen.claim()['id']==turn['id']
    restarted=Store(client.app.state.store.root)
    assert restarted.one('SELECT status FROM chat_turns')['status']=='interrupted'
    assert client.post(f"/api/chat/{turn['id']}/retry",json={'epoch':doc['epoch'],'revision':0}).json()['status']=='queued'


def test_rebrand_keeps_existing_library_and_accepts_new_directory_setting(tmp_path, monkeypatch):
    from backend.store import default_root
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.delenv('SLIDE_NOTES_DATA_DIR', raising=False)
    monkeypatch.delenv('SLIDE_EXPLAIN_DATA_DIR', raising=False)
    support=tmp_path/'Library/Application Support'
    assert default_root()==support/'Slide Explain'
    old=support/'Slide Notes'
    old.mkdir(parents=True)
    (old/'config.env').write_text('OPENAI_API_KEY=test-placeholder')
    assert default_root()==old
    monkeypatch.setenv('SLIDE_NOTES_DATA_DIR', str(tmp_path/'legacy-override'))
    assert default_root()==tmp_path/'legacy-override'
    monkeypatch.setenv('SLIDE_EXPLAIN_DATA_DIR', str(tmp_path/'new-override'))
    assert default_root()==tmp_path/'new-override'


def test_lengths_and_accept_long_preserve_history_and_marks(client, imported, tmp_path):
    _,doc=imported
    slide=doc['slides'][0];store=client.app.state.store
    mock=fake_client();gen=Generation(store,mock)
    job_id=gen.enqueue(doc['id'],[slide['id']],'selected','high')[0]
    assert store.one('SELECT length FROM jobs WHERE id=?',(job_id,))['length']=='brief'
    asyncio.run(gen.run_job(gen.claim()))
    assert '80–180' in mock.responses.create.call_args.kwargs['instructions']
    edit(client,doc,slide,kind='detail',body='Important long explanation')
    mark={'revision':1,'epoch':doc['epoch'],'start':0,'end':9,'quote':'Important','style':'highlight','color':'pink'}
    client.post(f"/api/slides/{slide['id']}/notes/detail/annotations",json=mark).raise_for_status()
    payload={'epoch':doc['epoch'],'revision':1,'detail_revision':1}
    result=client.post(f"/api/slides/{slide['id']}/use-detail",json=payload)
    result.raise_for_status()
    assert result.json()['body']=='Important long explanation'
    assert store.note(slide['id'],'personal')['body']==''
    assert len(store.rows("SELECT * FROM note_versions WHERE kind='explanation'"))==2
    assert client.post(f"/api/slides/{slide['id']}/use-detail",json=payload).status_code==409
    clean=Store(tmp_path/'accepted-restore');restore_backup(clean,create_backup(store))
    assert clean.note(slide['id'],'explanation')['body']=='Important long explanation'
    assert clean.one("SELECT quote,color FROM annotations WHERE kind='explanation'")=={'quote':'Important','color':'pink'}
    for length,target in [('medium','200–500'),('long','600–1000')]:
        gen.enqueue(doc['id'],[slide['id']],'selected','high',length=length)
        asyncio.run(gen.run_job(gen.claim()))
        assert target in mock.responses.create.call_args.kwargs['instructions']


def test_interface_entrypoint_is_never_cached(client):
    for url in ['/', '/index.html', '/?launch=new-build']:
        assert client.get(url).headers['cache-control'] == 'no-store'


def test_reading_position_survives_restart_and_backup(client, imported, tmp_path):
    _,doc=imported
    path=f"/api/documents/{doc['id']}/reading-position"
    assert client.get(path).json() is None
    body={'epoch':doc['epoch'],'page':2,'fraction':0.45}
    client.put(path,json=body).raise_for_status()
    assert client.get(path).json()=={'page':2,'fraction':0.45}
    assert client.get('/api/status').json()['last_document']==doc['id']
    assert client.put(path,json={**body,'epoch':'stale'}).status_code==409
    assert client.put(path,json={**body,'fraction':2}).status_code==422
    assert client.put(path,json={**body,'page':499}).status_code==404
    store=client.app.state.store
    restarted=Store(store.root)
    assert restarted.setting('reading:'+doc['id'])=={'page':2,'fraction':0.45}
    restored=Store(tmp_path/'reading-restored');restore_backup(restored,create_backup(store))
    assert restored.setting('reading:'+doc['id'])=={'page':2,'fraction':0.45}
