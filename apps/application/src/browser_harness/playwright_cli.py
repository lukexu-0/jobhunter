from __future__ import annotations

import asyncio
import ctypes
import base64
import inspect
import json
import logging
import math
import os
import platform
import shutil
import re
import stat
import sys
import tempfile
import time
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol, cast
from urllib.parse import parse_qsl, quote, unquote, urlsplit, urlunsplit
from uuid import UUID

import psutil

from .gmail_verification import VerificationChallenge
from .models import (
    BrowserLaunchConfig,
    BrowserObservation,
    BrowserScreenshot,
    BrowserTab,
    PlaywrightCliExecutionResult,
    SOURCE_CAPTURE_MAX_BYTES,
    SOURCE_CAPTURE_MAX_LINES,
    validate_approved_origin,
    validate_job_url,
    validate_loopback_http_url,
    validate_https_origin,
)
logger = logging.getLogger(__name__)


_MAX_ARGUMENT_ITEMS = 64
_MAX_ARGUMENT_BYTES = 8_192
_MAX_INVOCATION_BYTES = 65_536
_MAX_CAPTURE_BYTES = 65_536
_MAX_INTERNAL_CAPTURE_BYTES = 8 * 1024 * 1024
_MAX_OBSERVATION_CAPTURE_BYTES = 16 * 1024 * 1024
_MAX_OUTPUT_CHARS = 20_000
_MAX_URL_CHARS = 4_096
_MAX_TITLE_CHARS = 4_096
_MAX_TAB_ID_CHARS = 512
_MAX_TABS = 100
_MAX_DOM_CHARS = 40_000
_MAX_URL_CAPTURE_CHARS = _MAX_URL_CHARS * 12
_MAX_TITLE_CAPTURE_CHARS = _MAX_TITLE_CHARS * 2
_MAX_PRIVATE_REDACTION_FRAGMENT_CHARS = 4_096 * 16
_MAX_DOM_CAPTURE_CHARS = (
    _MAX_DOM_CHARS + _MAX_PRIVATE_REDACTION_FRAGMENT_CHARS
)
# 101 records * (49,152 URL bytes + 7 * 8,192 title scalars) stays below
# 16 MiB with the result envelope and two JSON serialization layers.
_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
_MAX_OUTPUT_DIRECTORY_BYTES = 1_073_741_824
_MAX_TEMPORARY_DIRECTORY_BYTES = 1_073_741_824
_MAX_VIDEO_BYTES = 2_147_483_648
_MAX_SOURCE_CAPTURE_BYTES = SOURCE_CAPTURE_MAX_BYTES
_MAX_SOURCE_CAPTURE_LINES = SOURCE_CAPTURE_MAX_LINES
_MAX_SOURCE_CAPTURE_VISITED_NODES = 100_000
_MAX_SOURCE_CAPTURE_TRAVERSAL_BYTES = (
    _MAX_SOURCE_CAPTURE_BYTES + _MAX_PRIVATE_REDACTION_FRAGMENT_CHARS
)
_ARTIFACT_BUDGET_POLL_SECONDS = 0.25
_BUDGET_CLEANUP_TIMEOUT_SECONDS = 1.0
_CLEANUP_TIMEOUT_SECONDS = 10.0
_RECOVERY_TIMEOUT_SECONDS = 10.0
_RECOVERY_TERMINATE_GRACE_SECONDS = 20.0
_PROCESS_TERMINATE_GRACE_SECONDS = 2.0
_SAFE_INTERNAL_SCHEMES = frozenset({"about"})
_ELEMENT_REF_PATTERN = re.compile(
    r"^(?:f[1-9][0-9]{0,8})?e[1-9][0-9]{0,8}$"
)
_CHROME_SINGLETON_SOCKET_LIMIT = 108
_CHROME_SINGLETON_SOCKET_SUFFIX = Path(
    "com.google.Chrome.XXXXXX/SingletonSocket"
)

def _is_unicode_scalar_text(value: str) -> bool:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _create_anonymous_memfd() -> int:
    create_memfd = getattr(os, "memfd_create", None)
    close_on_exec = getattr(os, "MFD_CLOEXEC", 0x0001)
    if callable(create_memfd):
        return create_memfd("jobhunter-sign-in", flags=close_on_exec)
    libc = ctypes.CDLL(None, use_errno=True)
    native_create = libc.memfd_create
    native_create.argtypes = [ctypes.c_char_p, ctypes.c_uint]
    native_create.restype = ctypes.c_int
    descriptor = native_create(b"jobhunter-sign-in", close_on_exec)
    if descriptor < 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))
    return descriptor


def _yaml_value_fragment(value: str) -> str:
    escaped: list[str] = []
    named = {
        "\\": "\\\\",
        '"': '\\"',
        "\b": "\\b",
        "\f": "\\f",
        "\n": "\\n",
        "\r": "\\r",
        "\t": "\\t",
    }
    for character in value:
        replacement = named.get(character)
        if replacement is not None:
            escaped.append(replacement)
            continue
        codepoint = ord(character)
        if codepoint <= 0x1F or 0x7F <= codepoint <= 0x9F:
            escaped.append(f"\\x{codepoint:02x}")
        else:
            escaped.append(character)
    return "".join(escaped)


def _private_redaction_fragments(values: Iterable[str]) -> tuple[str, ...]:
    fragments: set[str] = set()
    for value in values:
        if not value:
            continue
        fragments.add(value)
        fragments.add(value.replace("'", "''"))
        fragments.add(_yaml_value_fragment(value))
        fragments.add(json.dumps(value, ensure_ascii=False)[1:-1])
        fragments.add(json.dumps(value, ensure_ascii=True)[1:-1])
    for fragment in tuple(fragments):
        encoded = quote(fragment, safe="")
        fragments.add(encoded)
        fragments.add(
            re.sub(
                r"%([0-9A-F]{2})",
                lambda match: f"%{match.group(1).lower()}",
                encoded,
            )
        )
    return tuple(sorted(fragments, key=len, reverse=True))


def _bounded_source_snapshot(value: str) -> str:
    lines = value.splitlines(keepends=True)
    if len(lines) > _MAX_SOURCE_CAPTURE_LINES:
        value = "".join(lines[:_MAX_SOURCE_CAPTURE_LINES])
    encoded = value.encode("utf-8")
    if len(encoded) <= _MAX_SOURCE_CAPTURE_BYTES:
        return value
    prefix = encoded[:_MAX_SOURCE_CAPTURE_BYTES]
    try:
        return prefix.decode("utf-8")
    except UnicodeDecodeError as error:
        if (
            error.reason != "unexpected end of data"
            or error.end != len(prefix)
        ):
            raise
        return prefix[: error.start].decode("utf-8")


_APPROVED_COMMANDS = frozenset(
    {
        "goto",
        "snapshot",
        "click",
        "dblclick",
        "type",
        "press",
        "fill",
        "drag",
        "drop",
        "hover",
        "select",
        "upload",
        "check",
        "uncheck",
        "eval",
        "dialog-accept",
        "dialog-dismiss",
        "resize",
        "go-back",
        "go-forward",
        "reload",
        "keydown",
        "keyup",
        "mousemove",
        "mousedown",
        "mouseup",
        "mousewheel",
        "screenshot",
        "pdf",
        "tab-list",
        "tab-new",
        "tab-close",
        "tab-select",
        "generate-locator",
        "highlight",
        "video-chapter",
        "video-show-actions",
        "video-hide-actions",
    }
)
_RESERVED_ARGUMENTS = frozenset(
    {
        "-s",
        "--s",
        "-h",
        "--help",
        "-v",
        "--version",
        "--session",
        "--json",
        "--raw",
        "--config",
        "--profile",
        "--persistent",
        "--headed",
        "--browser",
        "--cdp",
        "--endpoint",
        "--extension",
    }
)
_RESERVED_ARGUMENT_PREFIXES = (
    "-s",
    "--s=",
    "-h=",
    "--help=",
    "-v=",
    "--version=",
    "--session=",
    "--json=",
    "--raw=",
    "--config=",
    "--profile=",
    "--persistent=",
    "--headed=",
    "--browser=",
    "--cdp=",
    "--endpoint=",
    "--extension=",
)
_FOCUS_SUPPRESSION_ARGS = (
    "--disable-window-activation",
    "--disable-focus-on-load",
)
_EXACT_ORIGIN_MATCHER_SCRIPT = (
    "const hasExactOrigin=(url,origin)=>{"
    "if(typeof url!=='string'||typeof origin!=='string'||origin.length===0)"
    "return false;"
    "for(let index=0;index<url.length;index+=1){"
    "const code=url.charCodeAt(index);"
    "if(code<=0x20||code===0x5c||code===0x7f)return false;}"
    "if(!url.startsWith(origin))return false;"
    "const boundary=url.charAt(origin.length);"
    "return boundary===''||boundary==='/'||boundary==='?'||boundary==='#';};"
)


class BrowserConfigurationError(ValueError):
    """A sanitized browser or Playwright CLI configuration failure."""


class PlaywrightCliRuntimeError(RuntimeError):
    """A sanitized runtime failure safe to expose through the harness API."""

    __slots__ = ("code",)

    def __init__(self, code: Literal["browser_failed"]) -> None:
        super().__init__(code)
        self.code = code


class _ActionRuntimeFailure(Exception):
    __slots__ = ("error",)

    def __init__(self, error: PlaywrightCliRuntimeError) -> None:
        super().__init__()
        self.error = error


@dataclass(frozen=True, slots=True)
class ResolvedBrowserLaunch:
    cdp_url: str | None
    executable_path: Path | None
    user_data_dir: Path | None

    @property
    def is_cdp(self) -> bool:
        return self.cdp_url is not None


class _ReadableStream(Protocol):
    async def read(self, size: int = -1) -> bytes: ...


class _Process(Protocol):
    stdout: _ReadableStream | None
    stderr: _ReadableStream | None
    returncode: int | None

    async def wait(self) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...


ProcessFactory = Callable[..., Awaitable[_Process] | _Process]


@dataclass(frozen=True, slots=True)
class _NativeBrowserOwnership:
    launcher: Path
    user_data_dir: Path
    executable: Path | None = None
    pid: int | None = None
    create_time: float | None = None


@dataclass(frozen=True, slots=True)
class _InvocationResult:
    exit_code: int
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool
    timed_out: bool = False


@dataclass(slots=True)
class _BoundedCapture:
    limit: int
    data: bytearray
    total: int = 0

    def append(self, chunk: bytes) -> None:
        self.total += len(chunk)
        if len(chunk) >= self.limit:
            self.data[:] = chunk[-self.limit :]
            return
        overflow = len(self.data) + len(chunk) - self.limit
        if overflow > 0:
            del self.data[:overflow]
        self.data.extend(chunk)

    @property
    def truncated(self) -> bool:
        return self.total > len(self.data)


@dataclass(frozen=True, slots=True)
class _PageMetadata:
    url: str
    title: str
    current_index: int
    tabs: tuple[tuple[str, str], ...]


def _is_wsl() -> bool:
    if platform.system() != "Linux":
        return False
    for path in (Path("/proc/sys/kernel/osrelease"), Path("/proc/version")):
        try:
            if "microsoft" in path.read_text(encoding="utf-8").lower():
                return True
        except OSError:
            continue
    return False


def _default_profile_roots() -> tuple[Path, ...]:
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        base = home / "Library" / "Application Support"
        return (
            base / "Google" / "Chrome",
            base / "Chromium",
            base / "Google" / "Chrome Canary",
        )
    if system == "Linux":
        return (
            home / ".config" / "google-chrome",
            home / ".config" / "chromium",
        )
    if system == "Windows":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return (
                Path(local_app_data) / "Google" / "Chrome" / "User Data",
                Path(local_app_data) / "Chromium" / "User Data",
            )
    return ()


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _reject_symlink_components(path: Path, message: str) -> None:
    absolute = path.absolute()
    for component in (absolute, *absolute.parents):
        try:
            component_mode = component.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(component_mode):
            raise BrowserConfigurationError(message)


def _find_chrome_executable() -> Path | None:
    names = (
        "google-chrome-stable",
        "google-chrome",
        "chromium",
        "chromium-browser",
        "chrome",
    )
    for name in names:
        candidate = shutil.which(name)
        if candidate:
            return Path(candidate)

    system = platform.system()
    candidates: tuple[Path, ...] = ()
    if system == "Darwin":
        candidates = (
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        )
    elif system == "Windows":
        roots = tuple(
            Path(value)
            for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")
            if (value := os.environ.get(key))
        )
        candidates = tuple(
            root / "Google" / "Chrome" / "Application" / "chrome.exe"
            for root in roots
        )
    return next((candidate for candidate in candidates if candidate.is_file()), None)


def _resolve_executable(configured: Path | None) -> Path:
    if configured is None:
        if _is_wsl():
            raise BrowserConfigurationError(
                "System Chrome is not auto-discovered in WSL; start Windows Chrome with a dedicated profile and use --cdp-url"
            )
        configured = _find_chrome_executable()
        if configured is None:
            raise BrowserConfigurationError(
                "Chrome was not found; provide --chrome-executable or a loopback --cdp-url"
            )
    try:
        executable = configured.expanduser().resolve(strict=True)
    except OSError:
        raise BrowserConfigurationError("The Chrome executable is unavailable") from None
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise BrowserConfigurationError("The Chrome executable is unavailable")
    if _is_wsl() and executable.suffix.lower() == ".exe":
        raise BrowserConfigurationError(
            "Windows Chrome must be started separately in WSL and connected through --cdp-url"
        )
    return executable


def _resolve_dedicated_profile(configured: Path) -> Path:
    expanded = configured.expanduser()
    symlink_error = "The Chrome user-data directory must not be a symbolic link"
    try:
        _reject_symlink_components(expanded, symlink_error)
        profile = expanded.resolve(strict=False)
        for default_root in _default_profile_roots():
            resolved_default = default_root.expanduser().resolve(strict=False)
            if _is_within(profile, resolved_default):
                raise BrowserConfigurationError(
                    "The Chrome user-data directory must be separate from the operating-system default profile"
                )
        profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not profile.is_dir() or profile.is_symlink():
            raise BrowserConfigurationError("The Chrome user-data directory is invalid")
        profile.chmod(0o700)
        if stat.S_IMODE(profile.stat().st_mode) != 0o700:
            raise BrowserConfigurationError(
                "The Chrome user-data directory must have mode 0700"
            )
    except BrowserConfigurationError:
        raise
    except OSError:
        raise BrowserConfigurationError(
            "The Chrome user-data directory is unavailable"
        ) from None
    return profile


def resolve_browser_launch(config: BrowserLaunchConfig) -> ResolvedBrowserLaunch:
    """Validate browser configuration without launching Chrome."""

    if config.cdp_url is not None:
        try:
            canonical_cdp_url = validate_loopback_http_url(
                config.cdp_url,
                field_name="cdp_url",
            )
            parsed = urlsplit(canonical_cdp_url)
            port = parsed.port
        except (TypeError, ValueError):
            raise BrowserConfigurationError(
                "The CDP URL must be a loopback HTTP origin with an explicit port"
            ) from None
        if (
            parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or port is None
        ):
            raise BrowserConfigurationError(
                "The CDP URL must be a loopback HTTP origin with an explicit port"
            )
        return ResolvedBrowserLaunch(
            cdp_url=canonical_cdp_url,
            executable_path=None,
            user_data_dir=None,
        )

    return ResolvedBrowserLaunch(
        cdp_url=None,
        executable_path=_resolve_executable(config.chrome_executable),
        user_data_dir=_resolve_dedicated_profile(config.chrome_user_data_dir),
    )


