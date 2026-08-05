from __future__ import annotations

import asyncio
import os
import base64
import json
import stat
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, cast
from uuid import UUID
from urllib.parse import quote

import pytest

import jobhunter_browser_harness.playwright_cli as playwright_cli
from jobhunter_browser_harness.models import BrowserLaunchConfig
from jobhunter_browser_harness.playwright_cli import (
    BrowserConfigurationError,
    PlaywrightCliRuntime,
    PlaywrightCliRuntimeError,
    ResolvedBrowserLaunch,
    resolve_browser_launch,
    recover_stale_playwright_cli_sessions,
)


class DummyStream:
    def __init__(self, data: bytes) -> None:
        self._data = data

    async def read(self, size: int = -1) -> bytes:
        val = self._data
        self._data = b""
        return val


class DummyProcess:
    def __init__(
        self,
        argv: Sequence[str],
        exit_code: int = 0,
        timed_out: bool = False,
        stdout: bytes = b"",
        stderr: bytes = b"",
        on_wait: Any = None,
    ) -> None:
        if (
            not stdout
            and len(argv) > 3
            and argv[3] == "close"
        ):
            session_name = next(
                value.removeprefix("--session=")
                for value in argv
                if value.startswith("--session=")
            )
            stdout = json.dumps(
                {"session": session_name, "status": "closed"}
            ).encode()
        self.argv = argv
        self.returncode = exit_code
        self._timed_out = timed_out
        self.stdout = DummyStream(stdout)
        self.stderr = DummyStream(stderr)
        self.terminated = False
        self.killed = False
        self._on_wait = on_wait

    async def wait(self) -> int:
        if self._on_wait:
            self._on_wait(self)
        if self._timed_out:
            await asyncio.sleep(100.0)
        return self.returncode or 0

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 124

    def kill(self) -> None:
        self.killed = True
        self.returncode = 137


@pytest.fixture
def cli_script(tmp_path: Path) -> Path:
    script = tmp_path / "playwright-cli.js"
    script.write_text("console.log('mock-cli')", encoding="utf-8")
    return script


@pytest.fixture
def session_dir(tmp_path: Path) -> Path:
    d = tmp_path / "session"
    d.mkdir(mode=0o700)
    return d




def test_private_redaction_fragments_match_pinned_yaml_and_json_escaping() -> None:
    secret = "\\\"\b\f\n\r\t" + chr(1) + chr(0x1F) + chr(0x7F) + chr(0x9F)
    yaml_fragment = (
        "\\\\"
        '\\"'
        "\\b"
        "\\f"
        "\\n"
        "\\r"
        "\\t"
        "\\x01"
        "\\x1f"
        "\\x7f"
        "\\x9f"
    )
    assert playwright_cli._yaml_value_fragment(secret) == yaml_fragment
    fragments = playwright_cli._private_redaction_fragments(
        (secret, "O'Brien{", "雪")
    )
    assert secret in fragments
    assert yaml_fragment in fragments
    assert "O''Brien{" in fragments
    assert "\\u96ea" in fragments
    assert quote("雪", safe="") in fragments

@pytest.mark.asyncio
async def test_private_observation_redacts_before_public_field_limits(
    session_dir: Path,
    cli_script: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    password = "😀" * 4_096
    username = "U" * 320
    mixed_secret = "mixed😀"
    literal_percent_secret = "secret%aFword"
    encoded_password = quote(password, safe="")
    double_encoded_secret = quote(quote("private%value", safe=""), safe="")
    full_url = f"https://example.com/?secret=x{encoded_password}"
    raw_url = full_url[: playwright_cli._MAX_URL_CAPTURE_CHARS]
    raw_title = f"x{password}"
    raw_metadata = {
        "url": raw_url,
        "title": raw_title,
        "currentIndex": 0,
        "tabs": [
            {"url": raw_url, "title": raw_title}
            for _ in range(playwright_cli._MAX_TABS)
        ],
    }
    invocation_payload = json.dumps(
        {"result": json.dumps(raw_metadata)}
    ).encode("utf-8")
    capture_limits: list[int] = []
    scripts: list[str] = []

    async def invoke(
        _command: str,
        args: Sequence[str] = (),
        *,
        capture_limit: int = playwright_cli._MAX_CAPTURE_BYTES,
        **_kwargs: Any,
    ) -> playwright_cli._InvocationResult:
        capture_limits.append(capture_limit)
        scripts.extend(args)
        return playwright_cli._InvocationResult(
            exit_code=0,
            timed_out=False,
            stdout=invocation_payload,
            stderr=b"",
            stdout_truncated=False,
            stderr_truncated=False,
        )

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000099"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
    )
    runtime._activate_private_values_unlocked(
        (
            username,
            password,
            "private%value",
            mixed_secret,
            literal_percent_secret,
        )
    )
    monkeypatch.setattr(runtime, "_invoke", invoke)

    metadata = await runtime._metadata()

    assert capture_limits == [playwright_cli._MAX_OBSERVATION_CAPTURE_BYTES]
    assert capture_limits[0] == 16 * 1024 * 1024
    assert len(invocation_payload) < capture_limits[0]
    assert len(metadata.tabs) == playwright_cli._MAX_TABS
    assert "Array.from(value.slice(0,limit*2))" in scripts[0]
    assert str(playwright_cli._MAX_URL_CAPTURE_CHARS) in scripts[0]
    assert str(playwright_cli._MAX_TITLE_CAPTURE_CHARS) in scripts[0]
    assert playwright_cli._MAX_TITLE_CAPTURE_CHARS == 8_192
    assert metadata.url == raw_url
    assert metadata.tabs[0][0] == raw_url
    assert encoded_password not in metadata.url
    assert metadata.title == "x[redacted]"
    assert metadata.tabs[0][1] == "x[redacted]"

    public_url = runtime._public_redacted_url(metadata.url)
    assert len(public_url) <= playwright_cli._MAX_URL_CHARS
    assert password not in public_url
    assert encoded_password not in public_url
    assert public_url == "https://example.com/[redacted]"
    double_encoded_url = (
        f"https://example.com/?secret={double_encoded_secret}"
    )
    assert runtime._public_redacted_url(double_encoded_url).endswith(
        "secret=[redacted]"
    )

    double_encoded_with_incomplete_suffix = f"{double_encoded_url}%F"
    assert runtime._public_redacted_url(
        double_encoded_with_incomplete_suffix
    ) == "https://example.com/[redacted]"

    for encoded_prefix in ("%", "%F"):
        prefix_url = f"https://example.com/?secret={encoded_prefix}"
        assert runtime._public_redacted_url(prefix_url) == (
            "https://example.com/[redacted]"
        )

    mixed_encoded_secret = quote(mixed_secret, safe="").replace("%F0", "%f0")
    mixed_url = f"https://example.com/?secret={mixed_encoded_secret}"
    assert runtime._public_redacted_url(mixed_url).endswith(
        "secret=[redacted]"
    )
    literal_url = f"https://example.com/?secret={literal_percent_secret}"
    assert runtime._public_redacted_url(literal_url).endswith(
        "secret=[redacted]"
    )

    repeated_title = (
        f"x{password}{password}"
    )[: playwright_cli._MAX_TITLE_CAPTURE_CHARS]
    redacted_repeated_title = runtime._redact_bounded_text(
        repeated_title,
        playwright_cli._MAX_TITLE_CHARS,
    )
    assert password not in redacted_repeated_title
    assert len(redacted_repeated_title) <= playwright_cli._MAX_TITLE_CHARS

    combined_title = (
        f"{'x' * 3_900}{username}{password}"
    )[: playwright_cli._MAX_TITLE_CAPTURE_CHARS]
    redacted_combined_title = runtime._redact_bounded_text(
        combined_title,
        playwright_cli._MAX_TITLE_CHARS,
    )
    assert username not in redacted_combined_title
    assert password not in redacted_combined_title
    assert len(redacted_combined_title) <= playwright_cli._MAX_TITLE_CHARS

    serialized_password = json.dumps(password)[1:-1]
    serialized_dom = (
        f"x{serialized_password}{serialized_password}"
    )[: playwright_cli._MAX_DOM_CAPTURE_CHARS]
    inline = playwright_cli._InvocationResult(
        exit_code=0,
        timed_out=False,
        stdout=json.dumps({"snapshot": serialized_dom}).encode("utf-8"),
        stderr=b"",
        stdout_truncated=False,
        stderr_truncated=False,
    )
    inline_dom = runtime._snapshot_from_execution(inline, remove_file=True)
    assert serialized_password not in inline_dom
    assert "[redacted]" in inline_dom
    assert len(inline_dom) <= playwright_cli._MAX_DOM_CHARS

    artifact_path = runtime._internal_directory / "boundary.yml"
    artifact_path.write_text(serialized_dom, encoding="utf-8")
    file_dom = runtime._read_text_artifact(
        artifact_path,
        playwright_cli._MAX_DOM_CHARS,
    )
    assert serialized_password not in file_dom
    assert "[redacted]" in file_dom
    assert len(file_dom) <= playwright_cli._MAX_DOM_CHARS

    invalid_utf8_path = runtime._internal_directory / "invalid-utf8.yml"
    invalid_utf8_path.write_bytes(
        b"x" * (playwright_cli._MAX_DOM_CAPTURE_CHARS * 4) + b"\xf0\x9f"
    )
    assert (
        runtime._read_text_artifact(
            invalid_utf8_path,
            playwright_cli._MAX_DOM_CHARS,
        )
        == ""
    )

    many_private_values = tuple(
        f"{index:03d}{'x' * 4_093}" for index in range(64)
    )
    started = time.monotonic()
    runtime._activate_private_values_unlocked(many_private_values)
    for _ in range(100):
        assert runtime._redact_bounded_text("public", 4_096) == "public"
    assert time.monotonic() - started < 2
    assert not hasattr(runtime, "_private_redaction_prefixes")

    await runtime.close()


