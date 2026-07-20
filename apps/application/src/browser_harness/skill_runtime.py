from __future__ import annotations

import asyncio
import base64
import io
import ipaddress
import json
import errno
import os
import shutil
import signal
import stat
import struct
import sys
import tempfile
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from browser_use.browser.events import SwitchTabEvent
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
_MAX_URL_CHARS = 4_096
_MAX_TITLE_CHARS = 4_096
_MAX_TAB_ID_CHARS = 512
_MAX_TABS = 100


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

    def reject_constant(_value: str) -> None:
        raise ValueError("non-finite JSON number")

    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=object_pairs,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
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
        "marker",
        "cancelled",
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
        "cancelled",
    ):
        if type(value[key]) is not bool:
            raise BrowserSkillRuntimeError("browser_failed")
    for key in ("stdout", "stderr"):
        if not isinstance(value[key], str) or len(value[key]) > _MAX_OUTPUT_CHARS:
            raise BrowserSkillRuntimeError("browser_failed")
    marker = value["marker"]
    if marker is not None:
        if type(marker) is not dict or set(marker) != {"current_tab", "page_info"}:
            raise BrowserSkillRuntimeError("browser_failed")
        current_tab = marker["current_tab"]
        page_info = marker["page_info"]
        if (
            type(current_tab) is not dict
            or set(current_tab) != {"targetId", "url", "title"}
            or not isinstance(current_tab["targetId"], str)
            or not current_tab["targetId"]
            or len(current_tab["targetId"]) > 512
            or not isinstance(current_tab["url"], str)
            or len(current_tab["url"]) > 4_096
            or not isinstance(current_tab["title"], str)
            or len(current_tab["title"]) > 4_096
            or not (isinstance(page_info, dict) or page_info is None)
        ):
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            marker_size = len(
                json.dumps(
                    marker,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
            )
        except (TypeError, ValueError, RecursionError):
            raise BrowserSkillRuntimeError("browser_failed") from None
        if marker_size > 16_000:
            raise BrowserSkillRuntimeError("browser_failed")

    return value




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
            image.load()
            if max(width, height) <= _MAX_IMAGE_SIDE:
                encoded = value
            else:
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
        self._quarantine_directory: Path | None = None

    def _remaining(self) -> float:
        return self._deadline - asyncio.get_running_loop().time()

    def _prepare_session_paths(self) -> None:
        quarantine: Path | None = None
        try:
            self._session_directory = self._session_directory.resolve(strict=True)
            self._workspace = self._workspace.resolve(strict=True)
            if (
                self._session_directory == self._workspace
                or self._session_directory.is_relative_to(self._workspace)
                or self._workspace.is_relative_to(self._session_directory)
                or self._quarantine_directory is not None
            ):
                raise OSError("overlapping runtime paths")
            for path in (
                self._session_directory / "browser-skill-home",
                self._session_directory / "browser-skill-runtime",
                self._session_directory / "browser-skill-tmp",
            ):
                path.mkdir(mode=0o700, exist_ok=True)
                details = path.lstat()
                if (
                    stat.S_ISLNK(details.st_mode)
                    or not stat.S_ISDIR(details.st_mode)
                    or details.st_uid != os.getuid()
                ):
                    raise OSError("unsafe runtime path")
                path.chmod(0o700)
            quarantine = Path(
                tempfile.mkdtemp(
                    prefix=".browser-skill-quarantine-",
                    dir=self._session_directory.parent,
                )
            )
            quarantine.chmod(0o700)
            details = quarantine.lstat()
            if (
                stat.S_ISLNK(details.st_mode)
                or not stat.S_ISDIR(details.st_mode)
                or details.st_uid != os.getuid()
                or stat.S_IMODE(details.st_mode) != 0o700
            ):
                raise OSError("unsafe quarantine path")
            self._quarantine_directory = quarantine
        except OSError:
            if quarantine is not None:
                try:
                    shutil.rmtree(quarantine)
                except OSError:
                    pass
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
        if Path("/") in read_only_custom:
            raise BrowserSkillRuntimeError("browser_failed")
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
        sandbox_session = Path("/jobhunter-session")
        command.extend(("--bind", str(self._session_directory), str(sandbox_session)))
        home = sandbox_session / "browser-skill-home"
        runtime = sandbox_session / "browser-skill-runtime"
        temporary = sandbox_session / "browser-skill-tmp"
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
            "JOBHUNTER_SESSION_DIRECTORY": str(sandbox_session),
            self._cdp_environment[0]: self._cdp_environment[1],
        }
        command.append("--clearenv")
        for key, value in environment.items():
            command.extend(("--setenv", key, value))
        command.extend(
            (
                "--chdir",
                str(sandbox_session),
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
            self._quarantine_workspace_entries()
            try:
                process = await asyncio.create_subprocess_exec(
                    *self._bubblewrap_command(),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                )
            except asyncio.CancelledError:
                try:
                    self._remove_quarantine_directory()
                except BrowserSkillRuntimeError:
                    pass
                raise
            except Exception:
                try:
                    self._remove_quarantine_directory()
                except BrowserSkillRuntimeError:
                    pass
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
                try:
                    self._remove_quarantine_directory()
                except BrowserSkillRuntimeError:
                    pass
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
    async def _cancel_execution(
        self,
        response_task: asyncio.Task[dict[str, Any]],
    ) -> None:
        try:
            if not response_task.done():
                await self._write_frame({"op": "cancel"})
            async with asyncio.timeout(10.0):
                response = await asyncio.shield(response_task)
            _validate_execute_response(response)
        except (BrowserSkillRuntimeError, TimeoutError, asyncio.CancelledError):
            response_task.cancel()
            await asyncio.gather(response_task, return_exceptions=True)
            await self._terminate_supervisor()

    async def _exchange_execution(
        self,
        request: dict[str, Any],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        await self._write_frame(request)
        response_task = asyncio.create_task(
            self._read_frame(),
            name="browser-skill-execution-response",
        )
        try:
            async with asyncio.timeout(timeout):
                return await asyncio.shield(response_task)
        except asyncio.CancelledError:
            cleanup_task = asyncio.create_task(
                self._cancel_execution(response_task),
                name="browser-skill-execution-cancellation",
            )
            try:
                await asyncio.shield(cleanup_task)
            except asyncio.CancelledError:
                await asyncio.shield(cleanup_task)
            raise
        except TimeoutError:
            response_task.cancel()
            await asyncio.gather(response_task, return_exceptions=True)
            if self._remaining() <= 0:
                raise BrowserSkillRuntimeError("session_timeout") from None
            raise BrowserSkillRuntimeError("browser_failed") from None


    async def _observe(
        self,
        marker: dict[str, Any] | None,
    ) -> BrowserObservation:
        remaining = self._remaining()
        if remaining <= 0:
            raise BrowserSkillRuntimeError("session_timeout")
        try:
            async with asyncio.timeout(remaining):
                return await self._observe_with_no_deadline(marker)
        except TimeoutError:
            raise BrowserSkillRuntimeError("session_timeout") from None


    async def _observe_with_no_deadline(
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
                    url=tab.url[:_MAX_URL_CHARS],
                    title=tab.title[:_MAX_TITLE_CHARS],
                    tab_id=tab.target_id[:_MAX_TAB_ID_CHARS],
                    parent_tab_id=(
                        tab.parent_target_id[:_MAX_TAB_ID_CHARS]
                        if tab.parent_target_id is not None
                        else None
                    ),
                )
                for tab in state.tabs[:_MAX_TABS]
            ]
            return BrowserObservation(
                url=state.url[:_MAX_URL_CHARS],
                title=state.title[:_MAX_TITLE_CHARS],
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

    @staticmethod
    def _move_to_quarantine(
        entry: Path,
        destination: Path,
        details: os.stat_result,
    ) -> None:
        try:
            os.rename(entry, destination)
            return
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
        if stat.S_ISLNK(details.st_mode):
            os.symlink(os.readlink(entry), destination)
            entry.unlink()
            return
        if stat.S_ISREG(details.st_mode):
            source_descriptor = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                destination_descriptor = os.open(
                    destination,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                try:
                    with (
                        os.fdopen(source_descriptor, "rb", closefd=False) as source,
                        os.fdopen(
                            destination_descriptor, "wb", closefd=False
                        ) as target,
                    ):
                        shutil.copyfileobj(source, target, length=64 * 1024)
                finally:
                    os.close(destination_descriptor)
            finally:
                os.close(source_descriptor)
            entry.unlink()
            return
        if stat.S_ISDIR(details.st_mode):
            shutil.copytree(entry, destination, symlinks=True)
            shutil.rmtree(entry)
            return
        entry.unlink()


    def _checked_quarantine_directory(self) -> Path:
        quarantine = self._quarantine_directory
        if quarantine is None:
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            details = quarantine.lstat()
        except OSError:
            raise BrowserSkillRuntimeError("browser_failed") from None
        if (
            stat.S_ISLNK(details.st_mode)
            or not stat.S_ISDIR(details.st_mode)
            or details.st_uid != os.getuid()
            or stat.S_IMODE(details.st_mode) != 0o700
        ):
            raise BrowserSkillRuntimeError("browser_failed")
        return quarantine

    def _remove_quarantine_directory(self) -> None:
        if self._quarantine_directory is None:
            return
        quarantine = self._checked_quarantine_directory()
        try:
            shutil.rmtree(quarantine)
        except OSError:
            raise BrowserSkillRuntimeError("browser_failed") from None
        self._quarantine_directory = None

    def _quarantine_workspace_entries(self) -> None:
        quarantine = self._checked_quarantine_directory()
        try:
            for entry in tuple(self._workspace.iterdir()):
                details = entry.lstat()
                allowed = (
                    entry.name == "agent_helpers.py"
                    and stat.S_ISREG(details.st_mode)
                    and not stat.S_ISLNK(details.st_mode)
                    and details.st_nlink == 1
                ) or (
                    entry.name == "domain-skills"
                    and stat.S_ISDIR(details.st_mode)
                    and not stat.S_ISLNK(details.st_mode)
                )
                if allowed:
                    continue
                destination = quarantine / f"{uuid4().hex}-{entry.name}"
                self._move_to_quarantine(entry, destination, details)
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
                self._quarantine_workspace_entries()
                try:
                    encoded_code = code.encode("utf-8")
                except UnicodeEncodeError:
                    raise BrowserSkillRuntimeError("browser_failed") from None
                if len(encoded_code) > _MAX_SOURCE_BYTES:
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
                    await self._exchange_execution(
                        {"op": "execute", "code": code},
                        timeout=wait_seconds,
                    )
                )
                if response["cancelled"]:
                    raise BrowserSkillRuntimeError("browser_failed")
                if response["deadline_exhausted"]:
                    raise BrowserSkillRuntimeError("session_timeout")
                stdout = response["stdout"]
                marker = response["marker"]
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
                raise
            except BrowserSkillRuntimeError:
                await self._terminate_supervisor()
                raise
            finally:
                active_exception = sys.exc_info()[0] is not None
                try:
                    self._quarantine_workspace_entries()
                except BrowserSkillRuntimeError:
                    if not active_exception:
                        raise
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
            self._started = False
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
                            or response["cancelled"]
                            or response["stdout"]
                            or response["stderr"]
                            or response["stdout_truncated"]
                            or response["stderr_truncated"]
                        ):
                            stop_failed = True
                except (BrowserSkillRuntimeError, asyncio.CancelledError):
                    stop_failed = True
            await self._terminate_supervisor()
            try:
                self._remove_quarantine_directory()
            except BrowserSkillRuntimeError:
                stop_failed = True
            self._close_complete = True
            if stop_failed:
                raise BrowserSkillRuntimeError("browser_failed")