def browser_launch_for_slot(
    launch: ResolvedBrowserLaunch,
    slot: int,
) -> ResolvedBrowserLaunch:
    if not isinstance(slot, int) or isinstance(slot, bool) or slot < 0:
        raise BrowserConfigurationError("The browser slot is invalid")
    if slot == 0 or launch.cdp_url is not None:
        return launch
    if launch.executable_path is None or launch.user_data_dir is None:
        raise BrowserConfigurationError("Local Chrome configuration is incomplete")
    profile = launch.user_data_dir.with_name(
        f"{launch.user_data_dir.name}-slot-{slot + 1}"
    )
    return ResolvedBrowserLaunch(
        cdp_url=None,
        executable_path=launch.executable_path,
        user_data_dir=_resolve_dedicated_profile(profile),
    )


def _resolve_node_executable(configured: Path | None) -> Path:
    candidate = configured
    if candidate is None:
        discovered = shutil.which("node")
        candidate = Path(discovered) if discovered else None
    if candidate is None:
        raise BrowserConfigurationError("The Node executable is unavailable")
    try:
        resolved = candidate.expanduser().resolve(strict=True)
    except OSError:
        raise BrowserConfigurationError("The Node executable is unavailable") from None
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise BrowserConfigurationError("The Node executable is unavailable")
    return resolved


def _playwright_cli_workspace_roots() -> tuple[Path, ...]:
    module_path = Path(__file__).resolve()
    prefix = Path(sys.prefix).expanduser().resolve()
    current_directory = Path.cwd().resolve()
    roots = [
        module_path.parents[3],
        prefix,
        *prefix.parents,
        current_directory,
        *current_directory.parents,
    ]
    return tuple(dict.fromkeys(roots))


def default_playwright_cli_script() -> Path:
    relative_script = (
        Path("node_modules") / "@playwright" / "cli" / "playwright-cli.js"
    )
    roots = _playwright_cli_workspace_roots()
    fallback = roots[0] / relative_script
    for root in roots:
        candidate = root / relative_script
        try:
            if candidate.is_file():
                return candidate.resolve(strict=True)
        except OSError:
            continue
    detected = shutil.which("playwright-cli")
    if detected is not None:
        try:
            return Path(detected).expanduser().resolve(strict=True)
        except OSError:
            pass
    return fallback


def _resolve_cli_script(configured: Path | None) -> Path:
    candidate = (
        configured
        if configured is not None
        else default_playwright_cli_script()
    )
    try:
        resolved = candidate.expanduser().resolve(strict=True)
    except OSError:
        raise BrowserConfigurationError(
            "The Playwright CLI script is unavailable"
        ) from None
    if not resolved.is_file():
        raise BrowserConfigurationError(
            "The Playwright CLI script is unavailable"
        )
    return resolved


def _origin_for_url(value: str) -> str:
    validated = validate_job_url(value)
    parsed = urlsplit(validated)
    assert parsed.hostname is not None
    host = parsed.hostname.lower().rstrip(".")
    if ":" in host:
        host = f"[{host}]"
    port = parsed.port
    if (parsed.scheme.lower(), port) in {("https", 443), ("http", 80)}:
        port = None
    return validate_approved_origin(
        f"{parsed.scheme.lower()}://{host}{f':{port}' if port is not None else ''}"
    )


def _url_with_canonical_origin(value: str, origin: str) -> str:
    parsed = urlsplit(value)
    canonical = urlsplit(origin)
    return urlunsplit(
        (canonical.scheme, canonical.netloc, parsed.path, parsed.query, parsed.fragment)
    )


def _verification_private_values(url: str) -> tuple[str, ...]:
    parsed = urlsplit(url)
    values = {url}
    for encoded in (parsed.query, parsed.fragment):
        if not encoded:
            continue
        values.add(unquote(encoded))
        for _name, value in parse_qsl(encoded, keep_blank_values=False):
            if value:
                values.add(value)
    for encoded_segment in parsed.path.split("/"):
        segment = unquote(encoded_segment)
        if len(segment) >= 8:
            values.add(segment)
    return tuple(sorted(values, key=len, reverse=True))


def _atomic_write_private_json(path: Path, value: object) -> None:
    encoded = (json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n").encode(
        "utf-8"
    )
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            os.chmod(temporary.name, 0o600)
            temporary.write(encoded)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
        path.chmod(0o600)
    except OSError:
        raise BrowserConfigurationError(
            "The Playwright CLI session directory is unavailable"
        ) from None
    finally:
        if temporary_name is not None:
            try:
                Path(temporary_name).unlink(missing_ok=True)
            except OSError:
                pass


def _prepare_private_directory(path: Path) -> Path:
    try:
        if path.is_symlink():
            raise BrowserConfigurationError(
                "The Playwright CLI session directory is unavailable"
            )
        path.mkdir(mode=0o700, parents=False, exist_ok=True)
        if not path.is_dir() or path.is_symlink():
            raise BrowserConfigurationError(
                "The Playwright CLI session directory is unavailable"
            )
        path.chmod(0o700)
        if stat.S_IMODE(path.stat().st_mode) != 0o700:
            raise BrowserConfigurationError(
                "The Playwright CLI session directory must have mode 0700"
            )
        return path.resolve(strict=True)
    except BrowserConfigurationError:
        raise
    except OSError:
        raise BrowserConfigurationError(
            "The Playwright CLI session directory is unavailable"
        ) from None


def _create_private_temporary_directory(session_id: UUID) -> Path:
    temporary_directory: Path | None = None
    try:
        root = Path("/tmp").resolve(strict=True)
        if not root.is_dir():
            raise OSError
        temporary_directory = Path(
            tempfile.mkdtemp(
                prefix=f"jobhunter-pw-{session_id.hex[:8]}-",
                dir=root,
            )
        )
        temporary_directory.chmod(0o700)
        resolved = temporary_directory.resolve(strict=True)
        if (
            stat.S_IMODE(resolved.stat().st_mode) != 0o700
            or len(os.fsencode(resolved / _CHROME_SINGLETON_SOCKET_SUFFIX))
            >= _CHROME_SINGLETON_SOCKET_LIMIT
        ):
            raise OSError
        return resolved
    except OSError:
        if temporary_directory is not None:
            shutil.rmtree(temporary_directory, ignore_errors=True)
        raise BrowserConfigurationError(
            "The Playwright CLI temporary directory is unavailable"
        ) from None




def _remove_owned_temporary_directory(path: Path, session_id: UUID) -> None:
    root = Path("/tmp").resolve(strict=True)
    expected_prefix = f"jobhunter-pw-{session_id.hex[:8]}-"
    if (
        not path.is_absolute()
        or path.parent != root
        or not path.name.startswith(expected_prefix)
    ):
        raise BrowserConfigurationError(
            "The Playwright CLI temporary directory is unavailable"
        )
    try:
        details = path.lstat()
    except FileNotFoundError:
        return
    except OSError:
        raise BrowserConfigurationError(
            "The Playwright CLI temporary directory is unavailable"
        ) from None
    try:
        resolved = path.resolve(strict=True)
        if (
            stat.S_ISLNK(details.st_mode)
            or not stat.S_ISDIR(details.st_mode)
            or details.st_uid != os.getuid()
            or stat.S_IMODE(details.st_mode) != 0o700
            or resolved != path
        ):
            raise OSError
        shutil.rmtree(path)
    except OSError:
        raise BrowserConfigurationError(
            "The Playwright CLI temporary directory is unavailable"
        ) from None


def _remove_stale_private_sign_in_links(internal_directory: Path) -> None:
    try:
        details = internal_directory.lstat()
    except FileNotFoundError:
        return
    except OSError:
        raise BrowserConfigurationError(
            "The Playwright CLI private payload directory is unavailable"
        ) from None
    if (
        stat.S_ISLNK(details.st_mode)
        or not stat.S_ISDIR(details.st_mode)
        or details.st_uid != os.getuid()
    ):
        raise BrowserConfigurationError(
            "The Playwright CLI private payload directory is unavailable"
        )
    try:
        for candidate in internal_directory.iterdir():
            if (
                re.fullmatch(
                    r"\.(?:sign-in|restore)-[0-9a-f]{32}\.js",
                    candidate.name,
                )
                and candidate.is_symlink()
            ):
                candidate.unlink()
    except OSError:
        raise BrowserConfigurationError(
            "The Playwright CLI private payload directory is unavailable"
        ) from None
async def _default_process_factory(*argv: str, **kwargs: object) -> _Process:
    process = await asyncio.create_subprocess_exec(*argv, **kwargs)
    return cast(_Process, process)


async def _capture_recovery_stream(
    stream: _ReadableStream | None,
    capture: _BoundedCapture,
) -> None:
    if stream is None:
        return
    while True:
        chunk = await stream.read(16_384)
        if not chunk:
            return
        capture.append(chunk)


async def _terminate_recovery_process(process: _Process) -> None:
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except (ProcessLookupError, OSError):
        pass
    try:
        await asyncio.wait_for(
            process.wait(),
            timeout=_PROCESS_TERMINATE_GRACE_SECONDS,
        )
        return
    except (TimeoutError, ProcessLookupError, OSError):
        pass
    try:
        process.kill()
    except (ProcessLookupError, OSError):
        pass
    try:
        await asyncio.wait_for(
            process.wait(),
            timeout=_PROCESS_TERMINATE_GRACE_SECONDS,
        )
    except (TimeoutError, ProcessLookupError, OSError):
        pass


async def _run_recovery_close(
    *,
    node_executable: Path,
    cli_script: Path,
    session_name: str,
    session_directory: Path,
    home_directory: Path,
    process_factory: ProcessFactory,
) -> tuple[str, int | None]:
    environment = {
        "HOME": str(home_directory),
        "XDG_CONFIG_HOME": str(home_directory / ".config"),
        "NO_UPDATE_NOTIFIER": "1",
        "CI": "1",
    }
    for name in ("LANG", "LC_ALL", "PATH"):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    try:
        created = process_factory(
            str(node_executable),
            str(cli_script),
            f"--session={session_name}",
            "close",
            "--json",
            cwd=str(session_directory),
            env=environment,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        process = await created if inspect.isawaitable(created) else created
    except (OSError, TypeError, ValueError):
        raise BrowserConfigurationError(
            "A stale Playwright CLI session could not be reclaimed"
        ) from None
    owned_process = cast(_Process, process)
    stdout = _BoundedCapture(_MAX_CAPTURE_BYTES, bytearray())
    stderr = _BoundedCapture(_MAX_CAPTURE_BYTES, bytearray())
    wait_task = asyncio.create_task(owned_process.wait())
    stdout_task = asyncio.create_task(
        _capture_recovery_stream(owned_process.stdout, stdout)
    )
    stderr_task = asyncio.create_task(
        _capture_recovery_stream(owned_process.stderr, stderr)
    )
    try:
        await asyncio.wait_for(
            asyncio.gather(wait_task, stdout_task, stderr_task),
            timeout=_RECOVERY_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        await _terminate_recovery_process(owned_process)
        for task in (wait_task, stdout_task, stderr_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(
            wait_task,
            stdout_task,
            stderr_task,
            return_exceptions=True,
        )
        raise BrowserConfigurationError(
            "A stale Playwright CLI session could not be reclaimed"
        ) from None
    except asyncio.CancelledError:
        await _terminate_recovery_process(owned_process)
        for task in (wait_task, stdout_task, stderr_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(
            wait_task,
            stdout_task,
            stderr_task,
            return_exceptions=True,
        )
        raise
    except (OSError, TypeError, ValueError):
        await _terminate_recovery_process(owned_process)
        raise BrowserConfigurationError(
            "A stale Playwright CLI session could not be reclaimed"
        ) from None
    exit_code = owned_process.returncode
    if exit_code != 0:
        raise BrowserConfigurationError(
            "A stale Playwright CLI session could not be reclaimed"
        )
    try:
        payload = json.loads(bytes(stdout.data).decode("utf-8"))
        if (
            not isinstance(payload, dict)
            or payload.get("session") != session_name
            or payload.get("status") not in {"closed", "not-open"}
        ):
            raise TypeError
        status = cast(str, payload["status"])
    except (json.JSONDecodeError, KeyError, TypeError, UnicodeError):
        raise BrowserConfigurationError(
            "A stale Playwright CLI session could not be reclaimed"
        ) from None
    return status, exit_code


def _same_process_owner(process: psutil.Process) -> bool:
    if process.pid <= 1 or process.pid == os.getpid():
        return False
    try:
        if hasattr(os, "getuid"):
            return process.uids().real == os.getuid()
        return process.username() == psutil.Process().username()
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return False
    except (AttributeError, OSError, psutil.Error):
        raise BrowserConfigurationError(
            "An owned process could not be inspected"
        ) from None


def _process_identity(process: psutil.Process) -> tuple[int, float] | None:
    if not _same_process_owner(process):
        return None
    try:
        create_time = process.create_time()
        if create_time <= 0 or process.status() == psutil.STATUS_ZOMBIE:
            return None
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return None
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "An owned process could not be inspected"
        ) from None
    return process.pid, create_time


def _process_at_identity(pid: int, create_time: float) -> psutil.Process | None:
    try:
        process = psutil.Process(pid)
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return None
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "An owned process could not be inspected"
        ) from None
    identity = _process_identity(process)
    return process if identity == (pid, create_time) else None


def _process_matches_cli_daemon(
    process: psutil.Process,
    session_name: str,
) -> bool:
    if process.pid <= 1 or process.pid == os.getpid():
        return False
    try:
        if hasattr(os, "getuid"):
            same_owner = process.uids().real == os.getuid()
        else:
            same_owner = process.username() == psutil.Process().username()
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return False
    except (AttributeError, OSError, psutil.Error):
        raise BrowserConfigurationError(
            "A Playwright CLI daemon could not be inspected"
        ) from None
    if not same_owner:
        return False
    try:
        arguments = process.cmdline()
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return False
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "A Playwright CLI daemon could not be inspected"
        ) from None
    return session_name in arguments and any(
        Path(argument).name == "cliDaemon.js" for argument in arguments
    )


def _pid_matches_cli_daemon(pid: int, session_name: str) -> bool:
    try:
        process = psutil.Process(pid)
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return False
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "A Playwright CLI daemon could not be inspected"
        ) from None
    return _process_matches_cli_daemon(process, session_name)


def _matching_cli_daemon_pids(
    session_name: str,
    recorded_pid: int | None,
) -> tuple[int, ...]:
    candidates: set[int] = set()
    if recorded_pid is not None:
        candidates.add(recorded_pid)
    try:
        candidates.update(process.pid for process in psutil.process_iter())
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "Playwright CLI daemon ownership could not be enumerated"
        ) from None
    return tuple(
        pid
        for pid in sorted(candidates)
        if _pid_matches_cli_daemon(pid, session_name)
    )