def test_resolve_browser_launch_cdp() -> None:
    config = BrowserLaunchConfig(cdp_url="http://127.0.0.1:9222")
    launch = resolve_browser_launch(config)
    assert launch.is_cdp
    assert launch.cdp_url == "http://127.0.0.1:9222"
    assert launch.executable_path is None
    assert launch.user_data_dir is None


def test_resolve_browser_launch_cdp_invalid() -> None:
    config = BrowserLaunchConfig.model_construct(cdp_url="http://google.com/path")
    with pytest.raises(BrowserConfigurationError):
        resolve_browser_launch(config)


def test_resolve_browser_launch_native_success(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    chrome = tmp_path / "chrome"
    chrome.write_text("executable", encoding="utf-8")
    chrome.chmod(0o755)
    profile = tmp_path / "profile"

    # Mock default profile roots to not conflict with the test profile path
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._default_profile_roots",
        lambda: (Path("/different/root"),),
    )

    config = BrowserLaunchConfig(
        chrome_executable=chrome,
        chrome_user_data_dir=profile,
    )
    launch = resolve_browser_launch(config)
    assert not launch.is_cdp
    assert launch.executable_path == chrome.resolve()
    assert launch.user_data_dir == profile.resolve()
    assert profile.exists()
    assert stat.S_IMODE(profile.stat().st_mode) == 0o700


def test_resolve_browser_launch_native_symlink_rejection(tmp_path: Path) -> None:
    chrome = tmp_path / "chrome"
    chrome.write_text("executable", encoding="utf-8")
    chrome.chmod(0o755)
    profile = tmp_path / "profile"
    profile.mkdir(mode=0o700)

    symlink_dir = tmp_path / "profile-symlink"
    symlink_dir.symlink_to(profile, target_is_directory=True)

    config = BrowserLaunchConfig(
        chrome_executable=chrome,
        chrome_user_data_dir=symlink_dir,
    )
    with pytest.raises(BrowserConfigurationError, match="must not be a symbolic link"):
        resolve_browser_launch(config)


def test_resolve_browser_launch_default_root_rejection(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    chrome = tmp_path / "chrome"
    chrome.write_text("executable", encoding="utf-8")
    chrome.chmod(0o755)
    profile = tmp_path / "profile"

    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._default_profile_roots",
        lambda: (profile,),
    )

    config = BrowserLaunchConfig(
        chrome_executable=chrome,
        chrome_user_data_dir=profile,
    )
    with pytest.raises(BrowserConfigurationError, match="separate from the operating-system default profile"):
        resolve_browser_launch(config)


def test_resolve_browser_launch_missing_executable(tmp_path: Path) -> None:
    config = BrowserLaunchConfig(
        chrome_executable=tmp_path / "missing-chrome",
        chrome_user_data_dir=tmp_path / "profile",
    )
    with pytest.raises(BrowserConfigurationError, match="executable is unavailable"):
        resolve_browser_launch(config)


def test_runtime_init_validation(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)
    with pytest.raises(BrowserConfigurationError):
        PlaywrightCliRuntime(
            session_id=cast(Any, "not-a-uuid"),
            launch=launch,
            session_directory=session_dir,
            deadline=time.time() + 100,
            cli_script=cli_script,
        )


@pytest.mark.asyncio
async def test_runtime_start_lifecycle_argv(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    spawns: list[list[str]] = []

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        spawns.append(list(argv))
        cmd = argv[3]
        stdout = b""
        if cmd == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
    )

    await runtime.start("https://example.com/jobs/1")

    # Commands invoked: open about:blank, run-code (install guard), video-start, goto, run-code (metadata check)
    assert len(spawns) == 5
    assert spawns[0][3] == "open"
    assert spawns[0][4] == "about:blank"
    assert spawns[1][3] == "run-code"  # navigation guard
    assert spawns[2][3] == "video-start"
    assert spawns[3][3] == "goto"
    assert spawns[3][4] == "https://example.com/jobs/1"
    assert spawns[4][3] == "run-code"  # metadata

    await runtime.close()


@pytest.mark.asyncio
async def test_start_preserves_original_timeout_when_immediate_cleanup_fails(
    session_dir: Path,
    cli_script: Path,
) -> None:
    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000011"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
    )

    async def timeout(*_args: Any, **_kwargs: Any) -> Any:
        raise PlaywrightCliRuntimeError("session_timeout")

    async def failed_cleanup() -> None:
        raise PlaywrightCliRuntimeError("browser_failed")

    runtime._invoke = timeout  # type: ignore[method-assign]
    runtime._cleanup_unlocked = failed_cleanup  # type: ignore[method-assign]

    with pytest.raises(PlaywrightCliRuntimeError) as caught:
        await runtime.start("https://example.com/jobs/1")

    assert caught.value.code == "session_timeout"
    playwright_cli._remove_owned_temporary_directory(
        runtime._temporary_directory,
        runtime._session_id,
    )
    runtime._ownership_path.unlink()

@pytest.mark.asyncio
async def test_runtime_execute_safe_command(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    spawns: list[list[str]] = []

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        spawns.append(list(argv))
        cmd = argv[3]
        stdout = b""
        if cmd == "run-code":
            metadata: dict[str, object] = {
                "url": "https://example.com/jobs/1",
                "title": "Software Engineer",
                "currentIndex": 0,
                "tabs": [
                    {
                        "url": "https://example.com/jobs/1",
                        "title": "Software Engineer",
                    }
                ],
            }
            script = argv[4]
            marker = "const screenshotPath="
            if marker in script:
                encoded_path = script.split(marker, 1)[1].split(";", 1)[0]
                Path(json.loads(encoded_path)).write_bytes(
                    b"\x89PNG\r\n\x1a\npngdata"
                )
                metadata["screenshot"] = True
            stdout = json.dumps({"result": json.dumps(metadata)}).encode("utf-8")
        elif cmd == "click":
            snapshot_path = (
                session_dir / "playwright-cli" / "output" / "automatic.yml"
            )
            snapshot_path.write_text("page-dom", encoding="utf-8")
            stdout = json.dumps(
                {
                    "snapshot": {
                        "file": str(snapshot_path.relative_to(session_dir))
                    }
                }
            ).encode()
        elif cmd == "snapshot":
            filename = argv[4].split("=")[1]
            Path(filename).write_text("page-dom", encoding="utf-8")
        elif cmd == "screenshot":
            filename = argv[4].split("=")[1]
            Path(filename).write_bytes(b"\x89PNG\r\n\x1a\npngdata")
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
    )

    await runtime.start("https://example.com/jobs/1")

    # Clear spawns log to focus on execute
    spawns.clear()

    result = await runtime.execute("click", ["e3"])

    assert result.exit_code == 0
    assert result.timed_out is False
    assert result.observation.url == "https://example.com/jobs/1"
    assert result.observation.title == "Software Engineer"
    assert result.observation.dom == "page-dom"
    assert result.observation.screenshot is not None
    assert base64.b64decode(result.observation.screenshot.data) == b"\x89PNG\r\n\x1a\npngdata"

    # The action's automatic snapshot supplies the DOM. One internal command
    # collects the bounded metadata and screenshot.
    assert len(spawns) == 2
    assert spawns[0][3] == "click"
    assert spawns[0][4] == "e3"
    assert spawns[1][3] == "run-code"

    await runtime.close()


@pytest.mark.asyncio
async def test_runtime_returns_cached_observation_while_file_chooser_is_open(
    session_dir: Path,
    cli_script: Path,
) -> None:
    modal = False
    commands: list[str] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        nonlocal modal
        command = argv[3]
        commands.append(command)
        if command == "click":
            modal = True
            snapshot_path = (
                session_dir / "playwright-cli" / "output" / "file-chooser.yml"
            )
            snapshot_path.write_text("file chooser open", encoding="utf-8")
            stdout = json.dumps(
                {
                    "snapshot": {
                        "file": str(snapshot_path.relative_to(session_dir))
                    }
                }
            ).encode()
        elif command == "run-code" and modal:
            stdout = json.dumps(
                {
                    "isError": True,
                    "error": (
                        'Error: Tool "browser_run_code_unsafe" '
                        "does not handle the modal state."
                    ),
                }
            ).encode()
        elif command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Software Engineer",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Software Engineer",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        else:
            stdout = b""
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000006"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/jobs/1")
    commands.clear()

    result = await runtime.execute("click", ["e3"])

    assert result.observation.url == "https://example.com/jobs/1"
    assert result.observation.dom == "file chooser open"
    assert result.observation.screenshot is None
    assert commands == ["click", "run-code"]

    await runtime.close()

