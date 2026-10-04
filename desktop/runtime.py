"""Backend ownership and private configuration, independent of the native UI."""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
from urllib.request import build_opener, ProxyHandler

from backend.store import default_root

URL = "http://127.0.0.1:8000"


def save_key(key: str, root: Path | None = None):
    key = key.strip()
    if not key or any(c.isspace() for c in key) or len(key) > 1024:
        raise ValueError("Enter a valid API key without spaces or line breaks.")
    root = root or default_root()
    root.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".config-", dir=root)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(f"OPENAI_API_KEY={key}\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, root / "config.env")
        directory = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path: str, base: str = URL):
    # Loopback traffic must never go through a system HTTP proxy.
    with build_opener(ProxyHandler({})).open(base + path, timeout=2) as response:
        return json.load(response)


def existing_backend(root: Path, base: str = URL):
    try:
        status = read_json("/api/status", base)
        schema = read_json("/openapi.json", base)
        if schema.get("info", {}).get("title") not in {"Slide Explain", "Slide Notes"}:
            raise ValueError()
        if Path(status["data_dir"]).resolve() != root.resolve():
            raise ValueError()
        return status
    except Exception:
        return None


class Backend:
    def __init__(self, root: Path | None = None, port: int = 8000):
        self.root = root or default_root()
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.server = None
        self.thread = None
        self.failure = False

    @property
    def owned(self):
        return self.server is not None

    def start(self):
        existing = existing_backend(self.root, self.url)
        if existing:
            if existing.get("api_version", 1) < 7:
                raise RuntimeError("An older Slide Explain backend is running. Let current explanations finish, then restart its terminal or app before opening this version.")
            return
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", self.port)) == 0:
                raise RuntimeError(
                    f"Port {self.port} is being used by another application or another Slide Explain library. "
                    "Close that application, then reopen Slide Explain."
                )
        import uvicorn
        from backend.app import create_app
        self.server = uvicorn.Server(uvicorn.Config(
            create_app(self.root), host="127.0.0.1", port=self.port,
            access_log=False, log_level="error", log_config=None,
        ))

        def serve():
            try:
                self.server.run()
            except BaseException:
                self.failure = True

        self.thread = threading.Thread(target=serve, name="slide-notes-backend", daemon=True)
        self.thread.start()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.failure or not self.thread.is_alive():
                break
            if self.server.started and existing_backend(self.root, self.url):
                return
            time.sleep(.1)
        self.stop()
        raise RuntimeError("The notebook service could not start. Another Slide Explain instance may already have this library open.")

    def stop(self):
        if self.server:
            self.server.should_exit = True
            if self.thread:
                self.thread.join(timeout=15)