def _terminate_verified_process_tree(
    root: psutil.Process,
    root_matches: Callable[[psutil.Process], bool],
) -> None:
    if not root_matches(root):
        return
    try:
        descendants = root.children(recursive=True)
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "An owned browser process tree could not be reclaimed"
        ) from None

    identities: list[tuple[int, float]] = []
    for process in (root, *descendants):
        identity = _process_identity(process)
        if identity is None:
            raise BrowserConfigurationError(
                "An owned browser process tree could not be reclaimed"
            )
        identities.append(identity)

    for index, (pid, create_time) in enumerate(identities):
        process = _process_at_identity(pid, create_time)
        if process is None:
            continue
        if index == 0 and not root_matches(process):
            raise BrowserConfigurationError(
                "An owned browser process tree could not be reclaimed"
            )
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            continue
        except (OSError, psutil.Error):
            raise BrowserConfigurationError(
                "An owned browser process tree could not be reclaimed"
            ) from None

    deadline = time.monotonic() + _RECOVERY_TERMINATE_GRACE_SECONDS
    while time.monotonic() < deadline:
        if not any(
            _process_at_identity(pid, create_time) is not None
            for pid, create_time in identities
        ):
            return
        time.sleep(0.05)

    for index, (pid, create_time) in enumerate(identities):
        process = _process_at_identity(pid, create_time)
        if process is None:
            continue
        if index == 0 and not root_matches(process):
            raise BrowserConfigurationError(
                "An owned browser process tree could not be reclaimed"
            )
        try:
            process.kill()
        except psutil.NoSuchProcess:
            continue
        except (OSError, psutil.Error):
            raise BrowserConfigurationError(
                "An owned browser process tree could not be reclaimed"
            ) from None

    deadline = time.monotonic() + _PROCESS_TERMINATE_GRACE_SECONDS
    while time.monotonic() < deadline:
        if not any(
            _process_at_identity(pid, create_time) is not None
            for pid, create_time in identities
        ):
            return
        time.sleep(0.05)
    raise BrowserConfigurationError(
        "An owned browser process tree could not be reclaimed"
    )


async def _terminate_owned_daemon(pid: int, session_name: str) -> None:
    try:
        process = psutil.Process(pid)
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "A stale Playwright CLI session could not be reclaimed"
        ) from None
    try:
        await asyncio.to_thread(
            _terminate_verified_process_tree,
            process,
            lambda candidate: _process_matches_cli_daemon(
                candidate,
                session_name,
            ),
        )
    except BrowserConfigurationError:
        raise BrowserConfigurationError(
            "A stale Playwright CLI session could not be reclaimed"
        ) from None


def _native_browser_process_identity(
    process: psutil.Process,
    user_data_dir: Path,
) -> tuple[int, float, Path] | None:
    identity = _process_identity(process)
    if identity is None:
        return None
    expected_profile_argument = f"--user-data-dir={user_data_dir}"
    try:
        arguments = process.cmdline()
        if (
            arguments.count(expected_profile_argument) != 1
            or any(argument.startswith("--type=") for argument in arguments)
        ):
            return None
        executable = Path(process.exe()).resolve(strict=True)
        if not executable.is_file():
            return None
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return None
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "An owned native browser could not be inspected"
        ) from None
    return identity[0], identity[1], executable


def _native_browser_processes_for_profile(
    user_data_dir: Path,
) -> tuple[tuple[int, float, Path], ...]:
    candidates: list[tuple[int, float, Path]] = []
    try:
        processes = psutil.process_iter()
        for process in processes:
            identity = _native_browser_process_identity(process, user_data_dir)
            if identity is not None:
                candidates.append(identity)
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "An owned native browser could not be identified"
        ) from None
    return tuple(sorted(candidates, key=lambda candidate: candidate[0]))


def _discover_owned_native_browser(
    daemon_pid: int,
    session_name: str,
    user_data_dir: Path,
) -> tuple[int, float, Path]:
    try:
        daemon = psutil.Process(daemon_pid)
        if not _process_matches_cli_daemon(daemon, session_name):
            raise BrowserConfigurationError(
                "The Playwright CLI daemon identity is invalid"
            )
        descendants = daemon.children(recursive=True)
    except BrowserConfigurationError:
        raise
    except (OSError, psutil.Error):
        raise BrowserConfigurationError(
            "The owned native browser could not be identified"
        ) from None
    candidates = tuple(
        identity
        for process in descendants
        if (
            identity := _native_browser_process_identity(
                process,
                user_data_dir,
            )
        )
        is not None
    )
    if len(candidates) != 1:
        raise BrowserConfigurationError(
            "The owned native browser could not be identified"
        )
    return candidates[0]


def _same_resolved_path(left: Path, right: Path) -> bool:
    return os.path.normcase(str(left)) == os.path.normcase(str(right))


def _matching_native_browser_processes(
    executable_path: Path,
    user_data_dir: Path,
    recorded_pid: int,
    recorded_create_time: float,
) -> tuple[tuple[int, float], ...]:
    candidates = _native_browser_processes_for_profile(user_data_dir)
    if not candidates:
        return ()
    if len(candidates) != 1:
        raise BrowserConfigurationError(
            "The owned native browser identity is ambiguous"
        )
    pid, create_time, actual_executable = candidates[0]
    if (
        pid != recorded_pid
        or create_time != recorded_create_time
        or not _same_resolved_path(actual_executable, executable_path)
    ):
        raise BrowserConfigurationError(
            "The owned native browser identity changed"
        )
    return ((pid, create_time),)


async def _terminate_owned_native_browser(
    pid: int,
    create_time: float,
    executable_path: Path,
    user_data_dir: Path,
) -> None:
    process = _process_at_identity(pid, create_time)
    if process is None:
        return

    def matches(candidate: psutil.Process) -> bool:
        identity = _native_browser_process_identity(candidate, user_data_dir)
        return (
            identity is not None
            and identity[0] == pid
            and identity[1] == create_time
            and _same_resolved_path(identity[2], executable_path)
        )

    await asyncio.to_thread(_terminate_verified_process_tree, process, matches)


async def _reclaim_native_browser(
    ownership: _NativeBrowserOwnership | None,
) -> None:
    if ownership is None:
        return
    if (
        ownership.executable is not None
        and ownership.pid is not None
        and ownership.create_time is not None
    ):
        matches = _matching_native_browser_processes(
            ownership.executable,
            ownership.user_data_dir,
            ownership.pid,
            ownership.create_time,
        )
        if matches:
            await _terminate_owned_native_browser(
                matches[0][0],
                matches[0][1],
                ownership.executable,
                ownership.user_data_dir,
            )
    else:
        if _native_browser_processes_for_profile(ownership.user_data_dir):
            raise BrowserConfigurationError(
                "The native browser process identity was not journaled"
            )
        return
    if _native_browser_processes_for_profile(ownership.user_data_dir):
        raise BrowserConfigurationError(
            "The owned native browser could not be reclaimed"
        )


def _parse_native_browser_ownership(
    payload: dict[str, object],
) -> _NativeBrowserOwnership | None:
    raw_launcher = payload.get("native_launcher")
    raw_user_data_dir = payload.get("native_user_data_dir")
    raw_executable = payload.get("native_executable")
    raw_pid = payload.get("native_browser_pid")
    raw_create_time = payload.get("native_browser_create_time")
    values = (
        raw_launcher,
        raw_user_data_dir,
        raw_executable,
        raw_pid,
        raw_create_time,
    )
    if all(value is None for value in values):
        return None
    if not isinstance(raw_launcher, str) or not isinstance(raw_user_data_dir, str):
        raise BrowserConfigurationError(
            "A stale native browser ownership record is invalid"
        )
    try:
        launcher = Path(raw_launcher).resolve(strict=True)
        profile_input = Path(raw_user_data_dir)
        _reject_symlink_components(
            profile_input,
            "A stale native browser ownership record is invalid",
        )
        user_data_dir = profile_input.resolve(strict=True)
        if (
            not launcher.is_file()
            or not os.access(launcher, os.X_OK)
            or not user_data_dir.is_dir()
            or user_data_dir.is_symlink()
        ):
            raise OSError
    except (BrowserConfigurationError, OSError):
        raise BrowserConfigurationError(
            "A stale native browser ownership record is invalid"
        ) from None

    identity_values = (raw_executable, raw_pid, raw_create_time)
    if all(value is None for value in identity_values):
        return _NativeBrowserOwnership(
            launcher=launcher,
            user_data_dir=user_data_dir,
        )
    if (
        not isinstance(raw_executable, str)
        or not isinstance(raw_pid, int)
        or isinstance(raw_pid, bool)
        or raw_pid <= 1
        or not isinstance(raw_create_time, (int, float))
        or isinstance(raw_create_time, bool)
        or not math.isfinite(raw_create_time)
        or raw_create_time <= 0
    ):
        raise BrowserConfigurationError(
            "A stale native browser ownership record is invalid"
        )
    try:
        executable = Path(raw_executable).resolve(strict=True)
        if not executable.is_file():
            raise OSError
    except OSError:
        raise BrowserConfigurationError(
            "A stale native browser ownership record is invalid"
        ) from None
    return _NativeBrowserOwnership(
        launcher=launcher,
        user_data_dir=user_data_dir,
        executable=executable,
        pid=raw_pid,
        create_time=float(raw_create_time),
    )


async def recover_stale_playwright_cli_sessions(
    *,
    artifacts_root: Path,
    node_executable: Path | None = None,
    cli_script: Path | None = None,
    process_factory: ProcessFactory | None = None,
) -> None:
    """Reclaim durable CLI ownership markers left by an interrupted harness."""

    expanded_root = artifacts_root.expanduser()
    if not expanded_root.exists():
        return
    try:
        if expanded_root.is_symlink():
            raise OSError
        root = expanded_root.resolve(strict=True)
        if not root.is_dir():
            raise OSError
    except OSError:
        raise BrowserConfigurationError(
            "The application artifact directory is unavailable"
        ) from None
    resolved_node = _resolve_node_executable(node_executable)
    resolved_cli = _resolve_cli_script(cli_script)
    factory = process_factory or _default_process_factory
    try:
        candidates = sorted(root.iterdir(), key=lambda path: path.name)
    except OSError:
        raise BrowserConfigurationError(
            "The application artifact directory is unavailable"
        ) from None
    for candidate in candidates:
        try:
            session_id = UUID(candidate.name)
        except ValueError:
            continue
        if str(session_id) != candidate.name or candidate.is_symlink():
            continue
        try:
            session_directory = candidate.resolve(strict=True)
            if not session_directory.is_dir() or not _is_within(session_directory, root):
                raise OSError
            scope_directory = session_directory / "playwright-cli"
            ownership_path = scope_directory / "ownership.json"
            if not ownership_path.exists():
                continue
            if (
                scope_directory.is_symlink()
                or ownership_path.is_symlink()
                or not ownership_path.is_file()
                or ownership_path.stat().st_size > 4_096
            ):
                raise OSError
            payload = json.loads(ownership_path.read_text(encoding="utf-8"))
            expected_name = f"jobhunter-{session_id.hex}"
            if (
                not isinstance(payload, dict)
                or payload.get("session_name") != expected_name
            ):
                raise OSError
            raw_pid = payload.get("daemon_pid")
            if raw_pid is not None and (
                not isinstance(raw_pid, int)
                or isinstance(raw_pid, bool)
                or raw_pid <= 1
            ):
                raise OSError
            daemon_pid = cast(int | None, raw_pid)
            native_ownership = _parse_native_browser_ownership(payload)
            raw_temporary_directory = payload.get("temporary_directory")
            if not isinstance(raw_temporary_directory, str):
                raise OSError
            temporary_directory = Path(raw_temporary_directory)
            temporary_root = Path("/tmp").resolve(strict=True)
            if (
                not temporary_directory.is_absolute()
                or temporary_directory.parent != temporary_root
                or not temporary_directory.name.startswith(
                    f"jobhunter-pw-{session_id.hex[:8]}-"
                )
            ):
                raise OSError
            home_directory = (scope_directory / "home").resolve(strict=True)
            if (
                not home_directory.is_dir()
                or home_directory.is_symlink()
                or not _is_within(home_directory, scope_directory)
            ):
                raise OSError
            scope_directory.chmod(0o700)
            home_directory.chmod(0o700)
            ownership_path.chmod(0o600)
        except (
            BrowserConfigurationError,
            json.JSONDecodeError,
            OSError,
            UnicodeError,
        ):
            raise BrowserConfigurationError(
                "A stale Playwright CLI ownership record is invalid"
            ) from None

        _status, _exit_code = await _run_recovery_close(
            node_executable=resolved_node,
            cli_script=resolved_cli,
            session_name=expected_name,
            session_directory=session_directory,
            home_directory=home_directory,
            process_factory=factory,
        )
        for pid in _matching_cli_daemon_pids(expected_name, daemon_pid):
            await _terminate_owned_daemon(pid, expected_name)
        if _matching_cli_daemon_pids(expected_name, daemon_pid):
            raise BrowserConfigurationError(
                "A stale Playwright CLI session could not be reclaimed"
            )
        await _reclaim_native_browser(native_ownership)
        try:
            _remove_owned_temporary_directory(temporary_directory, session_id)
        except BrowserConfigurationError:
            raise BrowserConfigurationError(
                "A stale Playwright CLI temporary directory could not be cleared"
            ) from None
        _remove_stale_private_sign_in_links(scope_directory / "internal")
        try:
            ownership_path.unlink()
        except OSError:
            raise BrowserConfigurationError(
                "A stale Playwright CLI ownership record could not be cleared"
            ) from None