@pytest.mark.asyncio
async def test_runtime_execute_unsupported_command(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/jobs/1")

    with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
        await runtime.execute("open", ["https://example.com"])

    with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
        await runtime.execute("cookie-set", ["foo", "bar"])

    await runtime.close()

@pytest.mark.asyncio
async def test_runtime_execute_session_override_rejection(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/jobs/1")

    with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
        await runtime.execute("click", ["e5", "--session=other"])

    with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
        await runtime.execute("click", ["e5", "--json"])

    await runtime.close()


async def test_runtime_execute_upload_path_confinement(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/jobs/1")

    # Creating a file outside the session directory
    outside_file = session_dir.parent / "outside.txt"
    outside_file.write_text("data", encoding="utf-8")

    # Rejects uploads outside session dir
    with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
        await runtime.execute("upload", [str(outside_file)])
    with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
        await runtime.execute(
            "upload",
            [str(session_dir / "playwright-cli" / "cli.config.json")],
        )

    # Accepts inside
    inside_file = session_dir / "inside.txt"
    inside_file.write_text("data", encoding="utf-8")
    # Should resolve successfully (this is a valid command so it runs subprocess)
    res = await runtime.execute("upload", [str(inside_file)])
    assert res.exit_code == 0

    await runtime.close()


@pytest.mark.asyncio
async def test_runtime_execute_exact_origin_direct_navigation(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/jobs/1")

    # Rejects navigation to non-approved origin
    with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
        await runtime.execute("goto", ["https://google.com"])

    # Rejects tab-new to non-approved origin
    with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
        await runtime.execute("tab-new", ["https://google.com"])

    for internal_url in (
        "chrome://settings",
        "devtools://devtools/bundled/inspector.html",
        "edge://settings",
    ):
        with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
            await runtime.execute("goto", [internal_url])

    escaped = False
    redirected_commands: list[str] = []

    def mock_process_factory_redirect(
        *argv: str,
        **_kwargs: Any,
    ) -> DummyProcess:
        nonlocal escaped
        command = argv[3]
        redirected_commands.append(command)
        stdout = b""
        if command == "click":
            escaped = True
            snapshot_path = (
                session_dir / "playwright-cli" / "output" / "redirect.yml"
            )
            snapshot_path.write_text("blocked page", encoding="utf-8")
            stdout = json.dumps(
                {
                    "snapshot": {
                        "file": str(snapshot_path.relative_to(session_dir))
                    }
                }
            ).encode()
        elif command == "goto" and escaped:
            assert argv[4] == "https://example.com/jobs/1"
            escaped = False
        elif command == "run-code":
            url = (
                "chrome-error://chromewebdata/"
                if escaped
                else "https://example.com/jobs/1"
            )
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": url,
                            "title": "Blocked" if escaped else "Software Engineer",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": url,
                                    "title": (
                                        "Blocked"
                                        if escaped
                                        else "Software Engineer"
                                    ),
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv=argv, stdout=stdout)

    runtime._process_factory = mock_process_factory_redirect

    result = await runtime.execute("click", ["e3"])

    assert result.exit_code == 2
    assert result.stderr == "[redacted]"
    assert result.observation.url == "https://example.com/jobs/1"
    assert redirected_commands[:6] == [
        "click",
        "run-code",
        "tab-select",
        "goto",
        "run-code",
        "snapshot",
    ]

    await runtime.close()


@pytest.mark.asyncio
async def test_private_restore_keeps_secret_url_out_of_argv_and_memfd_on_disk(
    session_dir: Path,
    cli_script: Path,
) -> None:
    password = "private-restore-password"
    previous_url = f"https://example.com/account?token={password}"
    invocations: list[list[str]] = []
    restore_scripts: list[str] = []
    restore_paths: list[Path] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        invocations.append(list(argv))
        if argv[3] == "run-code":
            filename = next(
                value.split("=", 1)[1]
                for value in argv[4:]
                if value.startswith("--filename=")
            )
            restore_path = Path(filename)
            restore_paths.append(restore_path)
            restore_scripts.append(restore_path.read_text(encoding="utf-8"))
        return DummyProcess(argv, stdout=b"{}")

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000098"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=factory,
        cli_script=cli_script,
    )
    runtime._approved_origins = ("https://example.com",)
    runtime._activate_private_values_unlocked((password,))
    previous = playwright_cli._PageMetadata(
        url=previous_url,
        title="Account",
        current_index=0,
        tabs=((previous_url, "Account"),),
    )
    current = playwright_cli._PageMetadata(
        url="chrome-error://chromewebdata/",
        title="Blocked",
        current_index=0,
        tabs=(("chrome-error://chromewebdata/", "Blocked"),),
    )

    await runtime._restore_allowed_page(previous, current)

    assert [invocation[3] for invocation in invocations] == [
        "tab-select",
        "run-code",
    ]
    assert all(
        password not in argument
        for invocation in invocations
        for argument in invocation
    )
    assert len(restore_scripts) == 1
    assert json.dumps(previous_url) in restore_scripts[0]
    assert len(restore_paths) == 1
    assert not restore_paths[0].exists()
    assert not list(runtime._internal_directory.glob(".restore-*.js"))
    guard_script = runtime._guard_script(("https://example.com",))
    assert "url==='about:blank'" in guard_script
    assert "url.startsWith('about:')" not in guard_script
    assert "chrome:" not in guard_script

    await runtime.close()


@pytest.mark.asyncio
async def test_save_origin_verification_redacts_cached_modal_fallback_metadata(
    session_dir: Path,
    cli_script: Path,
) -> None:
    username = "modal-user@example.test"
    password = "modal-private-password"
    metadata_title = "Login"
    modal_observation = False

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        stdout = b""
        if command == "run-code":
            script = argv[4]
            if modal_observation and "const allPages=" in script:
                stdout = json.dumps(
                    {
                        "isError": True,
                        "error": (
                            "Synthetic command does not handle the modal state."
                        ),
                    }
                ).encode()
            elif "const pages=" in script:
                stdout = json.dumps(
                    {
                        "result": json.dumps(
                            {
                                "url": "https://example.com/login",
                                "title": metadata_title,
                                "currentIndex": 0,
                                "tabs": [
                                    {
                                        "url": "https://example.com/login",
                                        "title": metadata_title,
                                    }
                                ],
                            }
                        )
                    }
                ).encode()
            else:
                stdout = b"{}"
        elif command == "snapshot":
            stdout = json.dumps({"snapshot": "modal login"}).encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000097"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/login")
    await runtime.suppress_private_capture()
    metadata_title = f"{'x' * 4_080}{username}{password}"

    verified = await runtime.verify_origin_and_activate_private_values(
        "https://example.com",
        (username, password),
    )
    modal_observation = True
    result = await runtime.execute("click", ["e1"])

    assert verified == "https://example.com"
    dumped = result.model_dump_json()
    assert username not in dumped
    assert password not in dumped
    assert len(result.observation.title) <= 4_096
    assert result.observation.title == f"{'x' * 4_080}[redacted]"
    assert result.observation.tabs[0].title == (
        f"{'x' * 4_080}[redacted]"
    )

    await runtime.close()


@pytest.mark.asyncio
async def test_runtime_rejects_tab_creation_at_observation_limit(
    session_dir: Path,
    cli_script: Path,
) -> None:
    commands: list[str] = []
    tabs = [
        {
            "url": f"https://example.com/jobs/{index}",
            "title": f"Job {index}",
        }
        for index in range(100)
    ]

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        commands.append(command)
        stdout = b""
        if command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/0",
                            "title": "Job 0",
                            "currentIndex": 0,
                            "tabs": tabs,
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000008"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/0")
    commands.clear()

    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("tab-new", ["https://example.com/jobs/new"])
    assert commands == []

    await runtime.close()


@pytest.mark.asyncio
async def test_runtime_metadata_transport_covers_declared_tab_bounds(
    session_dir: Path,
    cli_script: Path,
) -> None:
    long_value = "x" * 4_096
    tabs = [
        {
            "url": f"https://example.com/{index}?value={long_value}",
            "title": long_value,
        }
        for index in range(100)
    ]

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/0",
                            "title": long_value,
                            "currentIndex": 0,
                            "tabs": tabs,
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000009"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )

    await runtime.start("https://example.com/0")

    assert runtime._current_metadata is not None
    assert len(runtime._current_metadata.tabs) == 100
    internal_url = runtime._current_metadata.tabs[-1][0]
    assert internal_url == tabs[-1]["url"]
    assert len(internal_url) <= playwright_cli._MAX_URL_CAPTURE_CHARS
    assert len(runtime._public_redacted_url(internal_url)) == 4_096
    assert len(runtime._current_metadata.tabs[-1][1]) == 4_096

    await runtime.close()

@pytest.mark.asyncio
async def test_runtime_execute_timeout_and_output_bounds(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        cmd = argv[3]
        stdout = b""
        if cmd == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
            return DummyProcess(argv=argv, stdout=stdout)
        elif cmd == "click":
            # Simulate a long execution that times out
            return DummyProcess(argv=argv, timed_out=True)
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
        execution_timeout=0.1,  # Short timeout for testing
    )
    await runtime.start("https://example.com/jobs/1")

    res = await runtime.execute("click", ["e3"])
    assert res.timed_out
    assert res.exit_code == 124

    # Test output truncation
    def mock_process_factory_truncated(*argv: str, **kwargs: Any) -> DummyProcess:
        cmd = argv[3]
        stdout = b""
        if cmd == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
            return DummyProcess(argv=argv, stdout=stdout)
        elif cmd == "click":
            # Output excessive stdout
            return DummyProcess(argv=argv, stdout=b"A" * 30_000, stderr=b"B" * 30_000)
        return DummyProcess(argv=argv, stdout=stdout)

    runtime._process_factory = mock_process_factory_truncated
    runtime._execution_timeout = 5.0
    res_trunc = await runtime.execute("click", ["e3"])
    assert len(res_trunc.stdout) == 20_000
    assert len(res_trunc.stderr) == 20_000
    assert res_trunc.stdout_truncated
    assert res_trunc.stderr_truncated

    await runtime.close()

