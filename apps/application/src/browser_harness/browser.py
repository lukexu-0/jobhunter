from __future__ import annotations

import os
import platform
import shutil
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from browser_use import Browser
from browser_use.browser import BrowserProfile, BrowserSession
from browser_use.browser.chrome import find_chrome_executable

from .models import BrowserLaunchConfig, validate_approved_origin


class BrowserConfigurationError(ValueError):
    """A sanitized browser configuration failure safe for CLI output."""


@dataclass(frozen=True, slots=True)
class ResolvedBrowserLaunch:
    cdp_url: str | None
    executable_path: Path | None
    user_data_dir: Path | None

    @property
    def is_cdp(self) -> bool:
        return self.cdp_url is not None


class _PersistentChromeProfile(BrowserProfile):
    """Keep the dedicated profile persistent under Browser Use 0.13.4.

    BrowserProfile 0.13.4 otherwise copies every Chrome profile to an unmanaged
    temporary directory. The harness owns a dedicated, non-default profile and
    intentionally uses it in place so login state survives across sessions.
    """

    def _copy_profile(self) -> None:
        return


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


def _resolve_executable(configured: Path | None) -> Path:
    if configured is None:
        if _is_wsl():
            raise BrowserConfigurationError(
                "System Chrome is not auto-discovered in WSL; start Windows Chrome with a dedicated profile and use --cdp-url"
            )
        discovered = find_chrome_executable()
        if not discovered:
            raise BrowserConfigurationError(
                "Chrome was not found; provide --chrome-executable or a loopback --cdp-url"
            )
        configured = Path(discovered)

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


def _reject_symlink_components(path: Path, message: str) -> None:
    absolute = path.absolute()
    for component in (absolute, *absolute.parents):
        try:
            component_mode = component.lstat().st_mode
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(component_mode):
            raise BrowserConfigurationError(message)


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
            raise BrowserConfigurationError("The Chrome user-data directory must have mode 0700")
    except BrowserConfigurationError:
        raise
    except OSError:
        raise BrowserConfigurationError("The Chrome user-data directory is unavailable") from None
    return profile


def resolve_browser_launch(config: BrowserLaunchConfig) -> ResolvedBrowserLaunch:
    """Validate browser configuration without launching Chrome."""

    if config.cdp_url is not None:
        parsed = urlsplit(config.cdp_url)
        if parsed.path not in {"", "/"} or parsed.port is None:
            raise BrowserConfigurationError(
                "The CDP URL must be a loopback HTTP origin with an explicit port"
            )
        return ResolvedBrowserLaunch(
            cdp_url=config.cdp_url,
            executable_path=None,
            user_data_dir=None,
        )

    return ResolvedBrowserLaunch(
        cdp_url=None,
        executable_path=_resolve_executable(config.chrome_executable),
        user_data_dir=_resolve_dedicated_profile(config.chrome_user_data_dir),
    )


def _prepare_downloads(path: Path) -> Path:
    expanded = path.expanduser()
    symlink_error = "The downloads directory must not be a symbolic link"
    try:
        _reject_symlink_components(expanded, symlink_error)
        resolved = expanded.resolve(strict=False)
        resolved.mkdir(mode=0o700, parents=False, exist_ok=True)
        if not resolved.is_dir() or resolved.is_symlink():
            raise BrowserConfigurationError("The downloads directory is invalid")
        resolved.chmod(0o700)
    except BrowserConfigurationError:
        raise
    except OSError:
        raise BrowserConfigurationError("The downloads directory is unavailable") from None
    return resolved


def create_browser(
    launch: ResolvedBrowserLaunch,
    approved_origins: tuple[str, ...] | list[str],
    downloads_path: Path,
) -> BrowserSession:
    """Construct one visible Browser Use session inside exact approved origins."""

    origins = [validate_approved_origin(origin) for origin in approved_origins]
    if not origins or len(origins) > 20 or len(set(origins)) != len(origins):
        raise BrowserConfigurationError("Approved origins are invalid")
    allowed_domains = [f"{origin}/" for origin in origins]
    downloads = _prepare_downloads(downloads_path)

    if launch.cdp_url is not None:
        return Browser(
            cdp_url=launch.cdp_url,
            headless=False,
            keep_alive=True,
            allowed_domains=allowed_domains,
            downloads_path=downloads,
        )

    if launch.executable_path is None or launch.user_data_dir is None:
        raise BrowserConfigurationError("Local Chrome configuration is incomplete")

    profile = _PersistentChromeProfile(
        is_local=True,
        executable_path=launch.executable_path,
        user_data_dir=launch.user_data_dir,
        profile_directory="Default",
        headless=False,
        keep_alive=True,
        args=[
            "--disable-window-activation",
            "--disable-focus-on-load",
        ],
        allowed_domains=allowed_domains,
        downloads_path=downloads,
        disable_security=False,
        chromium_sandbox=True,
        enable_default_extensions=False,
        record_har_path=None,
        record_video_dir=None,
        traces_dir=None,
    )
    # BrowserSession 0.13.4 always reconstructs a supplied BrowserProfile as
    # the base class, and assignment validation does the same. Bypass only
    # that field's validator so the no-copy profile subclass remains intact.
    browser = Browser(is_local=True)
    object.__setattr__(browser, "browser_profile", profile)
    return browser


def resolve_resume_upload_path(path: Path, launch: ResolvedBrowserLaunch) -> str:
    """Return the path understood by the browser process for the sole uploadable file."""

    local_path = path.expanduser().resolve(strict=True)
    if launch.cdp_url is None or not _is_wsl():
        return str(local_path)

    converter = shutil.which("wslpath")
    if converter is None:
        raise BrowserConfigurationError("WSL path translation is unavailable")
    try:
        result = subprocess.run(
            [converter, "-w", str(local_path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        raise BrowserConfigurationError("WSL path translation failed") from None
    translated = result.stdout.strip()
    if not translated:
        raise BrowserConfigurationError("WSL path translation failed")
    return translated


__all__ = [
    "BrowserConfigurationError",
    "ResolvedBrowserLaunch",
    "create_browser",
    "resolve_browser_launch",
    "resolve_resume_upload_path",
]