class PlaywrightCliRuntime:
    """Own one fixed Playwright CLI browser session and its private artifacts."""

    def __init__(
        self,
        *,
        session_id: UUID,
        launch: ResolvedBrowserLaunch,
        session_directory: Path,
        node_executable: Path | None = None,
        cli_script: Path | None = None,
        process_factory: ProcessFactory | None = None,
    ) -> None:
        if not isinstance(session_id, UUID):
            raise BrowserConfigurationError("The Playwright CLI session is invalid")

        try:
            root = session_directory.expanduser().resolve(strict=True)
        except OSError:
            raise BrowserConfigurationError(
                "The Playwright CLI session directory is unavailable"
            ) from None
        if not root.is_dir() or root.is_symlink():
            raise BrowserConfigurationError(
                "The Playwright CLI session directory is unavailable"
            )
        try:
            root.chmod(0o700)
        except OSError:
            raise BrowserConfigurationError(
                "The Playwright CLI session directory is unavailable"
            ) from None

        self._session_id = session_id
        self._session_name = f"jobhunter-{session_id.hex}"
        self._launch = launch
        self._session_directory = root
        self._scope_directory = _prepare_private_directory(root / "playwright-cli")
        self._output_directory = _prepare_private_directory(
            self._scope_directory / "output"
        )
        self._internal_directory = _prepare_private_directory(
            self._scope_directory / "internal"
        )
        self._video_directory = _prepare_private_directory(
            self._scope_directory / "video"
        )
        self._home_directory = _prepare_private_directory(self._scope_directory / "home")
        self._node_executable = _resolve_node_executable(node_executable)
        self._cli_script = _resolve_cli_script(cli_script)
        self._process_factory = process_factory or _default_process_factory
        self._operation_lock = asyncio.Lock()
        self._opened = False
        self._open_attempted = False
        self._daemon_process_id: int | None = None
        self._native_browser_process_id: int | None = None
        self._native_browser_create_time: float | None = None
        self._native_browser_executable: Path | None = None
        self._started = False
        self._closed = False
        self._video_started = False
        self._artifact_monitor_task: asyncio.Task[None] | None = None
        self._video_budget_exceeded = False
        self._guard_armed = False
        self._approved_origins: tuple[str, ...] = ()
        self._current_metadata: _PageMetadata | None = None
        self._active_process: _Process | None = None
        self._observation_number = 0
        self._screenshots_suppressed = False
        self._config_path = self._scope_directory / "cli.config.json"
        self._ownership_path = self._scope_directory / "ownership.json"
        self._video_path = self._video_directory / "session.webm"
        self._playwright_browsers_path = os.environ.get(
            "PLAYWRIGHT_BROWSERS_PATH",
            str(Path.home() / ".cache" / "ms-playwright"),
        )
        self._write_config()
        self._temporary_directory = _create_private_temporary_directory(session_id)
        try:
            self._write_ownership()
        except BrowserConfigurationError:
            shutil.rmtree(self._temporary_directory, ignore_errors=True)
            raise
        self._environment = self._build_environment()
        self._private_values = self._build_private_values()
        self._applicant_values: tuple[str, ...] = ()
        self._runtime_private_values: tuple[str, ...] = ()
        self._applicant_redaction_enabled = False
        self._refresh_private_redaction_values()

    async def activate_private_values(self, values: Iterable[str]) -> None:
        async with self._operation_lock:
            if not self._opened or self._closed:
                raise PlaywrightCliRuntimeError("browser_failed")
            self._activate_private_values_unlocked(values)

    async def verify_origin_and_activate_private_values(
        self,
        expected_origin: str,
        values: Iterable[str],
    ) -> str | None:
        async with self._operation_lock:
            if not self._started or self._closed:
                raise PlaywrightCliRuntimeError("browser_failed")
            try:
                canonical_origin = validate_approved_origin(expected_origin)
            except (TypeError, ValueError):
                raise PlaywrightCliRuntimeError("browser_failed") from None
            if canonical_origin != expected_origin:
                raise PlaywrightCliRuntimeError("browser_failed")
            metadata = await self._metadata()
            try:
                live_origin = _origin_for_url(metadata.url)
            except (TypeError, ValueError):
                return None
            if live_origin != canonical_origin:
                return None
            self._activate_private_values_unlocked(values)
            refreshed_metadata = await self._metadata()
            try:
                refreshed_origin = _origin_for_url(refreshed_metadata.url)
            except (TypeError, ValueError):
                return None
            if refreshed_origin != canonical_origin:
                return None
            self._current_metadata = refreshed_metadata
            return refreshed_origin

    async def suppress_private_capture(self) -> None:
        async with self._operation_lock:
            await self._suppress_private_capture_unlocked()

    async def _suppress_private_capture_unlocked(self) -> None:
        if not self._started or self._closed:
            raise PlaywrightCliRuntimeError("browser_failed")
        self._screenshots_suppressed = True
        if self._video_started:
            try:
                stopped = await self._invoke("video-stop")
                self._require_success(stopped)
            except PlaywrightCliRuntimeError:
                try:
                    await self._emergency_budget_cleanup_unlocked()
                except PlaywrightCliRuntimeError:
                    self._started = False
                    self._guard_armed = False
                raise
            self._video_started = False

    async def sign_in(
        self,
        *,
        expected_origin: str,
        username_ref: str,
        password_ref: str,
        password_confirmation_ref: str | None = None,
        submit_ref: str,
        username: str,
        password: str,
    ) -> None:
        async with self._operation_lock:
            await self._suppress_private_capture_unlocked()
            await self._sign_in_unlocked(
                expected_origin=expected_origin,
                username_ref=username_ref,
                password_ref=password_ref,
                password_confirmation_ref=password_confirmation_ref,
                submit_ref=submit_ref,
                username=username,
                password=password,
            )

    async def _sign_in_unlocked(
        self,
        *,
        expected_origin: str,
        username_ref: str,
        password_ref: str,
        password_confirmation_ref: str | None,
        submit_ref: str,
        username: str,
        password: str,
    ) -> None:
        if not self._started or self._closed:
            raise PlaywrightCliRuntimeError("browser_failed")
        try:
            canonical_origin = validate_approved_origin(expected_origin)
        except (TypeError, ValueError):
            raise PlaywrightCliRuntimeError("browser_failed") from None
        if canonical_origin != expected_origin:
            raise PlaywrightCliRuntimeError("browser_failed")
        refs = tuple(
            ref
            for ref in (
                username_ref,
                password_ref,
                password_confirmation_ref,
                submit_ref,
            )
            if ref is not None
        )
        if any(
            not isinstance(ref, str) or _ELEMENT_REF_PATTERN.fullmatch(ref) is None
            for ref in refs
        ):
            raise PlaywrightCliRuntimeError("browser_failed")
        if (
            not isinstance(username, str)
            or username != username.strip()
            or not 1 <= len(username) <= 320
            or not _is_unicode_scalar_text(username)
            or "\x00" in username
            or not isinstance(password, str)
            or not 1 <= len(password) <= 4_096
            or not _is_unicode_scalar_text(password)
            or "\x00" in password
        ):
            raise PlaywrightCliRuntimeError("browser_failed")

        pre_metadata = await self._metadata()
        try:
            current_origin = _origin_for_url(pre_metadata.url)
        except (TypeError, ValueError):
            raise PlaywrightCliRuntimeError("browser_failed") from None
        if current_origin != canonical_origin:
            raise PlaywrightCliRuntimeError("browser_failed")

        self._activate_private_values_unlocked((username, password))
        script = self._private_sign_in_script(
            expected_origin=canonical_origin,
            username_ref=username_ref,
            password_ref=password_ref,
            password_confirmation_ref=password_confirmation_ref,
            submit_ref=submit_ref,
            username=username,
            password=password,
        )
        result = await self._invoke_private_script_unlocked(
            script,
            label="sign-in",
        )
        self._snapshot_from_execution(result, remove_file=True)
        self._require_success(result)

        post_metadata = await self._metadata()
        if self._guard_armed and not self._url_is_allowed(
            post_metadata.url,
            self._approved_origins,
        ):
            await self._restore_allowed_page(pre_metadata, post_metadata)
            raise PlaywrightCliRuntimeError("browser_failed")
        self._current_metadata = post_metadata
        if self._directory_size_exceeds(
            self._output_directory,
            _MAX_OUTPUT_DIRECTORY_BYTES,
        ):
            await self._emergency_budget_cleanup_unlocked()
            raise PlaywrightCliRuntimeError("browser_failed")

    async def complete_email_verification(
        self,
        *,
        expected_origin: str,
        challenge: VerificationChallenge,
        code_ref: str | None,
        submit_ref: str | None,
    ) -> bool:
        async with self._operation_lock:
            if not self._started or self._closed:
                raise PlaywrightCliRuntimeError("browser_failed")
            try:
                canonical_origins = (validate_approved_origin(expected_origin),)
            except (TypeError, ValueError):
                raise PlaywrightCliRuntimeError("browser_failed") from None
            try:
                pre_metadata = await self._metadata()
                current_origin = _origin_for_url(pre_metadata.url)
            except (TypeError, ValueError):
                raise PlaywrightCliRuntimeError("browser_failed") from None
            if current_origin not in canonical_origins:
                return False

            expected_origin = canonical_origins[0]
            code: str | None = None
            origin_binding_url: str | None = None
            for candidate in challenge.urls:
                try:
                    parsed = urlsplit(candidate)
                    origin = _origin_for_url(candidate)
                except (TypeError, ValueError):
                    continue
                if (
                    parsed.scheme.lower() == "https"
                    and parsed.username is None
                    and parsed.password is None
                    and len(candidate) <= 4_096
                    and origin == expected_origin
                ):
                    origin_binding_url = _url_with_canonical_origin(candidate, origin)
                    break
            if origin_binding_url is None:
                return False
            verification_url: str | None
            if code_ref is not None and challenge.codes:
                code = challenge.codes[0]
                verification_url = None
            else:
                verification_url = origin_binding_url
            if code is not None:
                if (
                    _ELEMENT_REF_PATTERN.fullmatch(code_ref or "") is None
                    or (
                        submit_ref is not None
                        and _ELEMENT_REF_PATTERN.fullmatch(submit_ref) is None
                    )
                    or not 1 <= len(code) <= 128
                    or "\x00" in code
                    or not _is_unicode_scalar_text(code)
                ):
                    raise PlaywrightCliRuntimeError("browser_failed")
            elif code_ref is not None or submit_ref is not None:
                code_ref = submit_ref = None

            await self._suppress_private_capture_unlocked()
            private_values = (
                (code,)
                if code is not None
                else _verification_private_values(verification_url or "")
            )
            self._activate_runtime_private_values_unlocked(private_values)
            script = self._private_email_verification_script(
                expected_origin=expected_origin,
                code_ref=code_ref,
                submit_ref=submit_ref,
                code=code,
                verification_url=verification_url,
            )
            result = await self._invoke_private_script_unlocked(
                script,
                label="verification",
            )
            self._snapshot_from_execution(result, remove_file=True)
            self._require_success(result)
            post_metadata = await self._metadata()
            if self._guard_armed and not self._url_is_allowed(
                post_metadata.url,
                self._approved_origins,
            ):
                await self._restore_allowed_page(pre_metadata, post_metadata)
                raise PlaywrightCliRuntimeError("browser_failed")
            self._current_metadata = post_metadata
            if self._directory_size_exceeds(
                self._output_directory,
                _MAX_OUTPUT_DIRECTORY_BYTES,
            ):
                await self._emergency_budget_cleanup_unlocked()
                raise PlaywrightCliRuntimeError("browser_failed")
            return True

    def _activate_private_values_unlocked(self, values: Iterable[str]) -> None:
        applicant_values = set(self._applicant_values)
        applicant_values.update(
            value for value in values if isinstance(value, str) and value
        )
        self._applicant_values = tuple(
            sorted(applicant_values, key=len, reverse=True)
        )
        self._refresh_private_redaction_values()
        self._current_metadata = None
        self._screenshots_suppressed = True

    def _activate_runtime_private_values_unlocked(
        self,
        values: Iterable[str],
    ) -> None:
        private_values = set(self._runtime_private_values)
        private_values.update(
            value for value in values if isinstance(value, str) and value
        )
        self._runtime_private_values = tuple(
            sorted(private_values, key=len, reverse=True)
        )
        self._refresh_private_redaction_values()
        self._current_metadata = None
        self._screenshots_suppressed = True

    def _set_applicant_redaction_enabled(self, enabled: bool) -> None:
        effective = enabled and bool(self._applicant_values)
        if self._applicant_redaction_enabled == effective:
            return
        self._applicant_redaction_enabled = effective
        self._refresh_private_redaction_values()
        self._current_metadata = None

    def _refresh_private_redaction_values(self) -> None:
        always_private_values = (
            *self._private_values,
            *self._runtime_private_values,
        )
        values = (
            (*always_private_values, *self._applicant_values)
            if self._applicant_redaction_enabled
            else always_private_values
        )
        self._private_redaction_values = _private_redaction_fragments(values)
        # Fragment strings are the only persistent redaction index.
        # Boundary redaction below performs no per-character metadata caching.

    @property
    def session_name(self) -> str:
        return self._session_name

    def _write_config(self) -> None:
        browser: dict[str, object] = {
            "browserName": "chromium",
            "contextOptions": {"acceptDownloads": False},
        }
        if self._launch.cdp_url is not None:
            browser.update(
                {
                    "cdpEndpoint": self._launch.cdp_url,
                    "isolated": True,
                }
            )
        else:
            if self._launch.executable_path is None or self._launch.user_data_dir is None:
                raise BrowserConfigurationError(
                    "Local Chrome configuration is incomplete"
                )
            browser.update(
                {
                    "userDataDir": str(self._launch.user_data_dir),
                    "launchOptions": {
                        "headless": False,
                        "executablePath": str(self._launch.executable_path),
                        "args": list(_FOCUS_SUPPRESSION_ARGS),
                        "chromiumSandbox": True,
                    },
                }
            )
        config = {
            "browser": browser,
            "outputDir": str(self._output_directory),
            "outputMode": "stdout",
            "allowUnrestrictedFileAccess": False,
            "codegen": "none",
            "snapshot": {"mode": "none"},
            "console": {"level": "none"},
        }
        _atomic_write_private_json(self._config_path, config)

    def _build_environment(self) -> dict[str, str]:
        environment = {
            "HOME": str(self._home_directory),
            "TMPDIR": str(self._temporary_directory),
            "XDG_CONFIG_HOME": str(self._home_directory / ".config"),
            "NO_UPDATE_NOTIFIER": "1",
            "CI": "1",
            "PLAYWRIGHT_BROWSERS_PATH": self._playwright_browsers_path,
        }
        for name in (
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
            "PULSE_SERVER",
            "LANG",
            "LC_ALL",
            "PATH",
            "WSLENV",
            "WSL_INTEROP",
        ):
            value = os.environ.get(name)
            if value:
                environment[name] = value
        return environment

    def _build_private_values(self) -> tuple[str, ...]:
        values: list[str] = [
            str(self._session_directory),
            str(self._scope_directory),
            str(self._output_directory),
            str(self._internal_directory),
            str(self._video_directory),
            str(self._home_directory),
            str(self._temporary_directory),
            str(self._node_executable),
            str(self._cli_script),
            str(self._config_path),
            self._session_name,
            self._playwright_browsers_path,
        ]
        if self._launch.cdp_url:
            values.append(self._launch.cdp_url)
        if self._launch.executable_path:
            values.append(str(self._launch.executable_path))
        if self._launch.user_data_dir:
            values.append(str(self._launch.user_data_dir))
        return tuple(sorted(set(values), key=len, reverse=True))


    def _argv(self, command: str, args: Sequence[str]) -> list[str]:
        return [
            str(self._node_executable),
            str(self._cli_script),
            f"--session={self._session_name}",
            command,
            *args,
            "--json",
        ]

    async def _spawn(self, argv: Sequence[str]) -> _Process:
        try:
            created = self._process_factory(
                *argv,
                cwd=str(self._session_directory),
                env=self._environment,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            process = await created if inspect.isawaitable(created) else created
        except (OSError, ValueError, TypeError):
            raise PlaywrightCliRuntimeError("browser_failed") from None
        return cast(_Process, process)

    async def _pump_stream(
        self,
        stream: _ReadableStream | None,
        capture: _BoundedCapture,
    ) -> None:
        if stream is None:
            return
        while True:
            chunk = await stream.read(16_384)
            if not chunk:
                return
            capture.append(chunk)

    async def _terminate_process(self, process: _Process) -> None:
        if process.returncode is not None:
            return
        try:
            process.terminate()
        except (ProcessLookupError, OSError):
            pass
        try:
            await asyncio.wait_for(
                process.wait(), timeout=_PROCESS_TERMINATE_GRACE_SECONDS
            )
            return
        except (TimeoutError, ProcessLookupError, OSError):
            pass
        try:
            process.kill()
        except (ProcessLookupError, OSError):
            pass
        try:
            await asyncio.wait_for(
                process.wait(), timeout=_PROCESS_TERMINATE_GRACE_SECONDS
            )
        except (TimeoutError, ProcessLookupError, OSError):
            pass

    async def _stop_failed_invocation(
        self,
        process: _Process,
        wait_task: asyncio.Task[int],
        stdout_task: asyncio.Task[None],
        stderr_task: asyncio.Task[None],
    ) -> None:
        async def stop() -> None:
            await self._terminate_process(process)
            for task in (wait_task, stdout_task, stderr_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(
                wait_task,
                stdout_task,
                stderr_task,
                return_exceptions=True,
            )

        stop_task = asyncio.create_task(stop())
        try:
            await asyncio.shield(stop_task)
        except asyncio.CancelledError:
            await stop_task
            raise

    async def _invoke(
        self,
        command: str,
        args: Sequence[str] = (),
        *,
        timeout: float | None = None,
        capture_limit: int = _MAX_CAPTURE_BYTES,
    ) -> _InvocationResult:
        process = await self._spawn(self._argv(command, args))
        self._active_process = process
        stdout_capture = _BoundedCapture(capture_limit, bytearray())
        stderr_capture = _BoundedCapture(capture_limit, bytearray())
        stdout_task = asyncio.create_task(
            self._pump_stream(process.stdout, stdout_capture)
        )
        stderr_task = asyncio.create_task(
            self._pump_stream(process.stderr, stderr_capture)
        )
        wait_task = asyncio.create_task(process.wait())
        timed_out = False
        try:
            invocation = asyncio.gather(wait_task, stdout_task, stderr_task)
            if timeout is None:
                await invocation
            else:
                await asyncio.wait_for(invocation, timeout=timeout)
        except TimeoutError:
            timed_out = True
            await self._stop_failed_invocation(
                process,
                wait_task,
                stdout_task,
                stderr_task,
            )
        except asyncio.CancelledError:
            await self._stop_failed_invocation(
                process,
                wait_task,
                stdout_task,
                stderr_task,
            )
            raise
        except (OSError, ValueError, TypeError):
            await self._stop_failed_invocation(
                process,
                wait_task,
                stdout_task,
                stderr_task,
            )
            raise PlaywrightCliRuntimeError("browser_failed") from None
        finally:
            if self._active_process is process:
                self._active_process = None

        exit_code = 124 if timed_out else process.returncode
        if not isinstance(exit_code, int):
            exit_code = -1
        return _InvocationResult(
            exit_code=exit_code,
            timed_out=timed_out,
            stdout=bytes(stdout_capture.data),
            stderr=bytes(stderr_capture.data),
            stdout_truncated=stdout_capture.truncated,
            stderr_truncated=stderr_capture.truncated,
        )

    @staticmethod
    def _reported_cli_error(result: _InvocationResult) -> bool:
        try:
            payload = json.loads(result.stdout.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeError):
            return False
        return isinstance(payload, dict) and payload.get("isError") is True

    @staticmethod
    def _blocked_by_modal_state(result: _InvocationResult) -> bool:
        try:
            payload = json.loads(result.stdout.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeError):
            return False
        if not isinstance(payload, dict) or payload.get("isError") is not True:
            return False
        message = payload.get("error")
        return isinstance(message, str) and message.endswith(
            "does not handle the modal state."
        )

    def _require_success(self, result: _InvocationResult) -> None:
        if result.exit_code != 0 or self._reported_cli_error(result):
            raise PlaywrightCliRuntimeError("browser_failed")

    def _report_guard_suspension_failure(
        self,
        *,
        error_category: Literal[
            "process_exit",
            "cli_error",
            "runtime_error",
        ],
        exit_code: int | None,
        reported_cli_error: bool,
        stdout_truncated: bool,
        stderr_truncated: bool,
    ) -> None:
        try:
            logger.error(
                json.dumps(
                    {
                        "event": "playwright_cli_lifecycle_failure",
                        "sessionId": str(self._session_id),
                        "operation": "suspend_navigation_guard",
                        "errorCategory": error_category,
                        "exitCode": exit_code,
                        "reportedCliError": reported_cli_error,
                        "stdoutTruncated": stdout_truncated,
                        "stderrTruncated": stderr_truncated,
                    },
                    separators=(",", ":"),
                )
            )
        except Exception:
            pass

    async def start(self, job_url: str) -> None:
        async with self._operation_lock:
            if self._started or self._opened or self._closed:
                raise PlaywrightCliRuntimeError("browser_failed")
            try:
                validated_url = validate_job_url(job_url)
                origin = _origin_for_url(validated_url)
            except (TypeError, ValueError):
                raise PlaywrightCliRuntimeError("browser_failed") from None

            open_args = ["about:blank", f"--config={self._config_path}"]
            if self._launch.cdp_url is None:
                assert self._launch.user_data_dir is not None
                open_args.append(f"--profile={self._launch.user_data_dir}")
            try:
                self._open_attempted = True
                self._write_ownership()
                opened = await self._invoke("open", open_args)
                self._require_success(opened)
                self._opened = True
                self._daemon_process_id = self._daemon_pid(opened)
                self._write_ownership()
                await self._record_native_browser_ownership()
                await self._install_navigation_guard((origin,))
                video = await self._invoke(
                    "video-start",
                    [str(self._video_path)],
                )
                self._require_success(video)
                self._video_started = True
                self._artifact_monitor_task = asyncio.create_task(
                    self._monitor_artifact_budget(),
                    name=f"playwright-video-budget-{self._session_id}",
                )
                navigated = await self._invoke("goto", [validated_url])
                self._require_success(navigated)
                metadata = await self._metadata()
                if not self._url_is_allowed(metadata.url, (origin,)):
                    raise PlaywrightCliRuntimeError("browser_failed")
                self._current_metadata = metadata
                self._started = True
            except BaseException:
                try:
                    await self._cleanup_unlocked()
                except BaseException:
                    pass
                raise

    async def _record_native_browser_ownership(self) -> None:
        if self._launch.cdp_url is not None:
            return
        if (
            self._daemon_process_id is None
            or self._launch.user_data_dir is None
        ):
            raise PlaywrightCliRuntimeError("browser_failed")
        while True:
            try:
                pid, create_time, executable = _discover_owned_native_browser(
                    self._daemon_process_id,
                    self._session_name,
                    self._launch.user_data_dir,
                )
                break
            except BrowserConfigurationError:
                await asyncio.sleep(0.05)
        self._native_browser_process_id = pid
        self._native_browser_create_time = create_time
        self._native_browser_executable = executable
        self._write_ownership()

    @staticmethod
    def _private_sign_in_script(
        *,
        expected_origin: str,
        username_ref: str,
        password_ref: str,
        password_confirmation_ref: str | None,
        submit_ref: str,
        username: str,
        password: str,
    ) -> str:
        confirmation_element = (
            "const passwordConfirmationElement=null;"
            if password_confirmation_ref is None
            else (
                "const passwordConfirmationElement=await page.locator("
                f"'aria-ref={password_confirmation_ref}').elementHandle();"
            )
        )
        elements = (
            "[usernameElement,passwordElement,submitElement]"
            if password_confirmation_ref is None
            else (
                "[usernameElement,passwordElement,"
                "passwordConfirmationElement,submitElement]"
            )
        )
        confirmation_fill = (
            ""
            if password_confirmation_ref is None
            else "await passwordConfirmationElement.fill(password);"
        )
        return (
            "async (page) => {"
            f"const expectedOrigin={json.dumps(expected_origin)};"
            f"const username={json.dumps(username)};"
            f"const password={json.dumps(password)};"
            f"{_EXACT_ORIGIN_MATCHER_SCRIPT}"
            "if(!hasExactOrigin(page.url(),expectedOrigin))"
            "throw new Error('Unexpected sign-in origin');"
            f"const usernameElement=await page.locator('aria-ref={username_ref}').elementHandle();"
            f"const passwordElement=await page.locator('aria-ref={password_ref}').elementHandle();"
            f"{confirmation_element}"
            f"const submitElement=await page.locator('aria-ref={submit_ref}').elementHandle();"
            f"const elements={elements};"
            "if(elements.some((element)=>!element))"
            "throw new Error('Sign-in elements unavailable');"
            "const cdp=await page.context().newCDPSession(page);"
            "const frameTree=(await cdp.send('Page.getFrameTree')).frameTree;"
            "await cdp.detach();"
            "const frames=[];"
            "const collectFrames=(tree)=>{frames.push(tree.frame);"
            "for(const child of tree.childFrames||[])collectFrames(child);};"
            "collectFrames(frameTree);"
            "if(frameTree.frame.securityOrigin!==expectedOrigin)"
            "throw new Error('Unexpected sign-in origin');"
            "const controlOriginsApproved=await Promise.all("
            "elements.map("
            "async(element)=>{const frame=await element.ownerFrame();"
            "if(frame===null)return false;"
            "const frameUrl=frame.url().split('#')[0];"
            "const frameName=frame.name();"
            "const matches=frames.filter((candidate)=>"
            "candidate.url===frameUrl&&(candidate.name||'')===frameName);"
            "return matches.length>0&&matches.every((candidate)=>"
            "candidate.securityOrigin===expectedOrigin);}));"
            "if(controlOriginsApproved.some((approved)=>!approved))"
            "throw new Error('Unexpected sign-in control origin');"
            "await usernameElement.fill(username);"
            "await passwordElement.fill(password);"
            f"{confirmation_fill}"
            "await submitElement.click();"
            "}"
        )

    @staticmethod
    def _private_email_verification_script(
        *,
        expected_origin: str,
        code_ref: str | None,
        submit_ref: str | None,
        code: str | None,
        verification_url: str | None,
    ) -> str:
        prefix = (
            "async (page) => {"
            f"const expectedOrigin={json.dumps(expected_origin)};"
            f"{_EXACT_ORIGIN_MATCHER_SCRIPT}"
        )
        if verification_url is not None:
            return (
                prefix
                + f"const verificationUrl={json.dumps(verification_url)};"
                + "if(!hasExactOrigin(verificationUrl,expectedOrigin))"
                + "throw new Error('Unexpected verification origin');"
                + "await page.goto(verificationUrl);"
                + "}"
            )
        if code_ref is None or code is None:
            raise PlaywrightCliRuntimeError("browser_failed")
        refs = [code_ref] + ([] if submit_ref is None else [submit_ref])
        encoded_refs = json.dumps(refs, separators=(",", ":"))
        submit = "" if submit_ref is None else "await elements[1].click();"
        return (
            prefix
            + f"const code={json.dumps(code)};"
            + "if(!hasExactOrigin(page.url(),expectedOrigin))"
            + "throw new Error('Unexpected verification origin');"
            + f"const refs={encoded_refs};"
            + "const elements=await Promise.all(refs.map(async(ref)=>"
            + "page.locator('aria-ref='+ref).elementHandle()));"
            + "if(elements.some((element)=>!element))"
            + "throw new Error('Verification elements unavailable');"
            + "const cdp=await page.context().newCDPSession(page);"
            + "const frameTree=(await cdp.send('Page.getFrameTree')).frameTree;"
            + "await cdp.detach();"
            + "const frames=[];"
            + "const collectFrames=(tree)=>{frames.push(tree.frame);"
            + "for(const child of tree.childFrames||[])collectFrames(child);};"
            + "collectFrames(frameTree);"
            + "if(frameTree.frame.securityOrigin!==expectedOrigin)"
            + "throw new Error('Unexpected verification origin');"
            + "const controlOriginsApproved=await Promise.all(elements.map("
            + "async(element)=>{const frame=await element.ownerFrame();"
            + "if(frame===null)return false;"
            + "const frameUrl=frame.url().split('#')[0];"
            + "const frameName=frame.name();"
            + "const matches=frames.filter((candidate)=>"
            + "candidate.url===frameUrl&&(candidate.name||'')===frameName);"
            + "return matches.length>0&&matches.every((candidate)=>"
            + "candidate.securityOrigin===expectedOrigin);}));"
            + "if(controlOriginsApproved.some((approved)=>!approved))"
            + "throw new Error('Unexpected verification control origin');"
            + "await elements[0].fill(code);"
            + submit
            + "}"
        )

    def _create_private_script_memfd(
        self,
        script: str,
        *,
        label: Literal["sign-in", "verification", "restore"],
    ) -> tuple[int, Path]:
        payload = script.encode("utf-8")
        descriptor = -1
        payload_path: Path | None = None
        try:
            descriptor = _create_anonymous_memfd()
            os.fchmod(descriptor, 0o600)
            remaining = memoryview(payload)
            while remaining:
                written = os.write(descriptor, remaining)
                if written <= 0:
                    raise OSError("private memfd write failed")
                remaining = remaining[written:]
            os.lseek(descriptor, 0, os.SEEK_SET)
            target = Path(f"/proc/{os.getpid()}/fd/{descriptor}")
            for _ in range(10):
                candidate = self._internal_directory / (
                    f".{label}-{os.urandom(16).hex()}.js"
                )
                try:
                    candidate.symlink_to(target)
                except FileExistsError:
                    continue
                payload_path = candidate
                break
            if payload_path is None:
                raise OSError("private memfd link collision")
            return descriptor, payload_path
        except (AttributeError, OSError, TypeError, ValueError):
            if payload_path is not None:
                try:
                    payload_path.unlink()
                except OSError:
                    pass
            if descriptor >= 0:
                try:
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    os.ftruncate(descriptor, 0)
                except OSError:
                    pass
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            raise PlaywrightCliRuntimeError("browser_failed") from None

    async def _invoke_private_script_unlocked(
        self,
        script: str,
        *,
        label: Literal["sign-in", "verification", "restore"],
    ) -> _InvocationResult:
        descriptor, payload_path = self._create_private_script_memfd(
            script,
            label=label,
        )
        try:
            return await self._invoke(
                "run-code",
                [f"--filename={payload_path}"],
            )
        finally:
            cleanup_failed = False
            try:
                payload_path.unlink()
            except OSError:
                cleanup_failed = True
            try:
                os.lseek(descriptor, 0, os.SEEK_SET)
                os.ftruncate(descriptor, 0)
            except OSError:
                cleanup_failed = True
            try:
                os.close(descriptor)
            except OSError:
                cleanup_failed = True
            if cleanup_failed:
                self._started = False
                self._guard_armed = False
                raise PlaywrightCliRuntimeError("browser_failed") from None

    async def execute(
        self,
        command: str,
        args: Sequence[str] | None = None,
        *,
        expose_applicant_values: bool = False,
    ) -> PlaywrightCliExecutionResult:
        async with self._operation_lock:
            self._set_applicant_redaction_enabled(
                not expose_applicant_values
            )
            try:
                return await self._execute_unlocked(
                    command,
                    args,
                    expose_applicant_values=expose_applicant_values,
                )
            except _ActionRuntimeFailure as caught:
                failure = caught.error
            await self._invalidate_after_action_failure_unlocked()
            raise failure from None

    async def _execute_unlocked(
        self,
        command: str,
        args: Sequence[str] | None,
        *,
        expose_applicant_values: bool,
    ) -> PlaywrightCliExecutionResult:
        if not self._started or self._closed or not self._guard_armed:
            raise PlaywrightCliRuntimeError("browser_failed")
        normalized = self._validate_model_invocation(command, args)
        if self._screenshots_suppressed and command in {
            "eval",
            "screenshot",
            "pdf",
        }:
            raise PlaywrightCliRuntimeError("browser_failed")
        if self._screenshots_suppressed and command == "snapshot" and any(
            value == "--filename" or value.startswith("--filename=")
            for value in normalized
        ):
            raise PlaywrightCliRuntimeError("browser_failed")
        pre_metadata = self._current_metadata
        if pre_metadata is None:
            try:
                pre_metadata = await self._metadata()
            except PlaywrightCliRuntimeError as error:
                raise _ActionRuntimeFailure(error) from None
        if not self._url_is_allowed(pre_metadata.url, self._approved_origins):
            raise PlaywrightCliRuntimeError("browser_failed")
        self._validate_tab_command(command, normalized, pre_metadata)
        try:
            execution = await self._invoke(
                command,
                normalized,
            )
        except PlaywrightCliRuntimeError as error:
            raise _ActionRuntimeFailure(error) from None
        if execution.timed_out:
            raise _ActionRuntimeFailure(
                PlaywrightCliRuntimeError("browser_failed")
            )
        preserve_snapshot_file = (
            not self._screenshots_suppressed
            and command == "snapshot"
            and any(
                value == "--filename" or value.startswith("--filename=")
                for value in normalized
            )
        )
        try:
            post_metadata, observation = await self._collect_observation(
                execution,
                remove_snapshot_file=not preserve_snapshot_file,
            )
        except PlaywrightCliRuntimeError as error:
            raise _ActionRuntimeFailure(error) from None
        escaped_origin = not self._url_is_allowed(
            post_metadata.url, self._approved_origins
        )
        if escaped_origin:
            try:
                await self._restore_allowed_page(
                    pre_metadata,
                    post_metadata,
                )
                post_metadata, observation = await self._collect_observation(None)
                if not self._url_is_allowed(
                    post_metadata.url, self._approved_origins
                ):
                    raise PlaywrightCliRuntimeError("browser_failed")
            except PlaywrightCliRuntimeError as error:
                raise _ActionRuntimeFailure(error) from None
        self._current_metadata = post_metadata
        if self._screenshots_suppressed and not expose_applicant_values:
            stdout = "[redacted]"
            stderr = "[redacted]"
            stdout_text_truncated = False
            stderr_text_truncated = False
        else:
            stdout, stdout_text_truncated = self._public_output(
                execution.stdout
            )
            stderr, stderr_text_truncated = self._public_output(
                execution.stderr
            )
            if command == "tab-list" and not expose_applicant_values:
                stdout = "[redacted]"
                stdout_text_truncated = False
        exit_code = execution.exit_code
        if self._reported_cli_error(execution) and exit_code == 0:
            exit_code = 1
        if escaped_origin:
            exit_code = 2
            stderr = "[redacted]"
            stderr_text_truncated = False
        if self._directory_size_exceeds(
            self._output_directory,
            _MAX_OUTPUT_DIRECTORY_BYTES,
        ):
            await self._emergency_budget_cleanup_unlocked()
            raise PlaywrightCliRuntimeError("browser_failed")
        return PlaywrightCliExecutionResult(exit_code=exit_code, stdout=stdout,
        stderr=stderr,
        stdout_truncated=(
            execution.stdout_truncated or stdout_text_truncated
        ),
        stderr_truncated=(
            execution.stderr_truncated or stderr_text_truncated
        ),
        observation=observation,)

    async def get_current_page_url(self) -> str:
        async with self._operation_lock:
            if not self._opened or self._closed:
                raise PlaywrightCliRuntimeError("browser_failed")
            metadata = await self._metadata(
                mark_navigation_handoff=not self._guard_armed
            )
            self._current_metadata = metadata
            return metadata.url

    async def capture_source_snapshot(
        self,
        expected_origin: str,
    ) -> tuple[str, str] | None:
        """Read bounded rendered semantic text without page mutation."""

        async with self._operation_lock:
            if not self._started or self._closed or not self._guard_armed:
                raise PlaywrightCliRuntimeError("browser_failed")
            try:
                canonical_origin = validate_https_origin(expected_origin)
            except (TypeError, ValueError):
                raise PlaywrightCliRuntimeError("browser_failed") from None
            if (
                canonical_origin != expected_origin
                or self._approved_origins != (canonical_origin,)
            ):
                raise PlaywrightCliRuntimeError("browser_failed")

            traversal_function = (
                "function(){"
                f"const maxVisitedNodes={_MAX_SOURCE_CAPTURE_VISITED_NODES};"
                f"const maxBytes={_MAX_SOURCE_CAPTURE_TRAVERSAL_BYTES};"
                f"const maxLines={_MAX_SOURCE_CAPTURE_LINES};"
                'const excludedTags=new Set(["input","textarea","select"]);'
                'const nonContentTags=new Set(["script","style","template","noscript"]);'
                "const semanticAttributes=['aria-label','alt','title'];"
                "const encoder=new TextEncoder();"
                "const lines=[];"
                "let usedBytes=0;"
                "let visitedNodes=0;"
                "let stopped=false;"
                "const appendLine=raw=>{"
                "if(stopped||typeof raw!=='string')return;"
                "if(lines.length>=maxLines){stopped=true;return;}"
                "const separatorBytes=lines.length?1:0;"
                "const remaining=maxBytes-usedBytes-separatorBytes;"
                "if(remaining<=0){stopped=true;return;}"
                "const normalized=raw.slice(0,remaining+1)"
                ".replace(/\\s+/gu,' ').trim();"
                "if(!normalized)return;"
                "let line=normalized;"
                "if(encoder.encode(line).length>remaining){"
                "let low=0;"
                "let high=Math.min(line.length,remaining);"
                "while(low<high){"
                "const middle=Math.ceil((low+high)/2);"
                "if(encoder.encode(line.slice(0,middle)).length<=remaining)"
                "low=middle;else high=middle-1;"
                "}"
                "if(low>0){const last=line.charCodeAt(low-1);"
                "if(last>=0xD800&&last<=0xDBFF)low-=1;}"
                "line=line.slice(0,low).trimEnd();"
                "stopped=true;"
                "}"
                "if(!line)return;"
                "usedBytes+=separatorBytes+encoder.encode(line).length;"
                "lines.push(line);"
                "if(usedBytes>=maxBytes||lines.length>=maxLines)stopped=true;"
                "};"
                "const root=document.body;"
                "let node=root;"
                "while(node&&visitedNodes<maxVisitedNodes&&!stopped){"
                "visitedNodes+=1;"
                "let descend=true;"
                "if(node.nodeType===Node.ELEMENT_NODE){"
                "const element=node;"
                "if(excludedTags.has(element.localName)"
                "||element.isContentEditable"
                "||element.hasAttribute('contenteditable')"
                "||nonContentTags.has(element.localName)){"
                "descend=false;"
                "}else{"
                "let style=null;"
                "try{style=getComputedStyle(element);}catch{descend=false;}"
                "if(descend&&(element.hidden"
                "||(element.getAttribute('aria-hidden')||'').toLowerCase()==='true'"
                "||style.display==='none'"
                "||style.visibility==='hidden'"
                "||style.visibility==='collapse'"
                "||style.contentVisibility==='hidden'"
                "||style.opacity==='0'))descend=false;"
                "if(descend){"
                "for(const attribute of semanticAttributes)"
                "appendLine(element.getAttribute(attribute));"
                "}"
                "}"
                "}else if(node.nodeType===Node.TEXT_NODE){"
                "appendLine(node.nodeValue);"
                "}"
                "let next=null;"
                "if(descend&&node.firstChild){"
                "next=node.firstChild;"
                "}else{"
                "let cursor=node;"
                "while(cursor&&cursor!==root&&!cursor.nextSibling)"
                "cursor=cursor.parentNode;"
                "if(cursor&&cursor!==root)next=cursor.nextSibling;"
                "}"
                "node=next;"
                "}"
                "return lines.join('\\n');"
                "}"
            )
            script = (
                "async (page) => {"
                f"const expectedOrigin={json.dumps(canonical_origin)};"
                f"{_EXACT_ORIGIN_MATCHER_SCRIPT}"
                "const cdp=await page.context().newCDPSession(page);"
                "try{"
                "const beforeTree=(await cdp.send('Page.getFrameTree')).frameTree;"
                "if(!beforeTree||!beforeTree.frame"
                "||typeof beforeTree.frame.id!=='string'"
                "||typeof beforeTree.frame.url!=='string')"
                "throw new Error('Source frame unavailable');"
                "const beforeUrl=beforeTree.frame.url;"
                "if(!hasExactOrigin(beforeUrl,expectedOrigin))"
                "return {url:beforeUrl,source:null};"
                "const isolated=await cdp.send('Page.createIsolatedWorld',{"
                "frameId:beforeTree.frame.id,"
                "worldName:'jobhunter.sourceCapture.'+Date.now()+'.'+Math.random(),"
                "grantUniveralAccess:false});"
                "const executionContextId=isolated&&isolated.executionContextId;"
                "if(!Number.isSafeInteger(executionContextId)"
                "||executionContextId<=0)"
                "throw new Error('Source context unavailable');"
                "const evaluated=await cdp.send('Runtime.callFunctionOn',{"
                f"functionDeclaration:{json.dumps(traversal_function)},"
                "executionContextId,"
                "returnByValue:true,"
                "awaitPromise:false,"
                "userGesture:false});"
                "if(!evaluated||evaluated.exceptionDetails"
                "||!evaluated.result"
                "||evaluated.result.type!=='string'"
                "||typeof evaluated.result.value!=='string'"
                "||evaluated.result.objectId!==undefined)"
                "throw new Error('Source result unavailable');"
                "const source=evaluated.result.value;"
                "const afterTree=(await cdp.send('Page.getFrameTree')).frameTree;"
                "if(!afterTree||!afterTree.frame"
                "||afterTree.frame.id!==beforeTree.frame.id"
                "||typeof afterTree.frame.url!=='string')"
                "return {url:'',source:null};"
                "const afterUrl=afterTree.frame.url;"
                "if(!hasExactOrigin(afterUrl,expectedOrigin))"
                "return {url:afterUrl,source:null};"
                "return {url:afterUrl,source};"
                "}finally{await cdp.detach();}"
                "}"
            )
            captured = await self._invoke(
                "run-code",
                [script],
                capture_limit=_MAX_INTERNAL_CAPTURE_BYTES,
            )
            self._require_success(captured)
            if captured.stdout_truncated:
                raise PlaywrightCliRuntimeError("browser_failed")
            payload = self._decode_run_code_result(captured)
            final_url = payload.get("url")
            snapshot = payload.get("source")
            if not isinstance(final_url, str):
                raise PlaywrightCliRuntimeError("browser_failed")
            try:
                if _origin_for_url(final_url) != canonical_origin:
                    return None
            except (TypeError, ValueError):
                return None
            if snapshot is None:
                return None
            if not isinstance(snapshot, str):
                raise PlaywrightCliRuntimeError("browser_failed")
            try:
                source = _bounded_source_snapshot(
                    self._redact_bounded_text(snapshot, len(snapshot))
                )
            except UnicodeError:
                raise PlaywrightCliRuntimeError("browser_failed") from None
            if not source:
                raise PlaywrightCliRuntimeError("browser_failed")
            return final_url, source

    async def set_approved_origins(self, origins: Iterable[str]) -> None:
        async with self._operation_lock:
            if not self._opened or self._closed:
                raise PlaywrightCliRuntimeError("browser_failed")
            try:
                canonical = tuple(validate_approved_origin(origin) for origin in origins)
            except (TypeError, ValueError):
                raise PlaywrightCliRuntimeError("browser_failed") from None
            if not canonical or len(canonical) > 20 or len(set(canonical)) != len(canonical):
                raise PlaywrightCliRuntimeError("browser_failed")
            await self._install_navigation_guard(canonical)

    async def suspend_navigation_guard(self) -> None:
        async with self._operation_lock:
            if not self._opened or self._closed or not self._guard_armed:
                return
            self._guard_armed = False
            self._current_metadata = None
            try:
                result = await self._invoke(
                    "run-code",
                    [self._suspend_guard_script()],
                    capture_limit=_MAX_INTERNAL_CAPTURE_BYTES,
                )
            except asyncio.CancelledError:
                self._report_guard_suspension_failure(
                    error_category="runtime_error",
                    exit_code=None,
                    reported_cli_error=False,
                    stdout_truncated=False,
                    stderr_truncated=False,
                )
                await self._recover_failed_guard_suspension_unlocked()
                raise
            except PlaywrightCliRuntimeError:
                self._report_guard_suspension_failure(
                    error_category="runtime_error",
                    exit_code=None,
                    reported_cli_error=False,
                    stdout_truncated=False,
                    stderr_truncated=False,
                )
                await self._recover_failed_guard_suspension_unlocked()
                raise
            reported_cli_error = self._reported_cli_error(result)
            if result.exit_code != 0 or reported_cli_error:
                error_category = (
                    "process_exit" if result.exit_code != 0 else "cli_error"
                )
                self._report_guard_suspension_failure(
                    error_category=error_category,
                    exit_code=result.exit_code,
                    reported_cli_error=reported_cli_error,
                    stdout_truncated=result.stdout_truncated,
                    stderr_truncated=result.stderr_truncated,
                )
                try:
                    self._require_success(result)
                except PlaywrightCliRuntimeError:
                    await self._recover_failed_guard_suspension_unlocked()
                    raise

    async def _recover_failed_guard_suspension_unlocked(self) -> None:
        async def recover() -> None:
            try:
                await self._install_navigation_guard(self._approved_origins)
            except BaseException:
                self._started = False
                self._guard_armed = False
                self._current_metadata = None
                try:
                    await self._emergency_budget_cleanup_unlocked()
                except BaseException:
                    self._started = False
                    self._guard_armed = False
                    self._current_metadata = None

        recovery_task = asyncio.create_task(
            recover(),
            name=f"playwright-guard-recovery-{self._session_id}",
        )
        try:
            await asyncio.shield(recovery_task)
        except asyncio.CancelledError:
            await recovery_task

    def _native_browser_ownership(self) -> _NativeBrowserOwnership | None:
        if self._launch.cdp_url is not None:
            return None
        if (
            self._launch.executable_path is None
            or self._launch.user_data_dir is None
        ):
            raise BrowserConfigurationError(
                "Local Chrome configuration is incomplete"
            )
        identity_values = (
            self._native_browser_executable,
            self._native_browser_process_id,
            self._native_browser_create_time,
        )
        if any(value is not None for value in identity_values) and not all(
            value is not None for value in identity_values
        ):
            raise BrowserConfigurationError(
                "The native browser ownership record is incomplete"
            )
        return _NativeBrowserOwnership(
            launcher=self._launch.executable_path,
            user_data_dir=self._launch.user_data_dir,
            executable=self._native_browser_executable,
            pid=self._native_browser_process_id,
            create_time=self._native_browser_create_time,
        )

    def _write_ownership(self) -> None:
        payload: dict[str, object] = {
            "session_name": self._session_name,
            "temporary_directory": str(self._temporary_directory),
        }
        if self._daemon_process_id is not None:
            payload["daemon_pid"] = self._daemon_process_id
        native = self._native_browser_ownership()
        if native is not None:
            payload["native_launcher"] = str(native.launcher)
            payload["native_user_data_dir"] = str(native.user_data_dir)
            if (
                native.executable is not None
                and native.pid is not None
                and native.create_time is not None
            ):
                payload["native_executable"] = str(native.executable)
                payload["native_browser_pid"] = native.pid
                payload["native_browser_create_time"] = native.create_time
        _atomic_write_private_json(self._ownership_path, payload)

    @staticmethod
    def _daemon_pid(result: _InvocationResult) -> int | None:
        try:
            payload = json.loads(result.stdout.decode("utf-8"))
            pid = payload.get("pid") if isinstance(payload, dict) else None
        except (json.JSONDecodeError, UnicodeError):
            return None
        return pid if isinstance(pid, int) and not isinstance(pid, bool) and pid > 1 else None

    async def _require_closed_session(self, result: _InvocationResult) -> None:
        self._require_success(result)
        try:
            payload = json.loads(result.stdout.decode("utf-8"))
            if (
                not isinstance(payload, dict)
                or payload.get("session") != self._session_name
                or payload.get("status") not in {"closed", "not-open"}
            ):
                raise TypeError
        except (json.JSONDecodeError, TypeError, UnicodeError):
            raise PlaywrightCliRuntimeError("browser_failed") from None
        try:
            for pid in _matching_cli_daemon_pids(
                self._session_name,
                self._daemon_process_id,
            ):
                await _terminate_owned_daemon(pid, self._session_name)
            if _matching_cli_daemon_pids(
                self._session_name,
                self._daemon_process_id,
            ):
                raise BrowserConfigurationError(
                    "The Playwright CLI daemon could not be reclaimed"
                )
            await _reclaim_native_browser(self._native_browser_ownership())
        except BrowserConfigurationError:
            raise PlaywrightCliRuntimeError("browser_failed") from None

    async def _invalidate_after_action_failure_unlocked(self) -> None:
        self._started = False
        self._guard_armed = False
        self._current_metadata = None
        if self._closed:
            return

        async def cleanup() -> None:
            try:
                async with asyncio.timeout(_CLEANUP_TIMEOUT_SECONDS):
                    while True:
                        try:
                            await self._emergency_budget_cleanup_unlocked()
                        except PlaywrightCliRuntimeError:
                            await asyncio.sleep(0.1)
                        else:
                            return
            except TimeoutError:
                raise PlaywrightCliRuntimeError("browser_failed") from None

        cleanup_task = asyncio.create_task(
            cleanup(),
            name=f"playwright-action-failure-cleanup-{self._session_id}",
        )
        try:
            await asyncio.shield(cleanup_task)
        except asyncio.CancelledError:
            await cleanup_task
            raise

    async def _emergency_budget_cleanup_unlocked(self) -> None:
        active = self._active_process
        if active is not None:
            await self._terminate_process(active)
        await self._cancel_artifact_monitor_unlocked()

        if self._video_started:
            try:
                stopped = await self._invoke(
                    "video-stop",
                    timeout=_BUDGET_CLEANUP_TIMEOUT_SECONDS,
                )
                self._require_success(stopped)
            except PlaywrightCliRuntimeError:
                pass

        if self._open_attempted:
            close_confirmed = False
            try:
                closed = await self._invoke(
                    "close",
                    timeout=_BUDGET_CLEANUP_TIMEOUT_SECONDS,
                )
                await self._require_closed_session(closed)
                close_confirmed = True
            except PlaywrightCliRuntimeError:
                pass
            if not close_confirmed:
                try:
                    for pid in _matching_cli_daemon_pids(
                        self._session_name,
                        self._daemon_process_id,
                    ):
                        await _terminate_owned_daemon(pid, self._session_name)
                    if _matching_cli_daemon_pids(
                        self._session_name,
                        self._daemon_process_id,
                    ):
                        raise BrowserConfigurationError(
                            "The Playwright CLI daemon could not be reclaimed"
                        )
                    await _reclaim_native_browser(
                        self._native_browser_ownership()
                    )
                except BrowserConfigurationError:
                    raise PlaywrightCliRuntimeError("browser_failed") from None

        try:
            _remove_owned_temporary_directory(
                self._temporary_directory,
                self._session_id,
            )
            self._ownership_path.unlink(missing_ok=True)
        except (BrowserConfigurationError, OSError):
            raise PlaywrightCliRuntimeError("browser_failed") from None
        self._opened = False
        self._open_attempted = False
        self._daemon_process_id = None
        self._native_browser_process_id = None
        self._native_browser_create_time = None
        self._native_browser_executable = None
        self._video_started = False
        self._started = False
        self._guard_armed = False
        self._current_metadata = None
        self._closed = True

    async def _monitor_artifact_budget(self) -> None:
        current = asyncio.current_task()
        try:
            while self._open_attempted and not self._closed:
                await asyncio.sleep(_ARTIFACT_BUDGET_POLL_SECONDS)
                video_exceeded = self._directory_size_exceeds(
                    self._video_directory,
                    _MAX_VIDEO_BYTES,
                )
                output_exceeded = self._directory_size_exceeds(
                    self._output_directory,
                    _MAX_OUTPUT_DIRECTORY_BYTES,
                )
                temporary_exceeded = self._directory_size_exceeds(
                    self._temporary_directory,
                    _MAX_TEMPORARY_DIRECTORY_BYTES,
                )
                if (
                    not video_exceeded
                    and not output_exceeded
                    and not temporary_exceeded
                ):
                    continue
                self._video_budget_exceeded = video_exceeded
                while self._open_attempted and not self._closed:
                    async with self._operation_lock:
                        try:
                            await self._emergency_budget_cleanup_unlocked()
                        except PlaywrightCliRuntimeError:
                            pass
                        else:
                            return
                    await asyncio.sleep(0.1)
                return
        except asyncio.CancelledError:
            return
        finally:
            if self._artifact_monitor_task is current:
                self._artifact_monitor_task = None

    async def _cancel_artifact_monitor_unlocked(self) -> None:
        task = self._artifact_monitor_task
        if task is None or task is asyncio.current_task():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        if self._artifact_monitor_task is task:
            self._artifact_monitor_task = None

    async def close(self) -> None:
        async with self._operation_lock:
            if self._closed:
                return
            await self._cleanup_unlocked()
            self._closed = True

    async def _cleanup_unlocked(self) -> None:
        active = self._active_process
        if active is not None:
            await self._terminate_process(active)
        await self._cancel_artifact_monitor_unlocked()

        video_error: PlaywrightCliRuntimeError | None = None
        if self._video_started:
            try:
                stopped = await self._invoke(
                    "video-stop",
                    timeout=_CLEANUP_TIMEOUT_SECONDS,
                )
                self._require_success(stopped)
                self._video_started = False
            except PlaywrightCliRuntimeError as error:
                video_error = error

        if self._open_attempted:
            closed = await self._invoke(
                "close",
                timeout=_CLEANUP_TIMEOUT_SECONDS,
            )
            await self._require_closed_session(closed)
            self._opened = False
            self._open_attempted = False
            self._video_started = False
            self._daemon_process_id = None
            self._native_browser_process_id = None
            self._native_browser_create_time = None
            self._native_browser_executable = None
        if video_error is not None:
            raise video_error

        self._started = False
        self._guard_armed = False
        self._current_metadata = None
        try:
            _remove_owned_temporary_directory(
                self._temporary_directory,
                self._session_id,
            )
            _remove_stale_private_sign_in_links(self._internal_directory)
            self._ownership_path.unlink(missing_ok=True)
        except (BrowserConfigurationError, OSError):
            raise PlaywrightCliRuntimeError("browser_failed") from None

    async def _install_navigation_guard(self, origins: tuple[str, ...]) -> None:
        self._current_metadata = None
        result = await self._invoke(
            "run-code",
            [self._guard_script(origins)],
            capture_limit=_MAX_INTERNAL_CAPTURE_BYTES,
        )
        self._require_success(result)
        self._approved_origins = origins
        self._guard_armed = True

    @staticmethod
    def _guard_script(origins: tuple[str, ...]) -> str:
        encoded = json.dumps(origins, separators=(",", ":"))
        return (
            "async (page) => {"
            "const context=page.context();"
            "const key=Symbol.for('jobhunter.playwrightCli.navigationGuard');"
            f"const allowed={encoded};"
            f"{_EXACT_ORIGIN_MATCHER_SCRIPT}"
            "let state=context[key];"
            "if(state){"
            "const handoffChanged=state.handoffPending&&state.handoffChanged;"
            "state.allowed=allowed;state.armed=true;"
            "state.handoffPending=false;state.handoffChanged=false;"
            "if(handoffChanged)throw new Error('navigation changed during guard handoff');"
            "return {armed:true};}"
            "state={allowed,armed:true,handler:null,"
            "handoffPending:false,handoffChanged:false};"
            "const handler=async route=>{"
            "const request=route.request();"
            "if(!request.isNavigationRequest())return route.continue();"
            "let topLevel=false;"
            "try{topLevel=request.frame().parentFrame()===null;}catch{}"
            "if(!topLevel)return route.continue();"
            "if(!state.armed){"
            "if(state.handoffPending)state.handoffChanged=true;"
            "return route.continue();}"
            "const url=request.url();"
            "if(url==='about:blank')return route.continue();"
            "if(state.allowed.some((origin)=>hasExactOrigin(url,origin)))"
            "return route.continue();"
            "return route.abort('blockedbyclient');};"
            "state.handler=handler;"
            "await context.route('**/*',handler);"
            "context[key]=state;"
            "return {armed:true};}"
        )

    @staticmethod
    def _suspend_guard_script() -> str:
        return (
            "async (page) => {"
            "const context=page.context();"
            "const key=Symbol.for('jobhunter.playwrightCli.navigationGuard');"
            "const state=context[key];"
            "if(state){state.armed=false;"
            "state.handoffPending=false;state.handoffChanged=false;}"
            "return {armed:false};}"
        )

    def _validate_model_invocation(
        self,
        command: str,
        args: Sequence[str] | None,
    ) -> list[str]:
        if not isinstance(command, str) or command not in _APPROVED_COMMANDS:
            raise PlaywrightCliRuntimeError("browser_failed")
        if args is None:
            values: list[str] = []
        elif isinstance(args, (str, bytes)) or not isinstance(args, Sequence):
            raise PlaywrightCliRuntimeError("browser_failed")
        else:
            values = list(args)
        if len(values) > _MAX_ARGUMENT_ITEMS:
            raise PlaywrightCliRuntimeError("browser_failed")

        invocation_bytes = len(command.encode("utf-8"))
        for value in values:
            if not isinstance(value, str) or "\x00" in value:
                raise PlaywrightCliRuntimeError("browser_failed")
            try:
                encoded_length = len(value.encode("utf-8"))
            except UnicodeEncodeError:
                raise PlaywrightCliRuntimeError("browser_failed") from None
            if encoded_length > _MAX_ARGUMENT_BYTES:
                raise PlaywrightCliRuntimeError("browser_failed")
            invocation_bytes += encoded_length
            if (
                value in _RESERVED_ARGUMENTS
                or value.startswith(_RESERVED_ARGUMENT_PREFIXES)
            ):
                raise PlaywrightCliRuntimeError("browser_failed")
        if invocation_bytes > _MAX_INVOCATION_BYTES:
            raise PlaywrightCliRuntimeError("browser_failed")

        if command == "goto":
            if len(values) != 1:
                raise PlaywrightCliRuntimeError("browser_failed")
            self._validate_direct_url(values[0])
        elif command == "tab-new" and values:
            if len(values) != 1:
                raise PlaywrightCliRuntimeError("browser_failed")
            self._validate_direct_url(values[0])
        elif command == "upload":
            if len(values) != 1:
                raise PlaywrightCliRuntimeError("browser_failed")
            values[0] = str(self._confined_input_path(values[0]))
        elif command == "drop":
            values = self._rewrite_drop_paths(values)
        elif command in {"snapshot", "screenshot", "pdf", "eval"}:
            values = self._rewrite_output_paths(values)
        return values

    def _validate_direct_url(self, value: str) -> None:
        try:
            parsed = urlsplit(value)
            if parsed.scheme.lower() in _SAFE_INTERNAL_SCHEMES:
                if parsed.scheme.lower() == "about" and value != "about:blank":
                    raise ValueError("unsafe internal URL")
                return
            origin = _origin_for_url(value)
        except (TypeError, ValueError):
            raise PlaywrightCliRuntimeError("browser_failed") from None
        if origin not in self._approved_origins:
            raise PlaywrightCliRuntimeError("browser_failed")

    def _confined_input_path(self, value: str) -> Path:
        try:
            candidate = Path(value).expanduser()
            if not candidate.is_absolute():
                candidate = self._session_directory / candidate
            resolved = candidate.resolve(strict=True)
        except (OSError, RuntimeError):
            raise PlaywrightCliRuntimeError("browser_failed") from None
        if (
            not _is_within(resolved, self._session_directory)
            or _is_within(resolved, self._scope_directory)
            or not resolved.is_file()
            or resolved.is_symlink()
        ):
            raise PlaywrightCliRuntimeError("browser_failed")
        return resolved

    def _confined_output_path(self, value: str) -> Path:
        try:
            candidate = Path(value).expanduser()
            if not candidate.is_absolute():
                candidate = self._output_directory / candidate
            resolved = candidate.resolve(strict=False)
        except (OSError, RuntimeError):
            raise PlaywrightCliRuntimeError("browser_failed") from None
        if not _is_within(resolved, self._output_directory):
            raise PlaywrightCliRuntimeError("browser_failed")
        try:
            resolved.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if not resolved.parent.is_dir() or resolved.parent.is_symlink():
                raise OSError
        except OSError:
            raise PlaywrightCliRuntimeError("browser_failed") from None
        return resolved

    def _rewrite_drop_paths(self, values: list[str]) -> list[str]:
        rewritten: list[str] = []
        index = 0
        while index < len(values):
            value = values[index]
            if value == "--path":
                if index + 1 >= len(values):
                    raise PlaywrightCliRuntimeError("browser_failed")
                rewritten.extend(
                    ("--path", str(self._confined_input_path(values[index + 1])))
                )
                index += 2
                continue
            if value.startswith("--path="):
                rewritten.append(
                    f"--path={self._confined_input_path(value.removeprefix('--path='))}"
                )
            else:
                rewritten.append(value)
            index += 1
        return rewritten

    def _rewrite_output_paths(self, values: list[str]) -> list[str]:
        rewritten: list[str] = []
        index = 0
        while index < len(values):
            value = values[index]
            if value == "--filename":
                if index + 1 >= len(values):
                    raise PlaywrightCliRuntimeError("browser_failed")
                rewritten.extend(
                    (
                        "--filename",
                        str(self._confined_output_path(values[index + 1])),
                    )
                )
                index += 2
                continue
            if value.startswith("--filename="):
                rewritten.append(
                    "--filename="
                    + str(
                        self._confined_output_path(
                            value.removeprefix("--filename=")
                        )
                    )
                )
            else:
                rewritten.append(value)
            index += 1
        return rewritten

    def _validate_tab_command(
        self,
        command: str,
        args: Sequence[str],
        metadata: _PageMetadata,
    ) -> None:
        if command == "tab-new":
            if len(metadata.tabs) >= _MAX_TABS:
                raise PlaywrightCliRuntimeError("browser_failed")
            return
        if command not in {"tab-select", "tab-close"}:
            return
        if command == "tab-select" and len(args) != 1:
            raise PlaywrightCliRuntimeError("browser_failed")
        if command == "tab-close" and len(args) > 1:
            raise PlaywrightCliRuntimeError("browser_failed")
        try:
            index = (
                int(args[0], 10)
                if args
                else metadata.current_index
            )
        except ValueError:
            raise PlaywrightCliRuntimeError("browser_failed") from None
        if index < 0 or index >= len(metadata.tabs):
            raise PlaywrightCliRuntimeError("browser_failed")
        if not self._url_is_allowed(
            metadata.tabs[index][0],
            self._approved_origins,
        ):
            raise PlaywrightCliRuntimeError("browser_failed")
        if command == "tab-select":
            return

        remaining = [
            tab
            for tab_index, tab in enumerate(metadata.tabs)
            if tab_index != index
        ]
        if remaining and not any(
            self._url_is_allowed(url, self._approved_origins)
            for url, _title in remaining
        ):
            raise PlaywrightCliRuntimeError("browser_failed")

    async def _restore_allowed_page(
        self,
        previous: _PageMetadata,
        current: _PageMetadata,
    ) -> None:
        allowed_index = next(
            (
                index
                for index, (url, _title) in enumerate(current.tabs)
                if self._url_is_allowed(url, self._approved_origins)
            ),
            None,
        )
        if allowed_index is not None:
            selected = await self._invoke(
                "tab-select",
                [str(allowed_index)],
            )
            self._require_success(selected)
            return

        if (
            previous.current_index < 0
            or previous.current_index >= len(current.tabs)
            or not self._url_is_allowed(
                previous.url,
                self._approved_origins,
            )
        ):
            raise PlaywrightCliRuntimeError("browser_failed")
        selected = await self._invoke(
            "tab-select",
            [str(previous.current_index)],
        )
        self._require_success(selected)
        if self._screenshots_suppressed:
            restore_script = (
                "async (page) => {"
                f"const target={json.dumps(previous.url)};"
                "await page.goto(target);"
                "}"
            )
            restored = await self._invoke_private_script_unlocked(
                restore_script,
                label="restore",
            )
        else:
            restored = await self._invoke(
                "goto",
                [previous.url],
            )
        self._require_success(restored)

    async def _metadata(
        self,
        *,
        mark_navigation_handoff: bool = False,
    ) -> _PageMetadata:
        handoff = (
            "const context=page.context();"
            "const guard=context[Symbol.for('jobhunter.playwrightCli.navigationGuard')];"
            "if(guard&&!guard.armed&&!guard.handoffPending){"
            "guard.handoffPending=true;guard.handoffChanged=false;}"
            if mark_navigation_handoff
            else ""
        )
        script = (
            "async (page) => {"
            f"{handoff}"
            "const clip=(value,limit)=>Array.from(value.slice(0,limit*2)).slice(0,limit).join('');"
            "const pages=page.context().pages();"
            "return {"
            f"url:clip(page.url(),{_MAX_URL_CAPTURE_CHARS}),"
            f"title:clip(await page.title().catch(()=>'' ),{_MAX_TITLE_CAPTURE_CHARS}),"
            "currentIndex:pages.indexOf(page),"
            f"tabs:await Promise.all(pages.slice(0,{_MAX_TABS}).map(async p=>({{"
            f"url:clip(p.url(),{_MAX_URL_CAPTURE_CHARS}),"
            f"title:clip(await p.title().catch(()=>'' ),{_MAX_TITLE_CAPTURE_CHARS})}})))"
            "};}"
        )
        result = await self._invoke(
            "run-code",
            [script],
            capture_limit=_MAX_OBSERVATION_CAPTURE_BYTES,
        )
        self._require_success(result)
        return self._parse_metadata(self._decode_run_code_result(result))

    @staticmethod
    def _decode_run_code_result(result: _InvocationResult) -> dict[str, object]:
        try:
            outer = json.loads(result.stdout.decode("utf-8"))
            if not isinstance(outer, dict):
                raise TypeError
            raw: object = outer["result"]
            for _ in range(2):
                if not isinstance(raw, str):
                    break
                raw = json.loads(raw)
            if not isinstance(raw, dict):
                raise TypeError
            return cast(dict[str, object], raw)
        except (KeyError, TypeError, json.JSONDecodeError, UnicodeError):
            raise PlaywrightCliRuntimeError("browser_failed") from None

    def _parse_metadata(self, raw_metadata: object) -> _PageMetadata:
        try:
            if not isinstance(raw_metadata, dict):
                raise TypeError
            raw_tabs = raw_metadata["tabs"]
            if not isinstance(raw_tabs, list):
                raise TypeError
            tabs: list[tuple[str, str]] = []
            for raw_tab in raw_tabs[:_MAX_TABS]:
                if not isinstance(raw_tab, dict):
                    raise TypeError
                tab_url = raw_tab.get("url")
                tab_title = raw_tab.get("title")
                if not isinstance(tab_url, str) or not isinstance(tab_title, str):
                    raise TypeError
                tabs.append(
                    (
                        tab_url[:_MAX_URL_CAPTURE_CHARS],
                        self._redact_bounded_text(
                            tab_title[:_MAX_TITLE_CAPTURE_CHARS],
                            _MAX_TITLE_CHARS,
                        ),
                    )
                )
            url = raw_metadata["url"]
            title = raw_metadata["title"]
            current_index = raw_metadata["currentIndex"]
            if (
                not isinstance(url, str)
                or not isinstance(title, str)
                or not isinstance(current_index, int)
                or isinstance(current_index, bool)
            ):
                raise TypeError
            if current_index < 0 or current_index >= len(tabs):
                raise ValueError
        except (KeyError, TypeError, ValueError):
            raise PlaywrightCliRuntimeError("browser_failed") from None
        return _PageMetadata(
            url=url[:_MAX_URL_CAPTURE_CHARS],
            title=self._redact_bounded_text(
                title[:_MAX_TITLE_CAPTURE_CHARS],
                _MAX_TITLE_CHARS,
            ),
            current_index=current_index,
            tabs=tuple(tabs),
        )

    @staticmethod
    def _observation_script(screenshot_path: Path | None) -> str:
        screenshot_setup = ""
        screenshot_expression = "Promise.resolve(false)"
        if screenshot_path is not None:
            screenshot_setup = (
                f"const screenshotPath={json.dumps(str(screenshot_path))};"
            )
            screenshot_expression = (
                "page.screenshot({path:screenshotPath,type:'png'})"
                ".then(()=>true,()=>false)"
            )
        return (
            "async (page) => {"
            f"{screenshot_setup}"
            "const clip=(value,limit)=>Array.from(value.slice(0,limit*2)).slice(0,limit).join('');"
            "const allPages=page.context().pages();"
            f"const pages=allPages.slice(0,{_MAX_TABS});"
            "const [title,tabs,screenshot]=await Promise.all(["
            f"page.title().then(value=>clip(value,{_MAX_TITLE_CAPTURE_CHARS}),()=>''),"
            "Promise.all(pages.map(async p=>({"
            f"url:clip(p.url(),{_MAX_URL_CAPTURE_CHARS}),"
            f"title:clip(await p.title().catch(()=>'' ),{_MAX_TITLE_CAPTURE_CHARS})"
            "}))),"
            f"{screenshot_expression}"
            "]);"
            f"return {{url:clip(page.url(),{_MAX_URL_CAPTURE_CHARS}),title,"
            "currentIndex:allPages.indexOf(page),tabs,screenshot};}"
        )

    async def _collect_observation(
        self,
        execution: _InvocationResult | None,
        *,
        remove_snapshot_file: bool = True,
    ) -> tuple[_PageMetadata, BrowserObservation]:
        self._observation_number += 1
        stem = f"observation-{self._observation_number}"
        screenshot_path = self._internal_directory / f"{stem}.png"
        observation_result = await self._invoke(
            "run-code",
            [
                self._observation_script(
                    None if self._screenshots_suppressed else screenshot_path
                )
            ],
            capture_limit=_MAX_OBSERVATION_CAPTURE_BYTES,
        )
        modal_state = self._blocked_by_modal_state(observation_result)
        if modal_state:
            if execution is None or self._current_metadata is None:
                raise PlaywrightCliRuntimeError("browser_failed")
            raw_observation: dict[str, object] = {}
            metadata = self._current_metadata
        else:
            self._require_success(observation_result)
            raw_observation = self._decode_run_code_result(observation_result)
            metadata = self._parse_metadata(raw_observation)

        dom = self._snapshot_from_execution(
            execution,
            remove_file=remove_snapshot_file,
        )
        if not dom:
            dom = await self._fallback_snapshot(stem)

        screenshot: BrowserScreenshot | None = None
        if (
            not self._screenshots_suppressed
            and raw_observation.get("screenshot") is True
        ):
            png = self._read_binary_artifact(screenshot_path, _MAX_SCREENSHOT_BYTES)
            if png is not None and png.startswith(b"\x89PNG\r\n\x1a\n"):
                screenshot = BrowserScreenshot(
                    data=base64.b64encode(png).decode("ascii")
                )
        try:
            screenshot_path.unlink(missing_ok=True)
        except OSError:
            pass

        tabs = []
        for index, (url, title) in enumerate(metadata.tabs):
            allowed = self._url_is_allowed(url, self._approved_origins)
            tabs.append(
                BrowserTab(
                    url=self._public_redacted_url(url) if allowed else "[redacted]",
                    title=title if allowed else "[redacted]",
                    tab_id=str(index)[:_MAX_TAB_ID_CHARS],
                    parent_tab_id=None,
                )
            )
        return metadata, BrowserObservation(
            url=self._public_redacted_url(metadata.url),
            title=metadata.title,
            tabs=tabs,
            dom=dom,
            page_info={"current_tab": metadata.current_index},
            screenshot=screenshot,
        )

    def _snapshot_from_execution(
        self,
        execution: _InvocationResult | None,
        *,
        remove_file: bool,
    ) -> str:
        if execution is None:
            return ""
        cleanup_path: Path | None = None
        try:
            payload = json.loads(execution.stdout.decode("utf-8"))
            if not isinstance(payload, dict):
                return ""
            snapshot = payload.get("snapshot")
            if isinstance(snapshot, str):
                return self._redact_bounded_text(
                    snapshot[:_MAX_DOM_CAPTURE_CHARS],
                    _MAX_DOM_CHARS,
                )
            if not isinstance(snapshot, dict):
                return ""
            filename = snapshot.get("file")
            if not isinstance(filename, str):
                return ""
            candidate = Path(filename)
            if not candidate.is_absolute():
                candidate = self._session_directory / candidate
            if self._screenshots_suppressed:
                return ""
            resolved = candidate.resolve(strict=True)
            if not _is_within(resolved, self._output_directory):
                return ""
            if remove_file:
                cleanup_path = resolved
            return self._read_text_artifact(resolved, _MAX_DOM_CHARS)
        except (json.JSONDecodeError, OSError, UnicodeError):
            return ""
        finally:
            if cleanup_path is not None:
                try:
                    cleanup_path.unlink(missing_ok=True)
                except OSError:
                    pass

    async def _fallback_snapshot(self, stem: str) -> str:
        if self._screenshots_suppressed:
            snapshot_result = await self._invoke(
                "snapshot",
                capture_limit=_MAX_INTERNAL_CAPTURE_BYTES,
            )
            if (
                snapshot_result.exit_code != 0
                or self._reported_cli_error(snapshot_result)
                or snapshot_result.stdout_truncated
            ):
                return ""
            return self._snapshot_from_execution(
                snapshot_result,
                remove_file=True,
            )
        snapshot_path = self._internal_directory / f"{stem}.yml"
        snapshot_result = await self._invoke(
            "snapshot",
            [f"--filename={snapshot_path}"],
            capture_limit=_MAX_INTERNAL_CAPTURE_BYTES,
        )
        dom = ""
        if (
            snapshot_result.exit_code == 0
            and not self._reported_cli_error(snapshot_result)
        ):
            dom = self._read_text_artifact(snapshot_path, _MAX_DOM_CHARS)
        try:
            snapshot_path.unlink(missing_ok=True)
        except OSError:
            pass
        return dom

    def _read_text_artifact(self, path: Path, limit: int) -> str:
        try:
            if path.is_symlink() or not path.is_file():
                return ""
            if not _is_within(path.resolve(strict=True), self._session_directory):
                return ""
            capture_chars = (
                max(limit, _MAX_DOM_CAPTURE_CHARS)
                if self._screenshots_suppressed
                else limit
            )
            byte_limit = capture_chars * 4
            with path.open("rb") as artifact:
                raw = artifact.read(byte_limit + 1)
            decoded = raw.decode("utf-8")[:capture_chars]
        except (OSError, UnicodeError):
            return ""
        return self._redact_bounded_text(decoded, limit)

    def _read_binary_artifact(self, path: Path, limit: int) -> bytes | None:
        try:
            if path.is_symlink() or not path.is_file():
                return None
            if not _is_within(path.resolve(strict=True), self._session_directory):
                return None
            if path.stat().st_size > limit:
                return None
            path.chmod(0o600)
            with path.open("rb") as artifact:
                raw = artifact.read(limit + 1)
        except OSError:
            return None
        return raw if len(raw) <= limit else None

    @staticmethod
    def _directory_size_exceeds(root: Path, limit: int) -> bool:
        total = 0
        pending = [root]
        try:
            while pending:
                directory = pending.pop()
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if entry.is_symlink():
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(Path(entry.path))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        total += entry.stat(follow_symlinks=False).st_size
                        if total > limit:
                            return True
        except OSError:
            return True
        return False


    def _url_is_allowed(self, value: str, origins: tuple[str, ...]) -> bool:
        try:
            parsed = urlsplit(value)
            scheme = parsed.scheme.lower()
            if scheme in _SAFE_INTERNAL_SCHEMES:
                return scheme != "about" or value == "about:blank"
            return _origin_for_url(value) in origins
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _collapse_redaction_sentinels(value: str) -> str:
        return re.sub("\ue000+", "[redacted]", value)

    def _length_preserving_redaction(self, value: str) -> tuple[str, bool]:
        redacted = value
        changed = False
        for private in self._private_redaction_values:
            if private not in redacted:
                continue
            redacted = redacted.replace(private, "\ue000" * len(private))
            changed = True
        return redacted, changed

    def _redact_bounded_text(self, value: str, limit: int) -> str:
        redacted, _changed = self._length_preserving_redaction(value)
        return self._collapse_redaction_sentinels(redacted[:limit])[:limit]


    def _redact_text(self, value: str) -> str:
        redacted = value
        for private in self._private_redaction_values:
            redacted = redacted.replace(private, "[redacted]")
        return redacted

    def _public_redacted_url(self, value: str) -> str:
        captured = value[:_MAX_URL_CAPTURE_CHARS]
        raw_redacted, raw_changed = self._length_preserving_redaction(captured)
        if raw_changed:
            return self._collapse_redaction_sentinels(
                raw_redacted[:_MAX_URL_CHARS]
            )[:_MAX_URL_CHARS]

        if len(value) >= _MAX_URL_CAPTURE_CHARS:
            try:
                return f"{_origin_for_url(captured)}/[redacted]"
            except (TypeError, ValueError):
                return "[redacted]"

        if re.search(r"%(?:[0-9A-Fa-f])?$", captured) is not None:
            try:
                return f"{_origin_for_url(captured)}/[redacted]"
            except (TypeError, ValueError):
                return "[redacted]"

        decoded = captured
        for _ in range(16):
            next_decoded = unquote(decoded)
            if next_decoded == decoded:
                decoded_redacted, decoded_changed = (
                    self._length_preserving_redaction(decoded)
                )
                if decoded_changed:
                    return self._collapse_redaction_sentinels(
                        decoded_redacted[:_MAX_URL_CHARS]
                    )[:_MAX_URL_CHARS]
                return captured[:_MAX_URL_CHARS]
            decoded = next_decoded
        # Fail closed instead of exposing a deeply encoded value or decoding forever.
        return "[redacted]"


    def _public_output(self, raw: bytes) -> tuple[str, bool]:
        decoded = raw.decode("utf-8", errors="replace")
        redacted = self._redact_text(decoded)
        if len(redacted) <= _MAX_OUTPUT_CHARS:
            return redacted, False
        return redacted[-_MAX_OUTPUT_CHARS:], True


__all__ = [
    "BrowserConfigurationError",
    "PlaywrightCliRuntime",
    "PlaywrightCliRuntimeError",
    "ResolvedBrowserLaunch",
    "recover_stale_playwright_cli_sessions",
    "resolve_browser_launch",
]