@pytest.mark.asyncio
async def test_runtime_origin_updates(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    spawns: list[list[str]] = []

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        spawns.append(list(argv))
        cmd = argv[3]
        stdout = b""
        if cmd == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/jobs/1")

    spawns.clear()
    await runtime.set_approved_origins(["https://example.com", "https://another.com"])

    # set_approved_origins re-installs guard script (runs run-code)
    assert len(spawns) == 1
    assert spawns[0][3] == "run-code"
    assert "another.com" in spawns[0][4]

    # Verification that the approved origins check now allows navigation to another.com
    spawns.clear()
    res = await runtime.execute("goto", ["https://another.com/jobs"])
    assert res.exit_code == 0

    await runtime.close()

@pytest.mark.asyncio
async def test_runtime_suspend_navigation_guard(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    spawns: list[list[str]] = []

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        spawns.append(list(argv))
        cmd = argv[3]
        stdout = b""
        if cmd == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/jobs/1")

    spawns.clear()
    await runtime.suspend_navigation_guard()

    # suspend_navigation_guard runs unroute script (run-code)
    assert len(spawns) == 1
    assert spawns[0][3] == "run-code"
    assert "unroute" in spawns[0][4]

    # Verify that model execution is disabled while navigation guard is suspended
    with pytest.raises(PlaywrightCliRuntimeError, match="browser_failed"):
        await runtime.execute("click", ["e3"])

    await runtime.close()

@pytest.mark.asyncio
async def test_runtime_idempotent_cleanup(session_dir: Path, cli_script: Path) -> None:
    launch = ResolvedBrowserLaunch(cdp_url="http://127.0.0.1:9222", executable_path=None, user_data_dir=None)

    spawns: list[list[str]] = []

    def mock_process_factory(*argv: str, **kwargs: Any) -> DummyProcess:
        spawns.append(list(argv))
        cmd = argv[3]
        stdout = b""
        if cmd == "run-code":
            stdout = json.dumps({
                "result": json.dumps({
                    "url": "https://example.com/jobs/1",
                    "title": "Software Engineer",
                    "currentIndex": 0,
                    "tabs": [{"url": "https://example.com/jobs/1", "title": "Software Engineer"}],
                })
            }).encode("utf-8")
        return DummyProcess(argv=argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000001"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=mock_process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/jobs/1")

    spawns.clear()
    await runtime.close()

    # Should call video-stop and close
    assert len(spawns) == 2
    assert spawns[0][3] == "video-stop"
    assert spawns[1][3] == "close"

    # Subsequent close should be a no-op
    spawns.clear()
    await runtime.close()
    assert len(spawns) == 0


@pytest.mark.asyncio
async def test_runtime_uses_short_private_temporary_directory(
    tmp_path: Path,
    cli_script: Path,
) -> None:
    session_dir = tmp_path
    for segment in (
        "deeply-nested-session-root",
        "browser-artifact-directory",
        "caller-session-identifier",
        "runtime-storage",
    ):
        session_dir /= segment
    session_dir.mkdir(parents=True, mode=0o700)
    environments: list[dict[str, str]] = []

    def factory(*argv: str, **kwargs: Any) -> DummyProcess:
        environments.append(cast(dict[str, str], kwargs["env"]))
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000005"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")

    temporary_directory = Path(environments[0]["TMPDIR"])
    chrome_socket = (
        temporary_directory / "com.google.Chrome.XXXXXX" / "SingletonSocket"
    )
    assert len(os.fsencode(chrome_socket)) < 108
    assert stat.S_IMODE(temporary_directory.stat().st_mode) == 0o700
    assert not temporary_directory.is_relative_to(session_dir)

    await runtime.close()

    assert not temporary_directory.exists()


def test_temporary_directory_cleanup_rejects_a_dangling_symlink() -> None:
    session_id = UUID("00000000-0000-0000-0000-000000000012")
    temporary_directory = playwright_cli._create_private_temporary_directory(
        session_id
    )
    temporary_directory.rmdir()
    missing_target = temporary_directory.with_name(
        f"{temporary_directory.name}-missing"
    )
    temporary_directory.symlink_to(missing_target, target_is_directory=True)
    try:
        with pytest.raises(BrowserConfigurationError):
            playwright_cli._remove_owned_temporary_directory(
                temporary_directory,
                session_id,
            )
    finally:
        temporary_directory.unlink(missing_ok=True)


def test_artifact_budget_ignores_unfollowed_temporary_symlinks(
    tmp_path: Path,
) -> None:
    root = tmp_path / "temporary"
    root.mkdir()
    (root / "SingletonSocket").symlink_to(root / "missing-socket")

    assert not PlaywrightCliRuntime._directory_size_exceeds(root, 1)


def test_native_browser_identity_requires_actual_root_argument(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    actual_executable = tmp_path / "chrome-bin"
    actual_executable.write_text("binary", encoding="utf-8")

    class FakeProcess:
        pid = 7101

        def __init__(self, arguments: list[str]) -> None:
            self._arguments = arguments

        def create_time(self) -> float:
            return 345.6

        def status(self) -> str:
            return "sleeping"

        def cmdline(self) -> list[str]:
            return self._arguments

        def exe(self) -> str:
            return str(actual_executable)

    monkeypatch.setattr(
        playwright_cli,
        "_same_process_owner",
        lambda _process: True,
    )
    exact_argument = f"--user-data-dir={profile.resolve()}"

    identity = playwright_cli._native_browser_process_identity(
        FakeProcess([str(actual_executable), exact_argument]),  # type: ignore[arg-type]
        profile.resolve(),
    )

    assert identity == (7101, 345.6, actual_executable.resolve())
    assert (
        playwright_cli._native_browser_process_identity(
            FakeProcess(  # type: ignore[arg-type]
                [str(actual_executable), "--user-data-dir", str(profile.resolve())]
            ),
            profile.resolve(),
        )
        is None
    )
    assert (
        playwright_cli._native_browser_process_identity(
            FakeProcess(  # type: ignore[arg-type]
                [str(actual_executable), exact_argument, "--type=renderer"]
            ),
            profile.resolve(),
        )
        is None
    )


def test_journaled_native_browser_identity_fails_closed_on_reuse_or_ambiguity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    executable = tmp_path / "chrome"
    executable.write_text("binary", encoding="utf-8")
    resolved_executable = executable.resolve()
    resolved_profile = profile.resolve()

    monkeypatch.setattr(
        playwright_cli,
        "_native_browser_processes_for_profile",
        lambda _profile: (
            (7101, 345.6, resolved_executable),
            (7102, 456.7, resolved_executable),
        ),
    )
    with pytest.raises(BrowserConfigurationError, match="ambiguous"):
        playwright_cli._matching_native_browser_processes(
            resolved_executable,
            resolved_profile,
            7101,
            345.6,
        )

    monkeypatch.setattr(
        playwright_cli,
        "_native_browser_processes_for_profile",
        lambda _profile: ((7101, 456.7, resolved_executable),),
    )
    with pytest.raises(BrowserConfigurationError, match="changed"):
        playwright_cli._matching_native_browser_processes(
            resolved_executable,
            resolved_profile,
            7101,
            345.6,
        )


@pytest.mark.asyncio
async def test_unjournaled_native_profile_owner_is_never_signaled(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    launcher = tmp_path / "chrome-launcher"
    launcher.write_text("launcher", encoding="utf-8")
    actual_executable = tmp_path / "chrome"
    actual_executable.write_text("binary", encoding="utf-8")
    terminated: list[int] = []
    monkeypatch.setattr(
        playwright_cli,
        "_native_browser_processes_for_profile",
        lambda _profile: ((7201, 567.8, actual_executable.resolve()),),
    )

    async def terminate(
        pid: int,
        _create_time: float,
        _executable_path: Path,
        _user_data_dir: Path,
    ) -> None:
        terminated.append(pid)

    monkeypatch.setattr(
        playwright_cli,
        "_terminate_owned_native_browser",
        terminate,
    )

    with pytest.raises(BrowserConfigurationError):
        await playwright_cli._reclaim_native_browser(
            playwright_cli._NativeBrowserOwnership(
                launcher=launcher.resolve(),
                user_data_dir=profile.resolve(),
            )
        )

    assert terminated == []


def test_daemon_scan_failure_retains_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def failed_process_scan() -> Any:
        raise playwright_cli.psutil.AccessDenied()

    monkeypatch.setattr(
        playwright_cli.psutil,
        "process_iter",
        failed_process_scan,
    )

    with pytest.raises(BrowserConfigurationError):
        playwright_cli._matching_cli_daemon_pids("jobhunter-session", None)


def test_daemon_inspection_failure_retains_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class InaccessibleOwnedProcess:
        pid = 7301

        def uids(self) -> Any:
            return type("Uids", (), {"real": os.getuid()})()

        def cmdline(self) -> list[str]:
            raise playwright_cli.psutil.AccessDenied(self.pid)

    process = InaccessibleOwnedProcess()
    monkeypatch.setattr(
        playwright_cli.psutil,
        "process_iter",
        lambda: (process,),
    )
    monkeypatch.setattr(
        playwright_cli.psutil,
        "Process",
        lambda _pid=None: process,
    )

    with pytest.raises(BrowserConfigurationError):
        playwright_cli._matching_cli_daemon_pids("jobhunter-session", 7301)


@pytest.mark.parametrize(
    "inaccessible_operation",
    ("owner", "create_time", "status", "cmdline", "executable"),
)
def test_native_browser_inspection_failure_retains_ownership(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    inaccessible_operation: str,
) -> None:
    profile = tmp_path / "profile"
    profile.mkdir()
    executable = tmp_path / "chrome"
    executable.write_text("binary", encoding="utf-8")

    class InaccessibleNativeProcess:
        pid = 7401

        def _result(self, operation: str, value: Any) -> Any:
            if inaccessible_operation == operation:
                raise playwright_cli.psutil.AccessDenied(self.pid)
            return value

        def uids(self) -> Any:
            return self._result(
                "owner",
                type("Uids", (), {"real": os.getuid()})(),
            )

        def create_time(self) -> float:
            return self._result("create_time", 678.9)

        def status(self) -> str:
            return self._result("status", "sleeping")

        def cmdline(self) -> list[str]:
            return self._result(
                "cmdline",
                [str(executable), f"--user-data-dir={profile.resolve()}"],
            )

        def exe(self) -> str:
            return self._result("executable", str(executable))

    monkeypatch.setattr(
        playwright_cli.psutil,
        "process_iter",
        lambda: (InaccessibleNativeProcess(),),
    )

    with pytest.raises(BrowserConfigurationError):
        playwright_cli._native_browser_processes_for_profile(profile.resolve())


def test_resolve_browser_launch_rejects_non_loopback_cdp() -> None:
    config = BrowserLaunchConfig.model_construct(cdp_url="http://example.com:9222")

    with pytest.raises(BrowserConfigurationError, match="loopback HTTP origin"):
        resolve_browser_launch(config)


def test_resolve_browser_launch_auto_detects_chrome(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chrome = tmp_path / "chrome"
    chrome.write_text("#!/bin/sh\n", encoding="utf-8")
    chrome.chmod(0o700)
    profile = tmp_path / "profile"
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._is_wsl",
        lambda: False,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._find_chrome_executable",
        lambda: chrome,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._default_profile_roots",
        lambda: (),
    )

    resolved = resolve_browser_launch(
        BrowserLaunchConfig(chrome_user_data_dir=profile)
    )

    assert resolved.executable_path == chrome.resolve()
    assert resolved.user_data_dir == profile.resolve()
    assert stat.S_IMODE(profile.stat().st_mode) == 0o700


def test_resolve_browser_launch_requires_cdp_for_wsl(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._is_wsl",
        lambda: True,
    )

    with pytest.raises(BrowserConfigurationError, match="not auto-discovered in WSL"):
        resolve_browser_launch(
            BrowserLaunchConfig(chrome_user_data_dir=tmp_path / "profile")
        )


def test_resolve_browser_launch_rejects_non_directory_profile(
    tmp_path: Path,
) -> None:
    chrome = tmp_path / "chrome"
    chrome.write_text("#!/bin/sh\n", encoding="utf-8")
    chrome.chmod(0o700)
    profile = tmp_path / "profile"
    profile.write_text("not a directory", encoding="utf-8")

    with pytest.raises(BrowserConfigurationError):
        resolve_browser_launch(
            BrowserLaunchConfig(
                chrome_executable=chrome,
                chrome_user_data_dir=profile,
            )
        )


@pytest.mark.asyncio
async def test_native_lifecycle_journals_and_reclaims_owned_browser(
    session_dir: Path,
    cli_script: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chrome = tmp_path / "chrome"
    chrome.write_text("#!/bin/sh\n", encoding="utf-8")
    chrome.chmod(0o700)
    profile = tmp_path / "profile"
    profile.mkdir(mode=0o700)
    resolved_chrome = chrome.resolve()
    resolved_profile = profile.resolve()
    launch = ResolvedBrowserLaunch(
        cdp_url=None,
        executable_path=resolved_chrome,
        user_data_dir=resolved_profile,
    )
    spawns: list[list[str]] = []
    browser_running = True
    terminated: list[tuple[int, float]] = []

    def discover_owned_native_browser(
        daemon_pid: int,
        session_name: str,
        user_data_dir: Path,
    ) -> tuple[int, float, Path]:
        assert daemon_pid == 4141
        assert session_name == "jobhunter-00000000000000000000000000000002"
        assert user_data_dir == resolved_profile
        return 5151, 123.5, resolved_chrome

    def matching_native_browser_processes(
        executable_path: Path,
        user_data_dir: Path,
        recorded_pid: int,
        recorded_create_time: float,
    ) -> tuple[tuple[int, float], ...]:
        assert executable_path == resolved_chrome
        assert user_data_dir == resolved_profile
        assert recorded_pid == 5151
        assert recorded_create_time == 123.5
        return ((5151, 123.5),) if browser_running else ()

    async def terminate_owned_native_browser(
        pid: int,
        create_time: float,
        executable_path: Path,
        user_data_dir: Path,
    ) -> None:
        nonlocal browser_running
        assert executable_path == resolved_chrome
        assert user_data_dir == resolved_profile
        terminated.append((pid, create_time))
        browser_running = False

    monkeypatch.setattr(
        playwright_cli,
        "_discover_owned_native_browser",
        discover_owned_native_browser,
        raising=False,
    )
    monkeypatch.setattr(
        playwright_cli,
        "_matching_native_browser_processes",
        matching_native_browser_processes,
        raising=False,
    )
    monkeypatch.setattr(
        playwright_cli,
        "_terminate_owned_native_browser",
        terminate_owned_native_browser,
        raising=False,
    )

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        spawns.append(list(argv))
        stdout = b""
        if argv[3] == "open":
            stdout = json.dumps({"pid": 4141}).encode()
        elif argv[3] == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000002"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")

    open_argv = spawns[0]
    assert f"--profile={resolved_profile}" in open_argv
    config_argument = next(value for value in open_argv if value.startswith("--config="))
    config = json.loads(
        Path(config_argument.removeprefix("--config=")).read_text(encoding="utf-8")
    )
    assert config["browser"]["launchOptions"] == {
        "headless": False,
        "executablePath": str(resolved_chrome),
        "args": [
            "--disable-window-activation",
            "--disable-focus-on-load",
        ],
        "chromiumSandbox": True,
    }
    assert config["browser"]["userDataDir"] == str(resolved_profile)
    ownership = json.loads(runtime._ownership_path.read_text(encoding="utf-8"))
    assert ownership["native_browser_pid"] == 5151
    assert ownership["native_browser_create_time"] == 123.5
    assert ownership["native_launcher"] == str(resolved_chrome)
    assert ownership["native_executable"] == str(resolved_chrome)
    assert ownership["native_user_data_dir"] == str(resolved_profile)

    await runtime.close()

    assert terminated == [(5151, 123.5)]


@pytest.mark.asyncio
async def test_model_paths_limits_redaction_and_unapproved_tab_are_guarded(
    session_dir: Path,
    cli_script: Path,
) -> None:
    launch = ResolvedBrowserLaunch(
        cdp_url="http://127.0.0.1:9222",
        executable_path=None,
        user_data_dir=None,
    )
    outside_snapshot = session_dir.parent / "outside-snapshot.yml"
    outside_snapshot.write_text("must remain", encoding="utf-8")

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                },
                                {
                                    "url": "https://unapproved.example/login",
                                    "title": "Human login",
                                },
                            ],
                        }
                    )
                }
            ).encode()
        elif argv[3] == "click":
            stdout = json.dumps(
                {"snapshot": {"file": str(outside_snapshot)}}
            ).encode()
        elif argv[3] == "eval":
            stdout = f"path={session_dir}".encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000003"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")

    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("tab-select", ["1"])
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("tab-close", [])
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("screenshot", ["--filename=../../../outside.png"])
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("snapshot", ["--filename=../../../outside.yml"])
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute(
            "eval",
            ["() => document.title", "--filename=../../../outside.txt"],
        )
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("pdf", ["--filename=../../../outside.pdf"])
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute(
            "screenshot",
            [f"--filename={runtime._video_path}"],
        )
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("click", ["x" * 8_193])
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("click", ["\ud800"])
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("click", ["-sother-session"])
    await runtime.execute("click", ["e1"])
    assert outside_snapshot.read_text(encoding="utf-8") == "must remain"

    result = await runtime.execute("eval", ["document.title"])
    assert str(session_dir) not in result.stdout
    assert "[redacted]" in result.stdout

    await runtime.close()


