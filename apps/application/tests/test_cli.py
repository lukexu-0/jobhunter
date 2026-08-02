from __future__ import annotations

import logging
import stat
from hashlib import sha256
from pathlib import Path
from typing import Any

import pytest

import jobhunter_browser_harness.cli as cli_module
import jobhunter_browser_harness.playwright_cli as playwright_cli_module
from jobhunter_browser_harness.api import HarnessDependencies
from jobhunter_browser_harness.models import BrowserLaunchConfig, HarnessConfig
from jobhunter_browser_harness.playwright_cli import ResolvedBrowserLaunch


TOKEN = "test-token-0123456789abcdef-0123456789"
LOOPBACK_CDP_URL = "http://127.0.0.1:9222"


@pytest.fixture
def fake_playwright_cli(tmp_path: Path) -> tuple[Path, Path]:
    node = tmp_path / "node"
    node.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    node.chmod(0o700)
    script = tmp_path / "playwright-cli.js"
    script.write_text("export {};\n", encoding="utf-8")
    return node, script


def _runtime_args(paths: tuple[Path, Path]) -> list[str]:
    node, script = paths
    return [
        "--node-executable",
        str(node),
        "--playwright-cli-script",
        str(script),
    ]


def _assert_parse_error(
    argv: list[str],
    *,
    environ: dict[str, str] | None = None,
    default_token_path: Path | None = None,
) -> None:
    with pytest.raises(SystemExit) as raised:
        if default_token_path is None:
            cli_module.parse_config(
                argv,
                environ=(
                    {"JOBHUNTER_HARNESS_TOKEN": TOKEN}
                    if environ is None
                    else environ
                ),
            )
        else:
            cli_module.parse_config(
                argv,
                environ=(
                    {"JOBHUNTER_HARNESS_TOKEN": TOKEN}
                    if environ is None
                    else environ
                ),
                default_token_path=default_token_path,
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
    assert "Run the authenticated Playwright CLI application harness on loopback." in captured.out
    assert "--port" in captured.out
    assert "--pipeline-url" in captured.out
    assert "--session-timeout" in captured.out
    assert "--node-executable" in captured.out
    assert "--playwright-cli-script" in captured.out
    assert "--user-info-json" in captured.out
    assert "--chrome-executable" in captured.out
    assert "--chrome-user-data-dir" in captured.out
    assert "--cdp-url" in captured.out
    assert "--host" not in captured.out
    assert "--token" not in captured.out


def test_default_token_file_is_loaded_with_outer_whitespace_trimmed(
    tmp_path: Path,
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    token_path = tmp_path / "token"
    token_path.write_text(f" \n\t{TOKEN}\t \n", encoding="utf-8")
    token_path.chmod(0o600)

    config, _ = cli_module.parse_config(
        [
            *_runtime_args(fake_playwright_cli),
            "--cdp-url",
            LOOPBACK_CDP_URL,
        ],
        environ={},
        default_token_path=token_path,
    )

    assert config.bearer_token == TOKEN


def test_default_token_file_matches_typescript_runtime_by_stripping_utf8_bom(
    tmp_path: Path,
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    token_path = tmp_path / "token"
    token_path.write_bytes(b"\xef\xbb\xbf" + TOKEN.encode("utf-8"))
    token_path.chmod(0o600)

    config, _ = cli_module.parse_config(
        [
            *_runtime_args(fake_playwright_cli),
            "--cdp-url",
            LOOPBACK_CDP_URL,
        ],
        environ={},
        default_token_path=token_path,
    )

    assert sha256(config.bearer_token.encode("utf-8")).digest() == sha256(
        TOKEN.encode("utf-8")
    ).digest()


@pytest.mark.parametrize(
    "token_source",
    ["explicit environment", "private default file"],
    ids=["explicit-environment", "private-default-file"],
)
def test_token_minimum_matches_typescript_runtime_by_counting_unicode_code_points(
    token_source: str,
    tmp_path: Path,
    fake_playwright_cli: tuple[Path, Path],
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Sixteen Unicode code points occupy 32 UTF-16 code units.
    sixteen_code_points = "😀" * 16
    thirty_two_code_points = "😀" * 32
    token_path = tmp_path / "token"
    environ: dict[str, str] = {}
    if token_source == "explicit environment":
        environ["JOBHUNTER_HARNESS_TOKEN"] = sixteen_code_points
    else:
        token_path.write_text(sixteen_code_points, encoding="utf-8")
        token_path.chmod(0o600)

    argv = [
        *_runtime_args(fake_playwright_cli),
        "--cdp-url",
        LOOPBACK_CDP_URL,
    ]
    _assert_parse_error(
        argv,
        environ=environ,
        default_token_path=token_path,
    )
    error = capsys.readouterr().err
    if "at least 32" not in error:
        pytest.fail("Expected token validation to report the 32-character minimum", pytrace=False)
    if sixteen_code_points in error:
        pytest.fail("Token validation error disclosed token content", pytrace=False)

    if token_source == "explicit environment":
        environ["JOBHUNTER_HARNESS_TOKEN"] = thirty_two_code_points
    else:
        token_path.write_text(thirty_two_code_points, encoding="utf-8")

    config, _ = cli_module.parse_config(
        argv,
        environ=environ,
        default_token_path=token_path,
    )
    assert sha256(config.bearer_token.encode("utf-8")).digest() == sha256(
        thirty_two_code_points.encode("utf-8")
    ).digest()


def test_explicit_token_wins_when_default_file_is_missing(
    tmp_path: Path,
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    missing_token_path = tmp_path / "missing-token"

    config, _ = cli_module.parse_config(
        [
            *_runtime_args(fake_playwright_cli),
            "--cdp-url",
            LOOPBACK_CDP_URL,
        ],
        environ={"JOBHUNTER_HARNESS_TOKEN": TOKEN},
        default_token_path=missing_token_path,
    )

    assert config.bearer_token == TOKEN


def test_invalid_explicit_token_does_not_fall_back_to_default_file(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    token_path = tmp_path / "token"
    token_path.write_text(TOKEN, encoding="utf-8")
    token_path.chmod(0o600)
    invalid_token = "too-short"

    _assert_parse_error(
        ["--cdp-url", LOOPBACK_CDP_URL],
        environ={"JOBHUNTER_HARNESS_TOKEN": invalid_token},
        default_token_path=token_path,
    )

    error = capsys.readouterr().err
    assert (
        "JOBHUNTER_HARNESS_TOKEN must be configured with at least 32 characters"
        in error
    )
    assert invalid_token not in error
    assert TOKEN not in error


def test_missing_default_token_file_reports_its_path(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    token_path = tmp_path / "missing-token"

    _assert_parse_error(
        ["--cdp-url", LOOPBACK_CDP_URL],
        environ={},
        default_token_path=token_path,
    )

    error = capsys.readouterr().err
    assert "default token file does not exist" in error
    assert str(token_path) in error


def test_default_token_file_rejects_a_short_trimmed_token(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    token_path = tmp_path / "token"
    short_token = " \n too-short \t"
    token_path.write_text(short_token, encoding="utf-8")
    token_path.chmod(0o600)

    _assert_parse_error(
        ["--cdp-url", LOOPBACK_CDP_URL],
        environ={},
        default_token_path=token_path,
    )

    error = capsys.readouterr().err
    assert "default token file must contain at least 32 characters" in error
    assert str(token_path) in error
    assert short_token.strip() not in error


def test_default_token_file_rejects_non_utf8_content(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    token_path = tmp_path / "token"
    token_path.write_bytes((b"x" * 32) + b"\xff")
    token_path.chmod(0o600)

    _assert_parse_error(
        ["--cdp-url", LOOPBACK_CDP_URL],
        environ={},
        default_token_path=token_path,
    )

    error = capsys.readouterr().err
    assert "default token file must contain UTF-8 text" in error
    assert str(token_path) in error


@pytest.mark.parametrize(
    "mode",
    [0o640, 0o602],
    ids=["group-readable", "other-writable"],
)
def test_default_token_file_rejects_group_or_other_permissions(
    tmp_path: Path,
    mode: int,
    capsys: pytest.CaptureFixture[str],
) -> None:
    token_path = tmp_path / "token"
    token_path.write_text(TOKEN, encoding="utf-8")
    token_path.chmod(mode)

    _assert_parse_error(
        ["--cdp-url", LOOPBACK_CDP_URL],
        environ={},
        default_token_path=token_path,
    )

    error = capsys.readouterr().err
    assert (
        "default token file must not grant group or other permissions" in error
    )
    assert str(token_path) in error
    assert TOKEN not in error


def test_default_token_file_rejects_a_symlink(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    target_path = tmp_path / "token-target"
    target_path.write_text(TOKEN, encoding="utf-8")
    target_path.chmod(0o600)
    token_path = tmp_path / "token"
    token_path.symlink_to(target_path)

    _assert_parse_error(
        ["--cdp-url", LOOPBACK_CDP_URL],
        environ={},
        default_token_path=token_path,
    )

    error = capsys.readouterr().err
    assert "default token path must not be a symbolic link" in error
    assert str(token_path) in error
    assert TOKEN not in error


def test_default_token_path_must_be_a_regular_file(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    token_path = tmp_path / "token"
    token_path.mkdir(mode=0o700)

    _assert_parse_error(
        ["--cdp-url", LOOPBACK_CDP_URL],
        environ={},
        default_token_path=token_path,
    )

    error = capsys.readouterr().err
    assert "default token path must be a regular file" in error
    assert str(token_path) in error


def test_default_token_file_rejects_more_than_4096_bytes(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    token_path = tmp_path / "token"
    secret_prefix = "oversized-secret-value"
    oversized_token = secret_prefix + ("x" * (4097 - len(secret_prefix)))
    token_path.write_text(oversized_token, encoding="utf-8")
    token_path.chmod(0o600)

    _assert_parse_error(
        ["--cdp-url", LOOPBACK_CDP_URL],
        environ={},
        default_token_path=token_path,
    )

    error = capsys.readouterr().err
    assert "default token file must not exceed 4096 bytes" in error
    assert str(token_path) in error
    assert secret_prefix not in error


def test_valid_native_configuration_resolves_fake_executable_and_dedicated_profile(
    tmp_path: Path,
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    executable = tmp_path / "chrome"
    executable.write_bytes(b"fake Chrome executable")
    executable.chmod(0o700)
    profile = tmp_path / "dedicated-profile"

    config, launch = cli_module.parse_config(
        [
            *_runtime_args(fake_playwright_cli),
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
        node_executable=fake_playwright_cli[0].resolve(),
        playwright_cli_script=fake_playwright_cli[1].resolve(),
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



def test_default_session_timeout_is_four_hours(
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    config, _launch = cli_module.parse_config(
        [
            *_runtime_args(fake_playwright_cli),
            "--cdp-url",
            LOOPBACK_CDP_URL,
        ],
        environ={"JOBHUNTER_HARNESS_TOKEN": TOKEN},
    )

    assert config.session_timeout == 14_400
    assert HarnessConfig(bearer_token=TOKEN).session_timeout == 14_400

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
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    config, launch = cli_module.parse_config(
        [
            *_runtime_args(fake_playwright_cli),
            "--cdp-url",
            provided,
        ],
        environ={"JOBHUNTER_HARNESS_TOKEN": TOKEN},
    )

    assert config.browser.cdp_url == canonical
    assert launch == ResolvedBrowserLaunch(
        cdp_url=canonical,
        executable_path=None,
        user_data_dir=None,
    )


def test_runtime_paths_are_explicit_resolved_configuration(
    tmp_path: Path,
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    node, script = fake_playwright_cli
    user_info_json = tmp_path / "private" / "user-info.json"

    config, _ = cli_module.parse_config(
        [
            "--cdp-url",
            LOOPBACK_CDP_URL,
            "--node-executable",
            str(node),
            "--playwright-cli-script",
            str(script),
            "--user-info-json",
            str(user_info_json),
        ],
        environ={"JOBHUNTER_HARNESS_TOKEN": TOKEN},
    )

    assert config.node_executable == node.resolve()
    assert config.playwright_cli_script == script.resolve()
    assert config.user_info_json == user_info_json.resolve()


def test_runtime_paths_default_to_detected_node_and_repository_cli_script(
    fake_playwright_cli: tuple[Path, Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    node, _script = fake_playwright_cli
    resolutions: list[tuple[Path, str, bool]] = []

    def fake_resolve_regular_file(
        path: Path,
        *,
        description: str,
        executable: bool = False,
    ) -> Path:
        resolutions.append((path, description, executable))
        return path.expanduser().resolve()

    monkeypatch.setattr(
        cli_module,
        "which",
        lambda name: str(node) if name == "node" else None,
    )
    monkeypatch.setattr(
        cli_module,
        "_resolve_regular_file",
        fake_resolve_regular_file,
    )

    config, _ = cli_module.parse_config(
        ["--cdp-url", LOOPBACK_CDP_URL],
        environ={"JOBHUNTER_HARNESS_TOKEN": TOKEN},
    )
    default_script = playwright_cli_module.default_playwright_cli_script()

    assert config.node_executable == node.resolve()
    assert config.playwright_cli_script == default_script.resolve()
    assert resolutions == [
        (node, "Node.js executable", True),
        (default_script, "Playwright CLI script", False),
    ]


def test_default_cli_script_falls_back_to_installed_path_binary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    installed = tmp_path / "bin" / "playwright-cli"
    installed.parent.mkdir()
    installed.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    installed.chmod(0o700)
    monkeypatch.setattr(
        playwright_cli_module,
        "_playwright_cli_workspace_roots",
        lambda: (tmp_path / "missing-workspace",),
        raising=False,
    )
    monkeypatch.setattr(
        playwright_cli_module.shutil,
        "which",
        lambda name: str(installed) if name == "playwright-cli" else None,
    )

    assert (
        playwright_cli_module.default_playwright_cli_script()
        == installed.resolve()
    )


@pytest.mark.parametrize(
    "invalid_path",
    ["node-missing", "node-not-executable", "script-directory"],
)
def test_runtime_paths_require_an_executable_node_and_regular_cli_script(
    invalid_path: str,
    tmp_path: Path,
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    node, script = fake_playwright_cli
    if invalid_path == "node-missing":
        node = tmp_path / "missing-node"
    elif invalid_path == "node-not-executable":
        node = tmp_path / "non-executable-node"
        node.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        node.chmod(0o600)
    else:
        script = tmp_path / "cli-directory"
        script.mkdir()

    _assert_parse_error(
        [
            "--node-executable",
            str(node),
            "--playwright-cli-script",
            str(script),
            "--cdp-url",
            LOOPBACK_CDP_URL,
        ]
    )


@pytest.mark.parametrize(
    "cdp_url",
    [
        "http://127.0.0.1",
        "http://localhost:9222/json/version",
        "http://203.0.113.10:9222",
    ],
    ids=["missing-port", "path", "public-host"],
)
def test_cdp_rejects_missing_port_path_and_public_host(
    cdp_url: str,
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    _assert_parse_error(
        [*_runtime_args(fake_playwright_cli), "--cdp-url", cdp_url]
    )


@pytest.mark.parametrize(
    "conflicting_option",
    ["--chrome-executable", "--chrome-user-data-dir"],
)
def test_cdp_rejects_native_launch_options(
    conflicting_option: str,
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    _assert_parse_error(
        [
            *_runtime_args(fake_playwright_cli),
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
    fake_playwright_cli: tuple[Path, Path],
) -> None:
    _assert_parse_error([*_runtime_args(fake_playwright_cli), *argv])


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
    fake_playwright_cli: tuple[Path, Path],
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
    for logger_name in ("httpx", "httpcore"):
        monkeypatch.setattr(logging.getLogger(logger_name), "level", logging.DEBUG)

    cli_module.main(
        [
            *_runtime_args(fake_playwright_cli),
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
        node_executable=fake_playwright_cli[0].resolve(),
        playwright_cli_script=fake_playwright_cli[1].resolve(),
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
    for logger_name in ("httpx", "httpcore"):
        assert logging.getLogger(logger_name).level == logging.WARNING
