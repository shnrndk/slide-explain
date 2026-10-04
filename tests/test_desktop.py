import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from desktop.runtime import Backend, existing_backend, save_key


def test_private_key_is_atomic_and_not_in_database(tmp_path):
    save_key('sk-test-only', tmp_path)
    target = tmp_path / 'config.env'
    assert target.read_text() == 'OPENAI_API_KEY=sk-test-only\n'
    assert target.stat().st_mode & 0o777 == 0o600
    save_key('sk-replaced-test', tmp_path)
    assert target.read_text() == 'OPENAI_API_KEY=sk-replaced-test\n'
    assert list(tmp_path.iterdir()) == [target]
    with pytest.raises(ValueError):
        save_key('sk-key\nOTHER=bad', tmp_path)
    assert target.read_text() == 'OPENAI_API_KEY=sk-replaced-test\n'


def test_reuse_requires_correct_library_and_service(tmp_path, monkeypatch):
    def response(path, base):
        if path == '/api/status':
            return {'data_dir': str(tmp_path)}
        return {'info': {'title': 'Slide Explain'}}
    monkeypatch.setattr('desktop.runtime.read_json', response)
    assert existing_backend(tmp_path)
    assert existing_backend(tmp_path / 'different-library') is None
    monkeypatch.setattr('desktop.runtime.read_json', lambda *a: {'info': {'title': 'Other app'}})
    assert existing_backend(tmp_path) is None


def test_external_backend_is_not_stopped(tmp_path, monkeypatch):
    monkeypatch.setattr('desktop.runtime.existing_backend', lambda *a: {'data_dir': str(tmp_path), 'api_version': 5})
    backend = Backend(tmp_path)
    backend.start()
    assert not backend.owned
    backend.stop()
    assert backend.thread is None


def test_owned_backend_shuts_down():
    backend = Backend()
    backend.server = Mock()
    backend.thread = Mock()
    backend.stop()
    assert backend.server.should_exit is True
    backend.thread.join.assert_called_once_with(timeout=15)