@pytest.mark.asyncio
async def test_close_retries_browser_ownership_after_failed_cli_close(
    session_dir: Path,
    cli_script: Path,
) -> None:
    launch = ResolvedBrowserLaunch(
        cdp_url="http://127.0.0.1:9222",
        executable_path=None,
        user_data_dir=None,
    )
    close_calls = 0
    commands: list[str] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        nonlocal close_calls
        command = argv[3]
        commands.append(command)
        stdout = b""
        exit_code = 0
        if command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        elif command == "close":
            close_calls += 1
            exit_code = 1 if close_calls == 1 else 0
        return DummyProcess(argv, exit_code=exit_code, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000004"),
        launch=launch,
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")
    commands.clear()

    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.close()
    assert commands == ["video-stop", "close"]

    commands.clear()
    await runtime.close()
    assert commands == ["close"]

    commands.clear()
    await runtime.close()
    assert commands == []


@pytest.mark.asyncio
async def test_close_reports_video_stop_failure_after_browser_close(
    session_dir: Path,
    cli_script: Path,
) -> None:
    commands: list[str] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        commands.append(command)
        stdout = b""
        exit_code = 1 if command == "video-stop" else 0
        if command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, exit_code=exit_code, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000007"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")
    commands.clear()

    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.close()
    assert commands == ["video-stop", "close"]

    commands.clear()
    await runtime.close()
    assert commands == []


@pytest.mark.asyncio
async def test_open_timeout_still_closes_attempted_cli_session(
    session_dir: Path,
    cli_script: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[str] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        commands.append(command)
        return DummyProcess(argv, timed_out=command == "open")

    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._LIFECYCLE_TIMEOUT_SECONDS",
        0.01,
    )
    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-00000000000a"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )

    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.start("https://example.com/jobs/1")

    assert commands == ["open", "close"]


