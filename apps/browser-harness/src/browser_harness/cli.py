from __future__ import annotations

import argparse
import logging
import os
from collections.abc import Mapping, Sequence
from pathlib import Path

import uvicorn
from pydantic import ValidationError

from .api import HarnessDependencies, create_app
from .browser import (
    BrowserConfigurationError,
    ResolvedBrowserLaunch,
    resolve_browser_launch,
)
from .models import BrowserLaunchConfig, HarnessConfig
from .sessions import ApplicationSessionManager


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jobhunter-browser-harness",
        description=(
            "Run the authenticated Browser Use application harness on loopback."
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
        default=3600,
        help="absolute session lifetime in seconds (default: 3600)",
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


def parse_config(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> tuple[HarnessConfig, ResolvedBrowserLaunch]:
    """Parse and fully validate startup configuration without starting Uvicorn."""

    parser = _parser()
    args = parser.parse_args(argv)
    environment = os.environ if environ is None else environ
    token = environment.get("JOBHUNTER_HARNESS_TOKEN", "")
    if len(token) < 32:
        parser.error(
            "JOBHUNTER_HARNESS_TOKEN must be configured with at least 32 characters"
        )
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
        browser = BrowserLaunchConfig.model_validate(browser_values)
        config = HarnessConfig(
            bearer_token=token,
            pipeline_url=args.pipeline_url,
            port=args.port,
            session_timeout=args.session_timeout,
            browser=browser,
        )
        resolved = resolve_browser_launch(browser)
    except (ValidationError, BrowserConfigurationError, ValueError) as error:
        parser.error(str(error))
    return config, resolved


def _configure_logging() -> None:
    logging.getLogger("browser_use").setLevel(logging.WARNING)
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
