from __future__ import annotations

import argparse
import errno
import logging
import os
import stat
from collections.abc import Mapping, Sequence
from pathlib import Path
from shutil import which

import uvicorn
from pydantic import ValidationError
from . import DEFAULT_SESSION_TIMEOUT_SECONDS

from .api import HarnessDependencies, create_app
from .playwright_cli import (
    BrowserConfigurationError,
    ResolvedBrowserLaunch,
    default_playwright_cli_script,
    resolve_browser_launch,
)
from .models import BrowserLaunchConfig, HarnessConfig
from .sessions import ApplicationSessionManager


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jobhunter-browser-harness",
        description=(
            "Run the authenticated Playwright CLI application harness on loopback."
        ),
        allow_abbrev=False,
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="loopback API port (default: 8765)",
    )
    parser.add_argument(
        "--pipeline-url",
        default="http://127.0.0.1:3457",
        help="loopback pipeline origin (default: http://127.0.0.1:3457)",
    )
    parser.add_argument(
        "--session-timeout",
        type=int,
        default=DEFAULT_SESSION_TIMEOUT_SECONDS,
        help=(
            "absolute session lifetime in seconds "
            f"(default: {DEFAULT_SESSION_TIMEOUT_SECONDS})"
        ),
    )
    parser.add_argument(
        "--node-executable",
        type=Path,
        default=None,
        help="Node.js executable; resolved from PATH when omitted",
    )
    parser.add_argument(
        "--playwright-cli-script",
        type=Path,
        default=None,
        help=(
            "Playwright CLI script "
            "(default: apps/node_modules/@playwright/cli/playwright-cli.js)"
        ),
    )
    parser.add_argument(
        "--user-info-json",
        type=Path,
        default=None,
        help="durable scoped user-information JSON store",
    )
    launch = parser.add_mutually_exclusive_group()
    launch.add_argument(
        "--chrome-executable",
        type=Path,
        help="system Chrome/Chromium executable; auto-detected when omitted",
    )
    launch.add_argument(
        "--cdp-url",
        help="loopback CDP origin for an already-running dedicated-profile Chrome",
    )
    parser.add_argument(
        "--chrome-user-data-dir",
        type=Path,
        default=None,
        help=(
            "dedicated non-default Chrome data directory "
            "(default: ~/.jobhunter/browser-harness/chrome)"
        ),
    )
    return parser


def _resolve_regular_file(
    path: Path,
    *,
    description: str,
    executable: bool = False,
) -> Path:
    try:
        resolved = path.expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise ValueError(f"The {description} is unavailable") from None
    if not resolved.is_file() or (executable and not os.access(resolved, os.X_OK)):
        raise ValueError(f"The {description} is unavailable")
    return resolved

_DEFAULT_TOKEN_PATH = Path("~/.jobhunter/browser-harness/token")
_MAX_TOKEN_FILE_BYTES = 4096


def _read_default_token(path: Path) -> str:
    token_path = path.expanduser()
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        descriptor = os.open(token_path, flags)
    except FileNotFoundError:
        raise ValueError(
            f"default token file does not exist: {token_path}"
        ) from None
    except OSError as error:
        if error.errno == errno.ELOOP:
            raise ValueError(
                f"default token path must not be a symbolic link: {token_path}"
            ) from None
        raise ValueError(
            f"default token file could not be read: {token_path}"
        ) from None

    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode):
            raise ValueError(
                f"default token path must be a regular file: {token_path}"
            )
        if details.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise ValueError(
                "default token file must not grant group or other permissions: "
                f"{token_path}"
            )
        if details.st_size > _MAX_TOKEN_FILE_BYTES:
            raise ValueError(
                "default token file must not exceed 4096 bytes: "
                f"{token_path}"
            )

        contents = bytearray()
        while len(contents) <= _MAX_TOKEN_FILE_BYTES:
            chunk = os.read(
                descriptor,
                _MAX_TOKEN_FILE_BYTES + 1 - len(contents),
            )
            if not chunk:
                break
            contents.extend(chunk)
        if len(contents) > _MAX_TOKEN_FILE_BYTES:
            raise ValueError(
                "default token file must not exceed 4096 bytes: "
                f"{token_path}"
            )
    except OSError:
        raise ValueError(
            f"default token file could not be read: {token_path}"
        ) from None
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass

    try:
        token = contents.decode("utf-8-sig", errors="strict").strip()
    except UnicodeDecodeError:
        raise ValueError(
            f"default token file must contain UTF-8 text: {token_path}"
        ) from None
    if len(token) < 32:
        raise ValueError(
            "default token file must contain at least 32 characters: "
            f"{token_path}"
        )
    return token


def parse_config(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    default_token_path: Path | None = None,
) -> tuple[HarnessConfig, ResolvedBrowserLaunch]:
    """Parse and fully validate startup configuration without starting Uvicorn."""

    parser = _parser()
    args = parser.parse_args(argv)
    environment = os.environ if environ is None else environ
    if "JOBHUNTER_HARNESS_TOKEN" in environment:
        token = environment["JOBHUNTER_HARNESS_TOKEN"]
        if len(token) < 32:
            parser.error(
                "JOBHUNTER_HARNESS_TOKEN must be configured with at least 32 characters"
            )
    else:
        token_path = default_token_path
        if token_path is None and environ is None:
            token_path = _DEFAULT_TOKEN_PATH
        if token_path is None:
            parser.error(
                "JOBHUNTER_HARNESS_TOKEN must be configured with at least 32 characters"
            )
        try:
            token = _read_default_token(token_path)
        except ValueError as error:
            parser.error(str(error))
    if args.cdp_url is not None and args.chrome_user_data_dir is not None:
        parser.error("--cdp-url cannot be combined with --chrome-user-data-dir")

    browser_values: dict[str, object] = {}
    if args.cdp_url is not None:
        browser_values["cdp_url"] = args.cdp_url
    else:
        if args.chrome_executable is not None:
            browser_values["chrome_executable"] = args.chrome_executable
        if args.chrome_user_data_dir is not None:
            browser_values["chrome_user_data_dir"] = args.chrome_user_data_dir

    try:
        node_path = args.node_executable
        if node_path is None:
            detected_node = which("node")
            if detected_node is None:
                raise ValueError("The Node.js executable is unavailable")
            node_path = Path(detected_node)
        node_executable = _resolve_regular_file(
            node_path,
            description="Node.js executable",
            executable=True,
        )
        cli_path = args.playwright_cli_script
        if cli_path is None:
            cli_path = default_playwright_cli_script()
        playwright_cli_script = _resolve_regular_file(
            cli_path,
            description="Playwright CLI script",
        )
        browser = BrowserLaunchConfig.model_validate(browser_values)
        config = HarnessConfig(
            bearer_token=token,
            pipeline_url=args.pipeline_url,
            port=args.port,
            session_timeout=args.session_timeout,
            node_executable=node_executable,
            playwright_cli_script=playwright_cli_script,
            user_info_json=(
                Path("apps/user-info/current-context/personal/user-info.json")
                if args.user_info_json is None
                else args.user_info_json.expanduser().resolve()
            ),
            browser=browser,
        )
        resolved = resolve_browser_launch(browser)
    except (ValidationError, BrowserConfigurationError, ValueError) as error:
        parser.error(str(error))
    return config, resolved


def _configure_logging() -> None:
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def main(argv: Sequence[str] | None = None) -> None:
    config, browser_launch = parse_config(argv)
    _configure_logging()
    sessions = ApplicationSessionManager(
        config,
        browser_launch=browser_launch,
    )
    app = create_app(config, HarnessDependencies(sessions=sessions))
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=config.port,
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