@pytest.mark.asyncio
async def test_runtime_rejects_every_cli_global_option_alias(
    session_dir: Path,
    cli_script: Path,
) -> None:
    commands: list[str] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        commands.append(command)
        stdout = b""
        if command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-00000000000b"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")
    commands.clear()

    for alias in (
        "--s",
        "--s=other",
        "-h",
        "--help",
        "--help=true",
        "-v",
        "--version",
        "--version=true",
    ):
        with pytest.raises(PlaywrightCliRuntimeError):
            await runtime.execute("click", [alias])

    assert commands == []
    await runtime.close()


@pytest.mark.asyncio
async def test_model_outputs_do_not_share_harness_artifact_namespace(
    session_dir: Path,
    cli_script: Path,
) -> None:
    model_output: Path | None = None

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        nonlocal model_output
        command = argv[3]
        stdout = b""
        if command == "screenshot":
            filename_arg = next(
                value for value in argv if value.startswith("--filename=")
            )
            model_output = Path(filename_arg.removeprefix("--filename="))
            model_output.write_bytes(b"model-output")
        elif command == "run-code":
            script = argv[4]
            marker = "const screenshotPath="
            payload: dict[str, object] = {
                "url": "https://example.com/jobs/1",
                "title": "Job",
                "currentIndex": 0,
                "tabs": [
                    {
                        "url": "https://example.com/jobs/1",
                        "title": "Job",
                    }
                ],
            }
            if marker in script:
                encoded_path = script.split(marker, 1)[1].split(";", 1)[0]
                harness_output = Path(json.loads(encoded_path))
                harness_output.write_bytes(b"\x89PNG\r\n\x1a\nobservation")
                payload["screenshot"] = True
                assert model_output is None or harness_output.parent != model_output.parent
            stdout = json.dumps({"result": json.dumps(payload)}).encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-00000000000c"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")

    await runtime.execute("screenshot", ["--filename=observation-1.png"])

    assert model_output is not None
    assert model_output.read_bytes() == b"model-output"
    config = json.loads(runtime._config_path.read_text(encoding="utf-8"))
    assert "outputMaxSize" not in config
    assert config["snapshot"] == {"mode": "none"}
    assert config["console"] == {"level": "none"}
    assert config["browser"]["contextOptions"] == {"acceptDownloads": False}
    assert runtime._video_path.parent != model_output.parent
    await runtime.close()


@pytest.mark.asyncio
async def test_unapproved_tabs_are_redacted_and_cannot_be_closed(
    session_dir: Path,
    cli_script: Path,
) -> None:
    commands: list[str] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        commands.append(command)
        stdout = b""
        if command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                },
                                {
                                    "url": "https://private.example/mail",
                                    "title": "Private inbox",
                                },
                            ],
                        }
                    )
                }
            ).encode()
        elif command == "tab-list":
            stdout = b"https://private.example/mail Private inbox"
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-00000000000d"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")
    commands.clear()

    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("tab-close", ["1"])
    assert commands == []

    result = await runtime.execute("tab-list")
    assert result.stdout == "[redacted]"
    assert result.observation.tabs[0].url == "https://example.com/jobs/1"
    assert result.observation.tabs[1].url == "[redacted]"
    assert result.observation.tabs[1].title == "[redacted]"
    await runtime.close()


@pytest.mark.asyncio
async def test_execute_has_one_aggregate_pipeline_deadline(
    session_dir: Path,
    cli_script: Path,
) -> None:
    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-00000000000e"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
        execution_timeout=0.01,
    )
    await runtime.start("https://example.com/jobs/1")

    async def never_observe(
        _execution: object,
        *,
        remove_snapshot_file: bool = True,
    ) -> object:
        del remove_snapshot_file
        await asyncio.sleep(100)
        raise AssertionError("unreachable")

    runtime._collect_observation = never_observe  # type: ignore[method-assign]
    started = time.monotonic()
    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.execute("click", ["e1"])
    assert time.monotonic() - started < 0.2

    await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("artifact_kind", ["video", "output", "temporary"])
async def test_live_artifact_budget_closes_the_owned_cli_session(
    artifact_kind: str,
    session_dir: Path,
    cli_script: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[str] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        commands.append(command)
        stdout = b""
        if command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._MAX_VIDEO_BYTES",
        1,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._MAX_OUTPUT_DIRECTORY_BYTES",
        1,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._MAX_TEMPORARY_DIRECTORY_BYTES",
        1,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._ARTIFACT_BUDGET_POLL_SECONDS",
        0.001,
    )
    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-00000000000f"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")
    commands.clear()
    if artifact_kind in {"output", "temporary"}:
        await runtime.suppress_private_capture()
        assert runtime._video_started is False
        assert runtime._artifact_monitor_task is not None
        assert not runtime._artifact_monitor_task.done()

    if artifact_kind == "video":
        artifact = runtime._video_directory / "session-1.webm"
    elif artifact_kind == "output":
        artifact = runtime._output_directory / "async-download.bin"
    else:
        artifact = (
            runtime._temporary_directory
            / "playwright-artifacts-download"
            / "download.bin"
        )
        artifact.parent.mkdir()
    artifact.write_bytes(b"xx")

    async def wait_for_close() -> None:
        while not runtime._closed:
            await asyncio.sleep(0.001)

    await asyncio.wait_for(wait_for_close(), timeout=1)

    assert commands == ["video-stop", "close"]
    assert not runtime._ownership_path.exists()
    commands.clear()
    await runtime.close()
    assert commands == []


@pytest.mark.asyncio
async def test_budget_cleanup_retains_ownership_until_temporary_removal_succeeds(
    session_dir: Path,
    cli_script: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    monkeypatch.setattr(playwright_cli, "_MAX_OUTPUT_DIRECTORY_BYTES", 1)
    monkeypatch.setattr(playwright_cli, "_ARTIFACT_BUDGET_POLL_SECONDS", 0.001)
    original_remove = playwright_cli._remove_owned_temporary_directory
    removal_attempted = asyncio.Event()
    allow_removal = False

    def remove_temporary_directory(path: Path, session_id: UUID) -> None:
        removal_attempted.set()
        if not allow_removal:
            raise BrowserConfigurationError("temporary removal failed")
        original_remove(path, session_id)

    monkeypatch.setattr(
        playwright_cli,
        "_remove_owned_temporary_directory",
        remove_temporary_directory,
    )
    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000010"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")
    temporary_directory = runtime._temporary_directory
    runtime._output_directory.joinpath("download.bin").write_bytes(b"xx")

    await asyncio.wait_for(removal_attempted.wait(), timeout=1)
    assert runtime._closed is False
    assert runtime._open_attempted is True
    assert runtime._ownership_path.exists()
    assert temporary_directory.exists()

    allow_removal = True

    async def wait_for_close() -> None:
        while not runtime._closed:
            await asyncio.sleep(0.001)

    await asyncio.wait_for(wait_for_close(), timeout=1)
    assert not runtime._ownership_path.exists()
    assert not temporary_directory.exists()


@pytest.mark.asyncio
async def test_budget_emergency_terminates_a_wedged_owned_daemon(
    session_dir: Path,
    cli_script: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[str] = []
    matching_calls = 0
    terminated: list[int] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        commands.append(command)
        stdout = b""
        if command == "open":
            stdout = json.dumps({"pid": 4545}).encode()
        elif command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(
            argv,
            stdout=stdout,
            timed_out=command in {"video-stop", "close"},
        )

    def matching(_session_name: str, recorded_pid: int | None) -> tuple[int, ...]:
        nonlocal matching_calls
        assert recorded_pid == 4545
        matching_calls += 1
        return (4545,) if matching_calls == 1 else ()

    async def terminate(pid: int, _session_name: str) -> None:
        terminated.append(pid)

    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._MAX_OUTPUT_DIRECTORY_BYTES",
        1,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._ARTIFACT_BUDGET_POLL_SECONDS",
        0.001,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._BUDGET_CLEANUP_TIMEOUT_SECONDS",
        0.001,
        raising=False,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._matching_cli_daemon_pids",
        matching,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._terminate_owned_daemon",
        terminate,
    )
    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000015"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")
    commands.clear()
    (runtime._output_directory / "async-download.bin").write_bytes(b"xx")

    async def wait_for_close() -> None:
        while not runtime._closed:
            await asyncio.sleep(0.001)

    await asyncio.wait_for(wait_for_close(), timeout=1)

    assert commands == ["video-stop", "close"]
    assert terminated == [4545]
    assert not runtime._ownership_path.exists()


