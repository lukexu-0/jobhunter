from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.request import urlopen

_FIXTURE_DIRECTORY = Path(__file__).resolve().parent
_POSTING_TEMPLATE = (_FIXTURE_DIRECTORY / "posting.html").read_text(encoding="utf-8")
_APPLICATION_HTML = (_FIXTURE_DIRECTORY / "application.html").read_text(encoding="utf-8")


@dataclass(slots=True)
class _SubmissionState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    submit_count: int = 0
    last_submission: dict[str, Any] | None = None
    progress: dict[str, Any] = field(default_factory=dict)

    def submit(self, payload: dict[str, Any]) -> int:
        with self.lock:
            self.submit_count += 1
            self.last_submission = dict(payload)
            return self.submit_count

    def update_progress(self, payload: dict[str, Any]) -> None:
        with self.lock:
            self.progress = dict(payload)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "submit_count": self.submit_count,
                "last_submission": (
                    dict(self.last_submission)
                    if self.last_submission is not None
                    else None
                ),
                "progress": dict(self.progress),
            }


class _FixtureServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


class LocalApplicationFixture:
    """Two isolated loopback origins sharing only a submit counter."""

    def __init__(self) -> None:
        self._state = _SubmissionState()
        self._form_server: _FixtureServer | None = None
        self._posting_server: _FixtureServer | None = None
        self._threads: list[threading.Thread] = []

    @property
    def posting_origin(self) -> str:
        return self._origin(self._posting_server)

    @property
    def form_origin(self) -> str:
        return self._origin(self._form_server)

    @property
    def posting_url(self) -> str:
        return f"{self.posting_origin}/posting"

    @property
    def form_url(self) -> str:
        return f"{self.form_origin}/application"

    @property
    def lookalike_form_origin(self) -> str:
        assert self._form_server is not None
        return f"http://127.0.0.1.evil:{self._form_server.server_port}"

    def start(self) -> LocalApplicationFixture:
        if self._threads:
            raise RuntimeError("fixture servers are already running")
        self._form_server = _FixtureServer(
            ("127.0.0.1", 0),
            self._handler(kind="form"),
        )
        self._posting_server = _FixtureServer(
            ("127.0.0.1", 0),
            self._handler(kind="posting"),
        )
        for name, server in (
            ("fixture-form", self._form_server),
            ("fixture-posting", self._posting_server),
        ):
            thread = threading.Thread(
                name=name,
                target=server.serve_forever,
                kwargs={"poll_interval": 0.05},
                daemon=True,
            )
            thread.start()
            self._threads.append(thread)
        return self

    def close(self) -> None:
        servers = (self._posting_server, self._form_server)
        for server in servers:
            if server is not None:
                server.shutdown()
        for server in servers:
            if server is not None:
                server.server_close()
        for thread in self._threads:
            thread.join(timeout=5)
            if thread.is_alive():
                raise RuntimeError(f"fixture server thread did not stop: {thread.name}")
        self._threads.clear()
        self._posting_server = None
        self._form_server = None

    def __enter__(self) -> LocalApplicationFixture:
        return self.start()

    def __exit__(self, *_: object) -> None:
        self.close()

    def submit_snapshot(self) -> dict[str, Any]:
        with urlopen(f"{self.form_origin}/submit-count", timeout=2) as response:
            return json.loads(response.read().decode("utf-8"))

    def progress_snapshot(self) -> dict[str, Any]:
        with urlopen(f"{self.form_origin}/progress", timeout=2) as response:
            return json.loads(response.read().decode("utf-8"))

    @staticmethod
    def _origin(server: _FixtureServer | None) -> str:
        if server is None:
            raise RuntimeError("fixture servers are not running")
        return f"http://127.0.0.1:{server.server_port}"

    def _handler(self, *, kind: str) -> type[BaseHTTPRequestHandler]:
        state = self._state
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:
                path = self.path.split("?", 1)[0]
                if kind == "posting" and path in {"/", "/posting"}:
                    body = _POSTING_TEMPLATE.replace(
                        "{{FORM_ORIGIN}}",
                        fixture.form_origin,
                    ).encode("utf-8")
                    self._send(200, body, "text/html; charset=utf-8")
                    return
                if kind == "form" and path in {"/", "/application"}:
                    self._send(
                        200,
                        _APPLICATION_HTML.encode("utf-8"),
                        "text/html; charset=utf-8",
                    )
                    return
                if kind == "form" and path == "/submit-count":
                    self._send_json(200, state.snapshot())
                    return
                if kind == "form" and path == "/progress":
                    self._send_json(200, {"progress": state.snapshot()["progress"]})
                    return
                self._send_json(404, {"error": "not_found"})

            def do_POST(self) -> None:
                path = self.path.split("?", 1)[0]
                if kind != "form" or path not in {"/progress", "/submit"}:
                    self._send_json(404, {"error": "not_found"})
                    return
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    self._send_json(400, {"error": "invalid_length"})
                    return
                if content_length < 2 or content_length > 64 * 1024:
                    self._send_json(400, {"error": "invalid_payload"})
                    return
                try:
                    payload = json.loads(self.rfile.read(content_length))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    self._send_json(400, {"error": "invalid_json"})
                    return
                if not isinstance(payload, dict):
                    self._send_json(400, {"error": "invalid_payload"})
                    return
                if path == "/progress":
                    state.update_progress(payload)
                    self._send_json(200, {"ok": True})
                    return
                submit_count = state.submit(payload)
                self._send_json(200, {"submit_count": submit_count})

            def log_message(self, _format: str, *_args: object) -> None:
                return

            def _send_json(self, status: int, payload: dict[str, Any]) -> None:
                self._send(
                    status,
                    json.dumps(payload, sort_keys=True).encode("utf-8"),
                    "application/json",
                )

            def _send(self, status: int, body: bytes, content_type: str) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

        return Handler
