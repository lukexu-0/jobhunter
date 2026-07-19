from __future__ import annotations

import logging
import stat
from pathlib import Path
from typing import Any

import pytest

import jobhunter_browser_harness.cli as cli_module
from jobhunter_browser_harness.api import HarnessDependencies
from jobhunter_browser_harness.browser import ResolvedBrowserLaunch
from jobhunter_browser_harness.models import BrowserLaunchConfig, HarnessConfig


TOKEN = "test-token-0123456789abcdef-0123456789"
LOOPBACK_CDP_URL = "http://127.0.0.1:9222"


def _assert_parse_error(argv: list[str], *, environ: dict[str, str] | None = None) -> None:
    with pytest.raises(SystemExit) as raised:
        cli_module.parse_config(
            argv,
            environ={"JOBHUNTER_HARNESS_TOKEN": TOKEN} if environ is None else environ,
        )

    assert raised.value.code == 2


def test_help_succeeds_without_configured_token(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as raised:
        cli_module.parse_config(["--help"], environ={})

    assert raised.value.code == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    assert "Run the authenticated Browser Use application harness on loopback." in captured.out
    assert "--port" in captured.out
    assert "--pipeline-url" in captured.out
    assert "--session-timeout" in captured.out
    assert "--bubblewrap-executable" in captured.out
    assert "--browser-skill-workspace" in captured.out
    assert "--chrome-executable" in captured.out
    assert "--chrome-user-data-dir" in captured.out
    assert "--cdp-url" in captured.out
    assert "--host" not in captured.out
    assert "--token" not in captured.out


@pytest.mark.parametrize(
    "environ",
    [
        {},
        {"JOBHUNTER_HARNESS_TOKEN": "too-short"},
    ],
    ids=["missing", "short"],
)
def test_token_must_come_from_environment_and_have_at_least_32_characters(
    environ: dict[str, str],
    capsys: pytest.CaptureFixture[str],
) -> None:
    _assert_parse_error(["--cdp-url", LOOPBACK_CDP_URL], environ=environ)

    error = capsys.readouterr().err
    assert "JOBHUNTER_HARNESS_TOKEN must be configured with at least 32 characters" in error
    if token := environ.get("JOBHUNTER_HARNESS_TOKEN"):
        assert token not in error


def test_valid_native_configuration_resolves_fake_executable_and_dedicated_profile(
    tmp_path: Path,
) -> None:
    executable = tmp_path / "chrome"
    executable.write_bytes(b"fake Chrome executable")
    executable.chmod(0o700)
    profile = tmp_path / "dedicated-profile"

    config, launch = cli_module.parse_config(
        [
            "--port",
            "9876",
            "--pipeline-url",
            "http://localhost:4567",
            "--session-timeout",
            "123",
            "--chrome-executable",
            str(executable),
            "--chrome-user-data-dir",
            str(profile),
        ],
        environ={"JOBHUNTER_HARNESS_TOKEN": TOKEN},
    )

    assert config == HarnessConfig(
        bearer_token=TOKEN,
        pipeline_url="http://localhost:4567",
        port=9876,
        session_timeout=123,
        browser=BrowserLaunchConfig(
            chrome_executable=executable,
            chrome_user_data_dir=profile,
        ),
    )
    assert launch == ResolvedBrowserLaunch(
        cdp_url=None,
        executable_path=executable.resolve(),
        user_data_dir=profile.resolve(),
    )
    assert profile.is_dir()
    assert stat.S_IMODE(profile.stat().st_mode) == 0o700


@pytest.mark.parametrize(
    ("provided", "canonical"),
    [
        ("http://127.0.0.1:9222", "http://127.0.0.1:9222"),
        ("http://localhost:9333/", "http://localhost:9333"),
        ("http://[::1]:9444", "http://[::1]:9444"),
    ],
)
def test_valid_loopback_cdp_configuration(
    provided: str,
    canonical: str,
) -> None:
    config, launch = cli_module.parse_config(
        ["--cdp-url", provided],
        environ={"JOBHUNTER_HARNESS_TOKEN": TOKEN},
    )

    assert config.browser.cdp_url == canonical
    assert launch == ResolvedBrowserLaunch(
        cdp_url=canonical,
        executable_path=None,
        user_data_dir=None,
    )


def test_bubblewrap_and_skill_workspace_are_explicit_resolved_configuration(
    tmp_path: Path,
) -> None:
    bubblewrap = tmp_path / "bwrap"
    bubblewrap.write_bytes(b"fake bubblewrap executable")
    bubblewrap.chmod(0o700)
    workspace = tmp_path / "browser-skill" / "agent-workspace"

    config, _ = cli_module.parse_config(
        [
            "--cdp-url",
            LOOPBACK_CDP_URL,
            "--bubblewrap-executable",
            str(bubblewrap),
            "--browser-skill-workspace",
            str(workspace),
        ],
        environ={"JOBHUNTER_HARNESS_TOKEN": TOKEN},
    )

    assert config.bubblewrap_executable == bubblewrap.resolve()
    assert config.browser_skill_workspace == workspace


@pytest.mark.parametrize(
    "cdp_url",
    [
        "http://127.0.0.1",
        "http://localhost:9222/json/version",
        "http://203.0.113.10:9222",
    ],
    ids=["missing-port", "path", "public-host"],
)
def test_cdp_rejects_missing_port_path_and_public_host(cdp_url: str) -> None:
    _assert_parse_error(["--cdp-url", cdp_url])


@pytest.mark.parametrize(
    "conflicting_option",
    ["--chrome-executable", "--chrome-user-data-dir"],
)
def test_cdp_rejects_native_launch_options(conflicting_option: str) -> None:
    _assert_parse_error(
        [
            "--cdp-url",
            LOOPBACK_CDP_URL,
            conflicting_option,
            "/dedicated/fake-chrome-path",
        ]
    )


@pytest.mark.parametrize(
    "argv",
    [
        ["--port", "0", "--cdp-url", LOOPBACK_CDP_URL],
        ["--port", "65536", "--cdp-url", LOOPBACK_CDP_URL],
        [
            "--pipeline-url",
            "http://pipeline.example:3457",
            "--cdp-url",
            LOOPBACK_CDP_URL,
        ],
        [
            "--pipeline-url",
            "https://127.0.0.1:3457",
            "--cdp-url",
            LOOPBACK_CDP_URL,
        ],
        [
            "--pipeline-url",
            "http://127.0.0.1:3457?private=value",
            "--cdp-url",
            LOOPBACK_CDP_URL,
        ],
        ["--session-timeout", "0", "--cdp-url", LOOPBACK_CDP_URL],
        ["--session-timeout", "86401", "--cdp-url", LOOPBACK_CDP_URL],
    ],
    ids=[
        "port-zero",
        "port-overflow",
        "public-pipeline",
        "https-pipeline",
        "pipeline-query",
        "session-timeout-zero",
        "session-timeout-overflow",
    ],
)
def test_invalid_port_pipeline_and_session_timeout_are_rejected(
    argv: list[str],
) -> None:
    _assert_parse_error(argv)


@pytest.mark.parametrize(
    "argv",
    [
        ["--host", "0.0.0.0"],
        ["--token", TOKEN],
        ["--pipe", "http://127.0.0.1:3457"],
        ["--chrome-exe", "/fake/chrome"],
    ],
    ids=["public-host-option", "token-option", "pipeline-abbreviation", "chrome-abbreviation"],
)
def test_public_host_token_options_and_long_option_abbreviations_do_not_exist(
    argv: list[str],
) -> None:
    _assert_parse_error(argv)


def test_main_wires_exact_configuration_dependencies_and_loopback_uvicorn(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = tmp_path / "chrome"
    profile = tmp_path / "dedicated-profile"
    resolved_launch = ResolvedBrowserLaunch(
        cdp_url=None,
        executable_path=tmp_path / "resolved-chrome",
        user_data_dir=tmp_path / "resolved-profile",
    )
    manager = object()
    app = object()
    resolve_calls: list[BrowserLaunchConfig] = []
    manager_calls: list[tuple[HarnessConfig, ResolvedBrowserLaunch]] = []
    create_app_calls: list[tuple[HarnessConfig, HarnessDependencies]] = []
    uvicorn_calls: list[tuple[object, dict[str, Any]]] = []

    def fake_resolve(browser: BrowserLaunchConfig) -> ResolvedBrowserLaunch:
        resolve_calls.append(browser)
        return resolved_launch

    def fake_manager(
        config: HarnessConfig,
        *,
        browser_launch: ResolvedBrowserLaunch,
    ) -> object:
        manager_calls.append((config, browser_launch))
        return manager

    def fake_create_app(
        config: HarnessConfig,
        dependencies: HarnessDependencies,
    ) -> object:
        create_app_calls.append((config, dependencies))
        return app

    def fake_uvicorn_run(application: object, **kwargs: Any) -> None:
        uvicorn_calls.append((application, kwargs))

    monkeypatch.setenv("JOBHUNTER_HARNESS_TOKEN", TOKEN)
    monkeypatch.setattr(cli_module, "resolve_browser_launch", fake_resolve)
    monkeypatch.setattr(cli_module, "ApplicationSessionManager", fake_manager)
    monkeypatch.setattr(cli_module, "create_app", fake_create_app)
    monkeypatch.setattr(cli_module.uvicorn, "run", fake_uvicorn_run)
    for logger_name in ("browser_use", "httpx", "httpcore"):
        monkeypatch.setattr(logging.getLogger(logger_name), "level", logging.DEBUG)

    cli_module.main(
        [
            "--port",
            "8766",
            "--pipeline-url",
            "http://localhost:3458",
            "--session-timeout",
            "1800",
            "--chrome-executable",
            str(executable),
            "--chrome-user-data-dir",
            str(profile),
        ]
    )

    expected_browser = BrowserLaunchConfig(
        chrome_executable=executable,
        chrome_user_data_dir=profile,
    )
    expected_config = HarnessConfig(
        bearer_token=TOKEN,
        pipeline_url="http://localhost:3458",
        port=8766,
        session_timeout=1800,
        browser=expected_browser,
    )
    assert resolve_calls == [expected_browser]
    assert manager_calls == [(expected_config, resolved_launch)]
    assert len(create_app_calls) == 1
    created_config, dependencies = create_app_calls[0]
    assert created_config == expected_config
    assert isinstance(dependencies, HarnessDependencies)
    assert dependencies.sessions is manager
    assert uvicorn_calls == [
        (
            app,
            {
                "host": "127.0.0.1",
                "port": 8766,
                "access_log": False,
                "log_level": "warning",
            },
        )
    ]
    for logger_name in ("browser_use", "httpx", "httpcore"):
        assert logging.getLogger(logger_name).level == logging.WARNING