@pytest.mark.asyncio
async def test_stale_cli_ownership_is_closed_before_reuse(
    tmp_path: Path,
    cli_script: Path,
) -> None:
    artifacts_root = tmp_path / "sessions"
    session_id = UUID("00000000-0000-0000-0000-000000000010")
    session_directory = artifacts_root / str(session_id)
    home_directory = session_directory / "playwright-cli" / "home"
    home_directory.mkdir(parents=True)
    internal_directory = session_directory / "playwright-cli" / "internal"
    internal_directory.mkdir(mode=0o700)
    stale_payload = internal_directory / (
        ".sign-in-00000000000000000000000000000000.js"
    )
    stale_payload.symlink_to("/proc/999999/fd/99")
    ownership_path = session_directory / "playwright-cli" / "ownership.json"
    ownership_path.write_text(
        json.dumps(
            {
                "session_name": f"jobhunter-{session_id.hex}",
                "temporary_directory": (
                    f"/tmp/jobhunter-pw-{session_id.hex[:8]}-already-removed"
                ),
            }
        ),
        encoding="utf-8",
    )
    ownership_path.chmod(0o600)
    spawns: list[tuple[list[str], dict[str, Any]]] = []

    def factory(*argv: str, **kwargs: Any) -> DummyProcess:
        spawns.append((list(argv), kwargs))
        stdout = json.dumps(
            {
                "session": f"jobhunter-{session_id.hex}",
                "status": "closed",
            }
        ).encode()
        return DummyProcess(argv, stdout=stdout)

    await recover_stale_playwright_cli_sessions(
        artifacts_root=artifacts_root,
        node_executable=Path("/usr/bin/node"),
        cli_script=cli_script,
        process_factory=factory,
    )

    assert len(spawns) == 1
    argv, kwargs = spawns[0]
    assert argv == [
        "/usr/bin/node",
        str(cli_script.resolve()),
        f"--session=jobhunter-{session_id.hex}",
        "close",
        "--json",
    ]
    assert kwargs["cwd"] == str(session_directory.resolve())
    assert kwargs["env"]["HOME"] == str(home_directory.resolve())
    assert not ownership_path.exists()
    assert not stale_payload.exists()
    assert not stale_payload.is_symlink()


@pytest.mark.asyncio
async def test_stale_recovery_reclaims_journaled_native_browser(
    tmp_path: Path,
    cli_script: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifacts_root = tmp_path / "sessions"
    session_id = UUID("00000000-0000-0000-0000-000000000016")
    session_directory = artifacts_root / str(session_id)
    home_directory = session_directory / "playwright-cli" / "home"
    home_directory.mkdir(parents=True)
    chrome = tmp_path / "chrome"
    chrome.write_text("#!/bin/sh\n", encoding="utf-8")
    chrome.chmod(0o700)
    profile = tmp_path / "profile"
    profile.mkdir(mode=0o700)
    ownership_path = session_directory / "playwright-cli" / "ownership.json"
    ownership_path.write_text(
        json.dumps(
            {
                "session_name": f"jobhunter-{session_id.hex}",
                "temporary_directory": (
                    f"/tmp/jobhunter-pw-{session_id.hex[:8]}-already-removed"
                ),
                "native_browser_pid": 6161,
                "native_browser_create_time": 234.5,
                "native_launcher": str(chrome.resolve()),
                "native_executable": str(chrome.resolve()),
                "native_user_data_dir": str(profile.resolve()),
            }
        ),
        encoding="utf-8",
    )
    ownership_path.chmod(0o600)
    browser_running = True
    terminated: list[tuple[int, float]] = []

    def matching_native_browser_processes(
        executable_path: Path,
        user_data_dir: Path,
        recorded_pid: int,
        recorded_create_time: float,
    ) -> tuple[tuple[int, float], ...]:
        assert executable_path == chrome.resolve()
        assert user_data_dir == profile.resolve()
        assert recorded_pid == 6161
        assert recorded_create_time == 234.5
        return ((6161, 234.5),) if browser_running else ()

    async def terminate_owned_native_browser(
        pid: int,
        create_time: float,
        executable_path: Path,
        user_data_dir: Path,
    ) -> None:
        nonlocal browser_running
        assert executable_path == chrome.resolve()
        assert user_data_dir == profile.resolve()
        terminated.append((pid, create_time))
        browser_running = False

    monkeypatch.setattr(
        playwright_cli,
        "_matching_native_browser_processes",
        matching_native_browser_processes,
        raising=False,
    )
    monkeypatch.setattr(
        playwright_cli,
        "_terminate_owned_native_browser",
        terminate_owned_native_browser,
        raising=False,
    )

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        return DummyProcess(
            argv,
            stdout=json.dumps(
                {
                    "session": f"jobhunter-{session_id.hex}",
                    "status": "not-open",
                }
            ).encode(),
        )

    await recover_stale_playwright_cli_sessions(
        artifacts_root=artifacts_root,
        node_executable=Path("/usr/bin/node"),
        cli_script=cli_script,
        process_factory=factory,
    )

    assert terminated == [(6161, 234.5)]
    assert not ownership_path.exists()


@pytest.mark.asyncio
async def test_failed_stale_cli_recovery_keeps_durable_ownership(
    tmp_path: Path,
    cli_script: Path,
) -> None:
    artifacts_root = tmp_path / "sessions"
    session_id = UUID("00000000-0000-0000-0000-000000000011")
    session_directory = artifacts_root / str(session_id)
    (session_directory / "playwright-cli" / "home").mkdir(parents=True)
    ownership_path = session_directory / "playwright-cli" / "ownership.json"
    ownership_path.write_text(
        json.dumps(
            {
                "session_name": f"jobhunter-{session_id.hex}",
                "temporary_directory": (
                    f"/tmp/jobhunter-pw-{session_id.hex[:8]}-still-owned"
                ),
            }
        ),
        encoding="utf-8",
    )
    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        return DummyProcess(argv, exit_code=1, stderr=b"private failure")

    with pytest.raises(BrowserConfigurationError):
        await recover_stale_playwright_cli_sessions(
            artifacts_root=artifacts_root,
            node_executable=Path("/usr/bin/node"),
            cli_script=cli_script,
            process_factory=factory,
        )

    assert ownership_path.exists()


@pytest.mark.asyncio
async def test_not_open_close_reconciles_recorded_daemon_before_release(
    session_dir: Path,
    cli_script: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    matching_calls = 0
    terminated: list[tuple[int, str]] = []

    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        stdout = b""
        if command == "open":
            stdout = json.dumps({"pid": 4242}).encode()
        elif command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        elif command == "close":
            stdout = json.dumps(
                {
                    "session": "jobhunter-00000000000000000000000000000013",
                    "status": "not-open",
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    def matching(session_name: str, recorded_pid: int | None) -> tuple[int, ...]:
        nonlocal matching_calls
        assert session_name == "jobhunter-00000000000000000000000000000013"
        assert recorded_pid == 4242
        matching_calls += 1
        return (4242,) if matching_calls == 1 else ()

    async def terminate(pid: int, session_name: str) -> None:
        terminated.append((pid, session_name))

    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._matching_cli_daemon_pids",
        matching,
    )
    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._terminate_owned_daemon",
        terminate,
    )
    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000013"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")

    await runtime.close()

    assert terminated == [
        (4242, "jobhunter-00000000000000000000000000000013")
    ]
    assert not runtime._ownership_path.exists()


@pytest.mark.asyncio
async def test_not_open_close_retains_ownership_when_daemon_survives(
    session_dir: Path,
    cli_script: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        stdout = b""
        if command == "open":
            stdout = json.dumps({"pid": 4343}).encode()
        elif command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/jobs/1",
                            "title": "Job",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/jobs/1",
                                    "title": "Job",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        elif command == "close":
            stdout = json.dumps(
                {
                    "session": "jobhunter-00000000000000000000000000000014",
                    "status": "not-open",
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._matching_cli_daemon_pids",
        lambda _session_name, _recorded_pid: (4343,),
    )

    async def leave_running(_pid: int, _session_name: str) -> None:
        return

    monkeypatch.setattr(
        "jobhunter_browser_harness.playwright_cli._terminate_owned_daemon",
        leave_running,
    )
    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000014"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        cli_script=cli_script,
        process_factory=factory,
    )
    await runtime.start("https://example.com/jobs/1")

    with pytest.raises(PlaywrightCliRuntimeError):
        await runtime.close()

    assert runtime._open_attempted
    assert runtime._ownership_path.exists()


@pytest.mark.asyncio
async def test_private_sign_in_fills_refs_redacts_values_and_disables_screenshots(
    session_dir: Path,
    cli_script: Path,
) -> None:
    username = "-u'O'Brien{\\ser"
    password = '--submit\n\t"secret\\tail'
    yaml_key_fragment = "-u''O''Brien{\\ser"
    yaml_value_fragment = '--submit\\n\\t\\"secret\\\\tail'
    invocations: list[list[str]] = []
    payload_scripts: list[str] = []
    payload_paths: list[Path] = []
    payload_modes: list[int] = []
    payload_is_symlink: list[bool] = []
    payload_targets: list[str] = []

    def process_factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        invocations.append(list(argv))
        command = argv[3]
        stdout = b""
        stderr = b""
        exit_code = 0
        if command == "run-code":
            filename_argument = next(
                (
                    value
                    for value in argv[4:]
                    if value.startswith("--filename=")
                ),
                None,
            )
            if filename_argument is not None:
                payload_path = Path(filename_argument.split("=", 1)[1])
                payload_is_symlink.append(payload_path.is_symlink())
                payload_targets.append(os.readlink(payload_path))
                payload_paths.append(payload_path)
                payload_modes.append(stat.S_IMODE(payload_path.stat().st_mode))
                payload_scripts.append(
                    payload_path.read_text(encoding="utf-8")
                )
                stdout = f'reflected "{username}"\\{password}\x01'.encode()
                stderr = f"private diagnostic\r{password}".encode()
            else:
                metadata = {
                    "url": "https://example.com/login",
                    "title": f"Welcome {username}",
                    "currentIndex": 0,
                    "tabs": [
                        {
                            "url": "https://example.com/login",
                            "title": f"Account {password}",
                        }
                    ],
                    "screenshot": False,
                }
                stdout = json.dumps(
                    {"result": json.dumps(metadata)}
                ).encode("utf-8")
        elif command == "snapshot":
            filename_argument = next(
                (
                    value
                    for value in argv[4:]
                    if value.startswith("--filename=")
                ),
                None,
            )
            if filename_argument is not None:
                Path(filename_argument.split("=", 1)[1]).write_text(
                    "login form",
                    encoding="utf-8",
                )
            else:
                inline_dom = (
                    f"'{yaml_key_fragment}': textbox\n"
                    f'value: "{yaml_value_fragment}"'
                )
                stdout = json.dumps({"snapshot": inline_dom}).encode()
                stderr = f"reflected\n{password}".encode()
                exit_code = 7
        return DummyProcess(
            argv=argv,
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
        )

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000016"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/login")
    invocations.clear()

    await runtime.sign_in(
        expected_origin="https://example.com",
        username_ref="f2e248",
        password_ref="f2e255",
        submit_ref="f2e261",
        username=username,
        password=password,
    )

    assert [invocation[3] for invocation in invocations] == [
        "video-stop",
        "run-code",
        "run-code",
        "run-code",
    ]
    assert all(
        username not in argument and password not in argument
        for invocation in invocations
        for argument in invocation
    )
    assert payload_modes == [0o600]
    assert len(payload_paths) == 1
    assert not payload_paths[0].exists()
    assert payload_is_symlink == [True]
    assert len(payload_targets) == 1
    assert payload_targets[0].startswith(f"/proc/{os.getpid()}/fd/")
    assert len(payload_scripts) == 1
    assert "aria-ref=f2e248" in payload_scripts[0]
    assert "aria-ref=f2e255" in payload_scripts[0]
    assert "aria-ref=f2e261" in payload_scripts[0]
    assert json.dumps(username) in payload_scripts[0]
    assert json.dumps(password) in payload_scripts[0]
    assert "const expectedOrigin=\"https://example.com\"" in payload_scripts[0]
    expected_url_check = (
        "const hasExpectedUrl=(url)=>url===expectedOrigin||"
        "url.startsWith(expectedOrigin+'/');"
        "if(!hasExpectedUrl(page.url()))"
        "throw new Error('Unexpected sign-in origin');"
    )
    assert expected_url_check in payload_scripts[0]
    assert payload_scripts[0].count(".elementHandle()") == 3
    cdp_origin_check = (
        "const cdp=await page.context().newCDPSession(page);"
        "const frameTree=(await cdp.send('Page.getFrameTree')).frameTree;"
        "await cdp.detach();"
        "const frames=[];"
        "const collectFrames=(tree)=>{frames.push(tree.frame);"
        "for(const child of tree.childFrames||[])collectFrames(child);};"
        "collectFrames(frameTree);"
        "if(frameTree.frame.securityOrigin!==expectedOrigin)"
        "throw new Error('Unexpected sign-in origin');"
    )
    assert cdp_origin_check in payload_scripts[0]
    control_origin_check = (
        "const controlOriginsApproved=await Promise.all("
        "[usernameElement,passwordElement,submitElement].map("
        "async(element)=>{const frame=await element.ownerFrame();"
        "if(frame===null)return false;"
        "const frameUrl=frame.url().split('#')[0];"
        "const frameName=frame.name();"
        "const matches=frames.filter((candidate)=>"
        "candidate.url===frameUrl&&(candidate.name||'')===frameName);"
        "return matches.length>0&&matches.every((candidate)=>"
        "candidate.securityOrigin===expectedOrigin);}));"
    )
    assert control_origin_check in payload_scripts[0]
    rejected_control_origin = (
        "if(controlOriginsApproved.some((approved)=>!approved))"
        "throw new Error('Unexpected sign-in control origin');"
    )
    assert rejected_control_origin in payload_scripts[0]
    assert "new URL(" not in payload_scripts[0]
    assert "page.evaluate(()=>location.origin)" not in payload_scripts[0]
    assert "ownerDocument.location.origin" not in payload_scripts[0]
    assert payload_scripts[0].index(
        "const submitElement="
    ) < payload_scripts[0].index(cdp_origin_check)
    for mutation in (
        "await usernameElement.fill(username)",
        "await passwordElement.fill(password)",
        "await submitElement.click()",
    ):
        assert payload_scripts[0].index(cdp_origin_check) < payload_scripts[0].index(
            mutation
        )
    assert runtime._video_started is False
    assert runtime._artifact_monitor_task is not None
    assert not runtime._artifact_monitor_task.done()

    invocations.clear()
    result = await runtime.execute("snapshot", [])
    assert result.stdout == "[redacted]"
    assert result.stderr == "[redacted]"
    assert result.stdout_truncated is False
    assert result.stderr_truncated is False
    assert result.exit_code == 7
    dumped = result.model_dump_json()
    assert username not in dumped
    assert password not in dumped
    assert yaml_key_fragment not in dumped
    assert yaml_value_fragment not in dumped
    assert "[redacted]" in result.observation.title
    assert "[redacted]" in result.observation.dom
    assert result.observation.screenshot is None
    observation_scripts = [
        invocation[4]
        for invocation in invocations
        if invocation[3] == "run-code"
    ]
    assert all("const screenshotPath=" not in script for script in observation_scripts)
    assert runtime._video_started is False
    assert all(invocation[3] != "video-start" for invocation in invocations)
    assert all(
        not any(
            argument == "--filename" or argument.startswith("--filename=")
            for argument in invocation[4:]
        )
        for invocation in invocations
        if invocation[3] == "snapshot"
    )
    assert list(runtime._internal_directory.glob("*.yml")) == []

    for blocked_command, blocked_args in (
        (
            "eval",
            ["() => btoa(document.querySelector('input').value)"],
        ),
        ("screenshot", ["--filename=after-sign-in.png"]),
        ("pdf", ["--filename=after-sign-in.pdf"]),
        ("snapshot", ["--filename=after-sign-in.yml"]),
    ):
        spawn_count = len(invocations)
        with pytest.raises(PlaywrightCliRuntimeError) as blocked_error:
            await runtime.execute(blocked_command, blocked_args)
        assert blocked_error.value.code == "browser_failed"
        assert len(invocations) == spawn_count
        assert username not in str(blocked_error.value)
        assert password not in str(blocked_error.value)

    for invalid_username, invalid_password in (
        ("ada\x00@example.test", password),
        (username, "private\x00password"),
    ):
        spawn_count = len(invocations)
        with pytest.raises(PlaywrightCliRuntimeError) as invalid_error:
            await runtime.sign_in(
                expected_origin="https://example.com",
                username_ref="e1",
                password_ref="e2",
                submit_ref="e3",
                username=invalid_username,
                password=invalid_password,
            )
        assert invalid_error.value.code == "browser_failed"
        assert len(invocations) == spawn_count

    spawn_count = len(invocations)

    await runtime.close()
    assert all(
        invocation[3] != "video-stop"
        for invocation in invocations[spawn_count:]
    )


@pytest.mark.asyncio
async def test_gate_capture_suppression_blocks_private_extraction_commands(
    session_dir: Path,
    cli_script: Path,
) -> None:
    invocations: list[list[str]] = []

    def process_factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        invocations.append(list(argv))
        stdout = b""
        if argv[3] == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/login",
                            "title": "Login",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/login",
                                    "title": "Login",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(argv, stdout=stdout)

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000017"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/login")
    invocations.clear()

    await runtime.suppress_private_capture()
    assert [invocation[3] for invocation in invocations] == ["video-stop"]
    for blocked_command, blocked_args in (
        (
            "eval",
            ["() => btoa(document.querySelector('input').value)"],
        ),
        ("screenshot", ["--filename=private.png"]),
        ("pdf", ["--filename=private.pdf"]),
    ):
        spawn_count = len(invocations)
        with pytest.raises(PlaywrightCliRuntimeError):
            await runtime.execute(blocked_command, blocked_args)
        assert len(invocations) == spawn_count

    snapshot = await runtime.execute("snapshot", [])
    assert snapshot.exit_code == 0
    assert snapshot.stdout == "[redacted]"
    assert snapshot.stderr == "[redacted]"
    assert snapshot.observation.screenshot is None
    await runtime.close()


