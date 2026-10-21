"""The ``itaja`` command reads ``.env`` / ``.env.local``, so nothing has to be exported.

HOW IT CAN FAIL (written before the code)

V1. ``.env`` is not read: ``itaja push`` says "no API key" although ``.env`` has one.
V2. ``.env.local`` does not override ``.env`` (a developer's local key is ignored).
V3. A file overrides a variable set in the shell or in CI (CI pushes with the wrong key).
V4. ``trigger`` signs with another secret than the one in ``.env``.
V5. Quotes and comments in ``.env`` end up in the value.
V6. A non-interactive ``push`` (CI) applies without ``--yes``.
V7. ``status`` exits 0 when Itaja differs from the code.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

from itaja import construct_event
from itaja.cli import load_env_files, main

CONFIG = """
import os
from itaja import create_itaja, feature, group, plan

m = feature("messages", "metered")
itaja = create_itaja(
    api_key=os.environ.get("ITAJA_API_KEY"),
    webhook_secret=os.environ.get("ITAJA_WEBHOOK_SECRET"),
    base_url=os.environ.get("ITAJA_API_URL"),
    catalog=[m, plan("Free", group("app", "App"), default=True, includes=[m(limit=1)])],
)
"""


class Stub:
    def __init__(self) -> None:
        self.seen: list[str] = []
        self.changes = 0
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def do_PUT(self) -> None:
                self.rfile.read(int(self.headers.get("content-length") or 0))
                stub.seen.append(f"{'dry' if 'dryRun' in self.path else 'apply'} key={self.headers['x-itj-key']}")
                summary = {"created": stub.changes, "changed": 0, "archived": 0, "unchanged": 1}
                self._json({"success": True, "data": {"summary": summary, "changes": []}})

            def do_POST(self) -> None:
                raw = self.rfile.read(int(self.headers.get("content-length") or 0))
                try:
                    construct_event(raw, dict(self.headers), "whsec_dotenv")
                    stub.seen.append("webhook=verified")
                    self._json({}, 200)
                except Exception:
                    stub.seen.append("webhook=refused")
                    self._json({}, 400)

            def _json(self, data: Any, status: int = 200) -> None:
                body = json.dumps(data).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            protocol_version = "HTTP/1.0"  # one request per connection: nothing left open

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Stub]:
    stub = Stub()
    (tmp_path / "itaja_config.py").write_text(CONFIG)
    (tmp_path / ".env").write_text(
        "# Itaja\n"
        'ITAJA_API_KEY="itjs_from_dotenv"\n'
        "ITAJA_WEBHOOK_SECRET=whsec_dotenv   # signing secret\n"
        "ITAJA_API_URL=http://127.0.0.1:1/api/v1\n"
    )
    (tmp_path / ".env.local").write_text(f"export ITAJA_API_URL='http://127.0.0.1:{stub.port}/api/v1'\n")
    monkeypatch.chdir(tmp_path)
    # Each run imports the project's itaja_config afresh, after .env is loaded.
    monkeypatch.delitem(sys.modules, "itaja_config", raising=False)
    monkeypatch.setattr(sys, "path", [str(tmp_path), *sys.path])
    yield stub
    sys.modules.pop("itaja_config", None)
    stub.server.shutdown()
    stub.server.server_close()
    for name in ("ITAJA_API_KEY", "ITAJA_WEBHOOK_SECRET", "ITAJA_API_URL"):
        os.environ.pop(name, None)


def test_v1_v2_v5_the_key_comes_from_env_the_url_from_env_local(
    project: Stub, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["status"]) == 0
    assert "in sync" in capsys.readouterr().out
    assert project.seen == ["dry key=itjs_from_dotenv"]
    assert os.environ["ITAJA_WEBHOOK_SECRET"] == "whsec_dotenv"


def test_v3_a_variable_set_in_the_shell_wins_over_both_files(project: Stub, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ITAJA_API_KEY", "itjs_from_shell")
    main(["status"])
    assert project.seen == ["dry key=itjs_from_shell"]


def test_v4_trigger_signs_with_the_env_secret(project: Stub) -> None:
    assert main(["trigger", "checkout.paid", "--url", f"http://127.0.0.1:{project.port}/itaja/webhook"]) == 0
    assert project.seen == ["webhook=verified"]


def test_v6_v7_status_fails_on_a_diff_and_push_needs_yes_outside_a_terminal(
    project: Stub, monkeypatch: pytest.MonkeyPatch
) -> None:
    project.changes = 1
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    assert main(["status"]) == 1
    assert main(["push"]) == 1
    assert project.seen == ["dry key=itjs_from_dotenv", "dry key=itjs_from_dotenv"]
    project.seen.clear()
    assert main(["push", "--yes"]) == 0
    assert project.seen == ["dry key=itjs_from_dotenv", "apply key=itjs_from_dotenv"]


def test_load_env_files_never_overrides(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / ".env").write_text("ITAJA_API_KEY=itjs_file\n")
    monkeypatch.setenv("ITAJA_API_KEY", "itjs_shell")
    load_env_files(tmp_path)
    assert os.environ["ITAJA_API_KEY"] == "itjs_shell"
