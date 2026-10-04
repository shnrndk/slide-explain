"""One paid API request against a disposable fixture library; never touches user notes."""

import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))
from dotenv import load_dotenv
from conftest import make_pdf
from backend.store import Store, now, uid
from backend.importer import import_pdf
from backend.generation import Generation

load_dotenv(Path(__file__).resolve().parents[1] / ".env")


async def main():
    if not os.environ.get("OPENAI_API_KEY"):
        print("Skipped: OPENAI_API_KEY is not configured. No API request was sent.")
        return
    with tempfile.TemporaryDirectory(prefix="slide-notes-smoke-") as temp:
        store = Store(Path(temp))
        notebook = uid()
        with store.connect() as db:
            db.execute(
                "INSERT INTO notebooks VALUES (?,?,?,NULL)",
                (notebook, "Smoke test", now()),
            )
        doc = import_pdf(store, notebook, "test.pdf", make_pdf(1))
        generation = Generation(store)
        generation.enqueue(doc["id"], [], "all", "high")
        job = generation.claim()
        await generation.run_job(job)
        result = store.one("SELECT status,error FROM jobs WHERE id=?", (job["id"],))
        await generation.stop()
        if result["status"] != "completed":
            raise SystemExit(f"Smoke test failed: {result['error']}")
        version = store.one(
            "SELECT model,reasoning,usage FROM note_versions WHERE origin='generation'"
        )
        print("Live generation passed.")
        print(json.dumps(version, indent=2))


asyncio.run(main())