@pytest.mark.asyncio
async def test_failed_video_stop_closes_runtime_before_private_fill(
    session_dir: Path,
    cli_script: Path,
) -> None:
    commands: list[str] = []

    def process_factory(*argv: str, **_kwargs: Any) -> DummyProcess:
        command = argv[3]
        commands.append(command)
        stdout = b""
        if command == "run-code":
            stdout = json.dumps(
                {
                    "result": json.dumps(
                        {
                            "url": "https://example.com/login",
                            "title": "Login",
                            "currentIndex": 0,
                            "tabs": [
                                {
                                    "url": "https://example.com/login",
                                    "title": "Login",
                                }
                            ],
                        }
                    )
                }
            ).encode()
        return DummyProcess(
            argv,
            exit_code=1 if command == "video-stop" else 0,
            stdout=stdout,
        )

    runtime = PlaywrightCliRuntime(
        session_id=UUID("00000000-0000-0000-0000-000000000018"),
        launch=ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        session_directory=session_dir,
        deadline=time.monotonic() + 100,
        process_factory=process_factory,
        cli_script=cli_script,
    )
    await runtime.start("https://example.com/login")
    commands.clear()

    with pytest.raises(PlaywrightCliRuntimeError) as caught:
        await runtime.sign_in(
            expected_origin="https://example.com",
            username_ref="e1",
            password_ref="e2",
            submit_ref="e3",
            username="-user",
            password="--submit",
        )

    assert caught.value.code == "browser_failed"
    assert commands == ["video-stop", "video-stop", "close"]
    assert "fill" not in commands
    assert "click" not in commands
    assert runtime._closed is True
    assert runtime._started is False
