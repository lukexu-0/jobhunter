from __future__ import annotations

import asyncio
import base64
import io
import ipaddress
import json
import os
import shutil
import signal
import stat
import struct
import sys
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from browser_use.browser.events import SwitchTabEvent
from browser_use.skills.browser_use import skill_text
from PIL import Image

from .models import (
    BrowserObservation,
    BrowserScreenshot,
    BrowserTab,
    BrowserUseExecutionResult,
)

_MAX_FRAME_BYTES = 1024 * 1024
_MAX_SOURCE_BYTES = 65_536
_MAX_OUTPUT_CHARS = 20_000
_MAX_DOM_CHARS = 40_000
_MAX_PNG_BYTES = 8 * 1024 * 1024
_MAX_IMAGE_SIDE = 1_800
_RESULT_MARKER_START = "\x1eJOBHUNTER_BROWSER_RESULT:"
_RESULT_MARKER_END = ":JOBHUNTER_BROWSER_RESULT_END\x1e"


class BrowserSkillRuntimeError(Exception):
    """A fixed runtime failure that can be mapped without exposing child output."""

    def __init__(self, code: Literal["browser_failed", "session_timeout"]) -> None:
        super().__init__(code)
        self.code = code


def _loopback_cdp_environment(value: str | None) -> tuple[str, str]:
    if not value:
        raise BrowserSkillRuntimeError("browser_failed")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise BrowserSkillRuntimeError("browser_failed") from None
    hostname = (parsed.hostname or "").rstrip(".").lower()
    try:
        loopback = hostname == "localhost" or ipaddress.ip_address(
            hostname
        ).is_loopback
    except ValueError:
        loopback = hostname == "localhost"
    if (
        parsed.scheme not in {"http", "https", "ws", "wss"}
        or not loopback
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise BrowserSkillRuntimeError("browser_failed")
    if parsed.scheme in {"http", "https"}:
        if parsed.path not in {"", "/"}:
            raise BrowserSkillRuntimeError("browser_failed")
        return "BU_CDP_URL", value.rstrip("/")
    return "BU_CDP_WS", value


def _json_object(raw: bytes) -> dict[str, Any]:
    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=object_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise BrowserSkillRuntimeError("browser_failed") from None
    if not isinstance(value, dict):
        raise BrowserSkillRuntimeError("browser_failed")
    return value


def _validate_execute_response(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("ok") is False:
        if set(value) != {"ok", "error"} or value.get("error") != "browser_failed":
            raise BrowserSkillRuntimeError("browser_failed")
        raise BrowserSkillRuntimeError("browser_failed")
    expected = {
        "ok",
        "exit_code",
        "timed_out",
        "deadline_exhausted",
        "stdout",
        "stderr",
        "stdout_truncated",
        "stderr_truncated",
    }
    if set(value) != expected or value.get("ok") is not True:
        raise BrowserSkillRuntimeError("browser_failed")
    if type(value["exit_code"]) is not int:
        raise BrowserSkillRuntimeError("browser_failed")
    for key in (
        "timed_out",
        "deadline_exhausted",
        "stdout_truncated",
        "stderr_truncated",
    ):
        if type(value[key]) is not bool:
            raise BrowserSkillRuntimeError("browser_failed")
    for key in ("stdout", "stderr"):
        if not isinstance(value[key], str) or len(value[key]) > _MAX_OUTPUT_CHARS:
            raise BrowserSkillRuntimeError("browser_failed")
    return value


def _marker_payload(stdout: str) -> tuple[str, dict[str, Any] | None]:
    start = stdout.rfind(_RESULT_MARKER_START)
    if start < 0:
        return stdout, None
    payload_start = start + len(_RESULT_MARKER_START)
    end = stdout.find(_RESULT_MARKER_END, payload_start)
    if end < 0:
        return stdout[:start], None
    cleaned = stdout[:start] + stdout[end + len(_RESULT_MARKER_END) :]
    try:
        payload = _json_object(stdout[payload_start:end].encode("utf-8"))
    except BrowserSkillRuntimeError:
        return cleaned, None
    if set(payload) != {"current_tab", "page_info"}:
        return cleaned, None
    current_tab = payload["current_tab"]
    page_info = payload["page_info"]
    if not isinstance(current_tab, dict) or not (
        isinstance(page_info, dict) or page_info is None
    ):
        return cleaned, None
    return cleaned, payload


def _bounded_append(value: str, suffix: str) -> tuple[str, bool]:
    combined = f"{value.rstrip()}\n{suffix}" if value else suffix
    if len(combined) <= _MAX_OUTPUT_CHARS:
        return combined, False
    return combined[-_MAX_OUTPUT_CHARS:], True


def _png_screenshot(value: str | None) -> BrowserScreenshot | None:
    if value is None:
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise BrowserSkillRuntimeError("browser_failed") from None
    if len(raw) > _MAX_PNG_BYTES:
        raise BrowserSkillRuntimeError("browser_failed")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG":
                raise BrowserSkillRuntimeError("browser_failed")
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > 100_000_000:
                raise BrowserSkillRuntimeError("browser_failed")
            if max(width, height) <= _MAX_IMAGE_SIDE:
                encoded = value
            else:
                image.load()
                image.thumbnail(
                    (_MAX_IMAGE_SIDE, _MAX_IMAGE_SIDE),
                    Image.Resampling.LANCZOS,
                )
                destination = io.BytesIO()
                image.save(destination, format="PNG", optimize=True)
                resized = destination.getvalue()
                if len(resized) > _MAX_PNG_BYTES:
                    raise BrowserSkillRuntimeError("browser_failed")
                encoded = base64.b64encode(resized).decode("ascii")
    except BrowserSkillRuntimeError:
        raise
    except Exception:
        raise BrowserSkillRuntimeError("browser_failed") from None
    return BrowserScreenshot(data=encoded)


def _bind_parent_directories(paths: tuple[Path, ...]) -> list[str]:
    directories: set[Path] = set()
    for path in paths:
        current = path.parent
        while current != Path("/"):
            directories.add(current)
            current = current.parent
    arguments: list[str] = []
    for directory in sorted(directories, key=lambda item: len(item.parts)):
        arguments.extend(("--dir", str(directory)))
    return arguments


def _python_runtime_roots() -> tuple[Path, ...]:
    roots = [Path(sys.executable).resolve().parents[1]]
    link = Path(sys.executable)
    seen: set[Path] = set()
    while link not in seen and link.is_symlink():
        seen.add(link)
        target = Path(os.readlink(link))
        if not target.is_absolute():
            target = link.parent / target
        target = target.absolute()
        roots.append(target.parents[1])
        link = target
    return tuple(dict.fromkeys(roots))


class BrowserSkillRuntime:
    def __init__(
        self,
        *,
        browser: Any,
        session_directory: Path,
        workspace: Path,
        bubblewrap_executable: Path,
        deadline: float,
    ) -> None:
        self._browser = browser
        self._session_directory = session_directory
        self._workspace = workspace
        self._bubblewrap_executable = bubblewrap_executable
        self._deadline = deadline
        self._start_lock = asyncio.Lock()
        self._operation_lock = asyncio.Lock()
        self._close_lock = asyncio.Lock()
        self._process_lock = asyncio.Lock()
        self._start_attempted = False
        self._started = False
        self._closed = False
        self._close_complete = False
        self._cdp_environment: tuple[str, str] | None = None
        self._supervisor: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._active_task: asyncio.Task[Any] | None = None

    def _remaining(self) -> float:
        return self._deadline - asyncio.get_running_loop().time()

    def _prepare_session_paths(self) -> None:
        try:
            self._session_directory = self._session_directory.resolve(strict=True)
            self._workspace = self._workspace.resolve(strict=True)
            for path in (
                self._session_directory / "browser-skill-home",
                self._session_directory / "browser-skill-runtime",
                self._session_directory / "browser-skill-tmp",
                self._session_directory / "browser-skill-quarantine",
            ):
                path.mkdir(mode=0o700, exist_ok=True)
                details = path.lstat()
                if stat.S_ISLNK(details.st_mode) or not stat.S_ISDIR(details.st_mode):
                    raise OSError("unsafe runtime path")
                path.chmod(0o700)
        except OSError:
            raise BrowserSkillRuntimeError("browser_failed") from None

    def _bubblewrap_command(self) -> tuple[str, ...]:
        assert self._cdp_environment is not None
        application_source = Path(__file__).resolve().parent.parent
        environment_root = Path(sys.prefix).resolve()
        read_only_custom = tuple(
            dict.fromkeys(
                (environment_root, *_python_runtime_roots(), application_source)
            )
        )
        writable = (self._session_directory, self._workspace)
        command: list[str] = [
            str(self._bubblewrap_executable),
            "--die-with-parent",
            "--new-session",
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-cgroup",
            "--share-net",
            "--tmpfs",
            "/tmp",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
        ]
        for system_path in (Path("/usr"), Path("/bin"), Path("/lib"), Path("/lib64"), Path("/etc")):
            if system_path.exists():
                command.extend(("--ro-bind", str(system_path), str(system_path)))
        command.extend(_bind_parent_directories(read_only_custom + writable))
        for path in read_only_custom:
            command.extend(("--ro-bind", str(path), str(path)))
        for path in writable:
            command.extend(("--bind", str(path), str(path)))
        home = self._session_directory / "browser-skill-home"
        runtime = self._session_directory / "browser-skill-runtime"
        temporary = self._session_directory / "browser-skill-tmp"
        environment = {
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "BROWSER_USE_CONFIG_DIR": str(home / "browser-use"),
            "BH_HOME": str(home / "browser-harness"),
            "BH_RUNTIME_DIR": str(runtime),
            "BH_TMP_DIR": str(temporary),
            "BH_AGENT_WORKSPACE": str(self._workspace),
            "BH_DOMAIN_SKILLS": "1",
            "ANONYMIZED_TELEMETRY": "false",
            "BROWSER_HARNESS_TELEMETRY": "false",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHONUNBUFFERED": "1",
            "PATH": f"{environment_root / 'bin'}:/usr/bin:/bin",
            "TMPDIR": "/tmp",
            "LANG": "C.UTF-8",
            "JOBHUNTER_SESSION_DEADLINE": repr(self._deadline),
            "JOBHUNTER_SESSION_DIRECTORY": str(self._session_directory),
            self._cdp_environment[0]: self._cdp_environment[1],
        }
        command.append("--clearenv")
        for key, value in environment.items():
            command.extend(("--setenv", key, value))
        command.extend(
            (
                "--chdir",
                str(self._session_directory),
                "--",
                sys.executable,
                "-m",
                "jobhunter_browser_harness.skill_process",
                "--server",
            )
        )
        return tuple(command)

    async def _drain_supervisor_stderr(
        self, stream: asyncio.StreamReader
    ) -> None:
        retained = bytearray()
        while chunk := await stream.read(16_384):
            retained.extend(chunk)
            if len(retained) > 80_004:
                del retained[: len(retained) - 80_004]

    async def start(self) -> None:
        async with self._start_lock:
            if self._started:
                return
            if self._closed or self._start_attempted:
                raise BrowserSkillRuntimeError("browser_failed")
            self._start_attempted = True
            if self._remaining() <= 0:
                raise BrowserSkillRuntimeError("session_timeout")
            try:
                await self._browser.start()
            except asyncio.CancelledError:
                raise
            except Exception:
                raise BrowserSkillRuntimeError("browser_failed") from None
            self._cdp_environment = _loopback_cdp_environment(self._browser.cdp_url)
            self._prepare_session_paths()
            try:
                process = await asyncio.create_subprocess_exec(
                    *self._bubblewrap_command(),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                raise BrowserSkillRuntimeError("browser_failed") from None
            self._supervisor = process
            assert process.stderr is not None
            self._stderr_task = asyncio.create_task(
                self._drain_supervisor_stderr(process.stderr),
                name="browser-skill-supervisor-stderr",
            )
            try:
                await asyncio.wait_for(asyncio.shield(process.wait()), timeout=0.05)
            except TimeoutError:
                pass
            else:
                await self._terminate_supervisor()
                raise BrowserSkillRuntimeError("browser_failed")
            self._started = True

    async def _write_frame(self, value: dict[str, Any]) -> None:
        process = self._supervisor
        if process is None or process.returncode is not None or process.stdin is None:
            raise BrowserSkillRuntimeError("browser_failed")
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if not encoded or len(encoded) > _MAX_FRAME_BYTES:
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            process.stdin.write(struct.pack(">I", len(encoded)) + encoded)
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionError, OSError):
            raise BrowserSkillRuntimeError("browser_failed") from None

    async def _read_frame(self) -> dict[str, Any]:
        process = self._supervisor
        if process is None or process.stdout is None:
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            header = await process.stdout.readexactly(4)
            (length,) = struct.unpack(">I", header)
            if length <= 0 or length > _MAX_FRAME_BYTES:
                raise BrowserSkillRuntimeError("browser_failed")
            body = await process.stdout.readexactly(length)
        except asyncio.IncompleteReadError:
            raise BrowserSkillRuntimeError("browser_failed") from None
        return _json_object(body)

    async def _exchange(
        self,
        request: dict[str, Any],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        await self._write_frame(request)
        try:
            async with asyncio.timeout(timeout):
                return await self._read_frame()
        except TimeoutError:
            if self._remaining() <= 0:
                raise BrowserSkillRuntimeError("session_timeout") from None
            raise BrowserSkillRuntimeError("browser_failed") from None

    async def _observe(
        self,
        marker: dict[str, Any] | None,
    ) -> BrowserObservation:
        page_info: dict[str, object] | None = None
        if marker is not None:
            current_tab = marker["current_tab"]
            assert isinstance(current_tab, dict)
            target_id = current_tab.get("targetId") or current_tab.get("target_id")
            if isinstance(target_id, str) and target_id:
                try:
                    switch_event = self._browser.event_bus.dispatch(
                        SwitchTabEvent(target_id=target_id)
                    )
                    await switch_event
                    await switch_event.event_result(
                        raise_if_any=True,
                        raise_if_none=False,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    raise BrowserSkillRuntimeError("browser_failed") from None
            raw_page_info = marker["page_info"]
            if isinstance(raw_page_info, dict):
                page_info = raw_page_info
        try:
            state = await self._browser.get_browser_state_summary(
                include_screenshot=True,
                cached=False,
            )
            dom = state.dom_state.llm_representation()[:_MAX_DOM_CHARS]
            tabs = [
                BrowserTab(
                    url=tab.url,
                    title=tab.title,
                    tab_id=tab.target_id,
                    parent_tab_id=tab.parent_target_id,
                )
                for tab in state.tabs
            ]
            return BrowserObservation(
                url=state.url,
                title=state.title,
                tabs=tabs,
                dom=dom,
                page_info=page_info,
                screenshot=_png_screenshot(state.screenshot),
            )
        except asyncio.CancelledError:
            raise
        except BrowserSkillRuntimeError:
            raise
        except Exception:
            raise BrowserSkillRuntimeError("browser_failed") from None

    def _quarantine_workspace_entries(self) -> None:
        quarantine = self._session_directory / "browser-skill-quarantine"
        try:
            for entry in tuple(self._workspace.iterdir()):
                details = entry.lstat()
                allowed = (
                    entry.name == "agent_helpers.py"
                    and stat.S_ISREG(details.st_mode)
                    and not stat.S_ISLNK(details.st_mode)
                ) or (
                    entry.name == "domain-skills"
                    and stat.S_ISDIR(details.st_mode)
                    and not stat.S_ISLNK(details.st_mode)
                )
                if allowed:
                    continue
                destination = quarantine / f"{uuid4().hex}-{entry.name}"
                shutil.move(str(entry), destination)
        except OSError:
            raise BrowserSkillRuntimeError("browser_failed") from None

    async def execute(self, code: str) -> BrowserUseExecutionResult:
        if not isinstance(code, str):
            raise BrowserSkillRuntimeError("browser_failed")
        task = asyncio.current_task()
        async with self._operation_lock:
            if not self._started or self._closed:
                raise BrowserSkillRuntimeError("browser_failed")
            remaining = self._remaining()
            if remaining <= 0:
                raise BrowserSkillRuntimeError("session_timeout")
            self._active_task = task
            try:
                if len(code.encode("utf-8")) > _MAX_SOURCE_BYTES:
                    observation = await self._observe(None)
                    return BrowserUseExecutionResult(
                        exit_code=2,
                        timed_out=False,
                        stdout="",
                        stderr="Browser Use code exceeds the 65,536-byte limit.",
                        stdout_truncated=False,
                        stderr_truncated=False,
                        observation=observation,
                    )
                wait_seconds = min(125.0, remaining + 0.25)
                response = _validate_execute_response(
                    await self._exchange(
                        {"op": "execute", "code": code},
                        timeout=wait_seconds,
                    )
                )
                if response["deadline_exhausted"]:
                    raise BrowserSkillRuntimeError("session_timeout")
                stdout, marker = _marker_payload(response["stdout"])
                stderr = response["stderr"]
                stderr_truncated = response["stderr_truncated"]
                if response["timed_out"]:
                    stderr, added_truncation = _bounded_append(
                        stderr,
                        "Browser Use execution timed out after 120 seconds.",
                    )
                    stderr_truncated = stderr_truncated or added_truncation
                if marker is None:
                    stderr, added_truncation = _bounded_append(
                        stderr,
                        "Browser Use result metadata was unavailable.",
                    )
                    stderr_truncated = stderr_truncated or added_truncation
                self._quarantine_workspace_entries()
                observation = await self._observe(marker)
                return BrowserUseExecutionResult(
                    exit_code=response["exit_code"],
                    timed_out=response["timed_out"],
                    stdout=stdout[-_MAX_OUTPUT_CHARS:],
                    stderr=stderr,
                    stdout_truncated=(
                        response["stdout_truncated"]
                        or len(stdout) > _MAX_OUTPUT_CHARS
                    ),
                    stderr_truncated=stderr_truncated,
                    observation=observation,
                )
            except asyncio.CancelledError:
                await asyncio.shield(self._terminate_supervisor())
                raise
            except BrowserSkillRuntimeError:
                if self._supervisor is not None and self._supervisor.returncode is not None:
                    await self._terminate_supervisor()
                raise
            finally:
                if self._active_task is task:
                    self._active_task = None

    async def _terminate_supervisor(self) -> None:
        async with self._process_lock:
            process = self._supervisor
            if process is not None:
                if process.returncode is None:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        await asyncio.wait_for(process.wait(), timeout=1.0)
                    except TimeoutError:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        await process.wait()
                self._supervisor = None
            stderr_task = self._stderr_task
            self._stderr_task = None
            if stderr_task is not None:
                await asyncio.gather(stderr_task, return_exceptions=True)

    async def close(self) -> None:
        async with self._close_lock:
            if self._close_complete:
                return
            self._closed = True
            active = self._active_task
            current = asyncio.current_task()
            if active is not None and active is not current and not active.done():
                active.cancel()
                await asyncio.gather(active, return_exceptions=True)
            stop_failed = False
            process = self._supervisor
            if process is not None and process.returncode is None:
                try:
                    async with self._operation_lock:
                        response = _validate_execute_response(
                            await self._exchange(
                                {"op": "stop_daemon"},
                                timeout=20.0,
                            )
                        )
                        if (
                            response["exit_code"] != 0
                            or response["timed_out"]
                            or response["deadline_exhausted"]
                            or response["stdout"]
                            or response["stderr"]
                            or response["stdout_truncated"]
                            or response["stderr_truncated"]
                        ):
                            stop_failed = True
                except (BrowserSkillRuntimeError, asyncio.CancelledError):
                    stop_failed = True
            await self._terminate_supervisor()
            self._close_complete = True
            if stop_failed:
                raise BrowserSkillRuntimeError("browser_failed")


def load_browser_skill() -> str:
    """Return the exact Browser Use skill bundled by the pinned dependency."""

    return skill_text()


__all__ = ["BrowserSkillRuntime", "BrowserSkillRuntimeError", "load_browser_skill"]
