from __future__ import annotations
import base64
import asyncio
import json
import io
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace
from pathlib import Path

import pytest

from browser_use.skills.browser_use import skill_text
from browser_use import Browser
from PIL import Image
from fixtures.local_application import LocalApplicationFixture

from jobhunter_browser_harness.skill_runtime import load_browser_skill
from jobhunter_browser_harness.skill_runtime import (
    BrowserSkillRuntime,
    BrowserSkillRuntimeError,
)


def test_load_browser_skill_returns_canonical_packaged_instructions() -> None:
    expected = skill_text()

    assert load_browser_skill() == expected
    assert expected


class _InvalidEndpointBrowser:
    cdp_url = "ws://browser.example:9222/devtools/browser/test"

    def __init__(self) -> None:
        self.start_calls = 0

    async def start(self) -> None:
        self.start_calls += 1


class _LoopbackEndpointBrowser:
    cdp_url = "ws://127.0.0.1:9/devtools/browser/unreachable"

    async def start(self) -> None:
        return


async def test_start_calls_browser_once_and_rejects_non_loopback_cdp(
    tmp_path: Path,
) -> None:
    browser = _InvalidEndpointBrowser()
    runtime = BrowserSkillRuntime(
        browser=browser,
        session_directory=tmp_path / "session",
        workspace=tmp_path / "workspace",
        bubblewrap_executable=Path("/usr/bin/bwrap"),
        deadline=asyncio.get_running_loop().time() + 30,
    )

    with pytest.raises(BrowserSkillRuntimeError) as raised:
        await runtime.start()

    assert raised.value.code == "browser_failed"
    assert browser.start_calls == 1


def _chromium_executable() -> Path:
    candidates = sorted(
        (Path.home() / ".cache" / "ms-playwright").glob(
            "chromium-*/chrome-linux*/chrome"
        ),
        reverse=True,
    )
    executable = next((path for path in candidates if path.is_file()), None)
    if executable is None:
        pytest.skip("Playwright Chromium is unavailable")
    return executable


@dataclass(frozen=True, slots=True)
class _RunningRuntime:
    runtime: BrowserSkillRuntime
    browser: Browser
    application: LocalApplicationFixture
    session_directory: Path
    workspace: Path


@pytest.fixture
async def running_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[_RunningRuntime]:
    monkeypatch.setenv("JOBHUNTER_HARNESS_TOKEN", "parent-only-harness-token")
    monkeypatch.setenv("BROWSER_USE_API_KEY", "parent-only-cloud-token")
    session_directory = tmp_path / ("long-session-" + "x" * 100) / "session"
    session_directory.mkdir(mode=0o700, parents=True)
    workspace = tmp_path / "workspace"
    workspace.mkdir(mode=0o700)
    profile = tmp_path / "profile"
    profile.mkdir(mode=0o700)
    downloads = session_directory / "downloads"
    downloads.mkdir(mode=0o700)
    browser = Browser(
        executable_path=_chromium_executable(),
        user_data_dir=profile,
        headless=True,
        keep_alive=True,
        downloads_path=downloads,
        chromium_sandbox=False,
        enable_default_extensions=False,
        record_har_path=None,
        record_video_dir=None,
        traces_dir=None,
    )
    runtime = BrowserSkillRuntime(
        browser=browser,
        session_directory=session_directory,
        workspace=workspace,
        bubblewrap_executable=Path("/usr/bin/bwrap"),
        deadline=asyncio.get_running_loop().time() + 60,
    )

    with LocalApplicationFixture() as application:
        try:
            await runtime.start()
            yield _RunningRuntime(
                runtime=runtime,
                browser=browser,
                application=application,
                session_directory=session_directory,
                workspace=workspace,
            )
        finally:
            await runtime.close()
            await browser.kill()


async def test_execute_runs_packaged_skill_in_bubblewrap_and_observes_browser(
    running_runtime: _RunningRuntime,
) -> None:
    result = await running_runtime.runtime.execute(
        f"cdp('Page.navigate', url={running_runtime.application.posting_url!r})\n"
        "import time; time.sleep(0.5)\n"
        'print("skill-daemon-ok")\nprint(page_info())'
    )

    assert result.exit_code == 0
    assert result.timed_out is False
    assert "skill-daemon-ok" in result.stdout
    assert result.observation.url == running_runtime.application.posting_url
    assert result.observation.tabs
    assert "Reliability Engineer" in result.observation.dom
    assert result.observation.page_info is not None
    assert result.observation.screenshot is not None
    image = base64.b64decode(
        result.observation.screenshot.data,
        validate=True,
    )
    assert image.startswith(b"\x89PNG\r\n\x1a\n")

    with Image.open(io.BytesIO(image)) as screenshot:
        assert max(screenshot.size) <= 1_800

async def test_sandbox_hides_parent_state_and_reuses_one_daemon(
    running_runtime: _RunningRuntime,
) -> None:
    host_sentinel = running_runtime.session_directory.parent / "host-secret.txt"
    host_sentinel.write_text("must remain outside sandbox", encoding="utf-8")
    probe = (
        "import json, os, resource\n"
        "from pathlib import Path\n"
        f"host_sentinel = Path({str(host_sentinel)!r})\n"
        "runtime = Path(os.environ['BH_RUNTIME_DIR'])\n"
        "daemon_pid = int((runtime / 'bu.pid').read_text())\n"
        "print(json.dumps({"
        "'daemon_pid': str(daemon_pid),"
        "'harness_token': os.environ.get('JOBHUNTER_HARNESS_TOKEN'),"
        "'cloud_token': os.environ.get('BROWSER_USE_API_KEY'),"
        "'host_sentinel': host_sentinel.exists(),"
        "'pid_one': Path('/proc/1/cmdline').read_bytes().decode(errors='replace'),"
        "'session_visible': Path(os.environ['JOBHUNTER_SESSION_DIRECTORY']).is_dir(),"
        "'workspace_visible': Path(os.environ['BH_AGENT_WORKSPACE']).is_dir(),"
        "'core_limit': resource.getrlimit(resource.RLIMIT_CORE),"
        "'nofile_limit': resource.getrlimit(resource.RLIMIT_NOFILE),"
        "'nproc_limit': resource.getrlimit(resource.RLIMIT_NPROC),"
        "'fsize_limit': resource.getrlimit(resource.RLIMIT_FSIZE),"
        "'cpu_limit': resource.getrlimit(resource.RLIMIT_CPU),"
        "'address_limit': resource.getrlimit(resource.RLIMIT_AS),"
        "'daemon_cpu_limit': resource.prlimit(daemon_pid, resource.RLIMIT_CPU),"
        "'daemon_address_limit': resource.prlimit(daemon_pid, resource.RLIMIT_AS),"
        "'daemon_stdin': os.readlink(f'/proc/{daemon_pid}/fd/0')"
        "}, sort_keys=True))"
    )

    first = await running_runtime.runtime.execute(probe)
    second = await running_runtime.runtime.execute(probe)
    first_probe = json.loads(
        next(line for line in first.stdout.splitlines() if line.startswith("{"))
    )
    second_probe = json.loads(
        next(line for line in second.stdout.splitlines() if line.startswith("{"))
    )

    assert first.exit_code == second.exit_code == 0
    assert first_probe["daemon_pid"] == second_probe["daemon_pid"]
    assert first_probe["harness_token"] is None
    assert first_probe["cloud_token"] is None
    assert first_probe["host_sentinel"] is False
    assert "skill_process" in first_probe["pid_one"]
    assert first_probe["session_visible"] is True
    assert first_probe["workspace_visible"] is True
    assert first_probe["core_limit"] == [0, 0]
    assert first_probe["nofile_limit"] == [512, 512]
    assert first_probe["nproc_limit"] == [128, 128]
    assert first_probe["fsize_limit"] == [128 * 1024 * 1024] * 2
    assert first_probe["cpu_limit"] == [120, 120]
    assert first_probe["address_limit"] == [2 * 1024 * 1024 * 1024] * 2
    assert first_probe["daemon_cpu_limit"] == [-1, -1]
    assert first_probe["daemon_address_limit"] == [-1, -1]
    assert first_probe["daemon_stdin"] == "/dev/null"


async def test_only_helpers_and_domain_skills_persist_between_calls(
    running_runtime: _RunningRuntime,
) -> None:
    first = await running_runtime.runtime.execute(
        "import os\n"
        "from pathlib import Path\n"
        "workspace = Path(os.environ['BH_AGENT_WORKSPACE'])\n"
        "(workspace / 'agent_helpers.py').write_text("
        "\"LEARNED_VALUE = 'persisted-learning'\\n\")\n"
        "(workspace / 'domain-skills').mkdir(exist_ok=True)\n"
        "(workspace / 'domain-skills' / 'example.py').write_text("
        "\"DOMAIN_VALUE = 'persisted-domain'\\n\")\n"
        "(workspace / '.env').write_text("
        "\"JOBHUNTER_WORKSPACE_POISON=loaded\\n\")\n"
        "(workspace / 'scratch.txt').write_text('ephemeral')"
    )
    second = await running_runtime.runtime.execute(
        "import os\n"
        "print(LEARNED_VALUE)\n"
        "print(os.environ.get('JOBHUNTER_WORKSPACE_POISON'))"
    )

    assert first.exit_code == second.exit_code == 0
    assert "persisted-learning" in second.stdout
    assert "\nNone\n" in f"\n{second.stdout}"
    assert (running_runtime.workspace / "agent_helpers.py").is_file()
    assert (
        running_runtime.workspace / "domain-skills" / "example.py"
    ).is_file()
    assert not (running_runtime.workspace / ".env").exists()
    assert not (running_runtime.workspace / "scratch.txt").exists()
    quarantined = tuple(
        (running_runtime.session_directory / "browser-skill-quarantine").iterdir()
    )
    assert len(quarantined) == 2


async def test_code_and_output_are_bounded_by_utf8_bytes_and_tail_chars(
    running_runtime: _RunningRuntime,
) -> None:
    output = await running_runtime.runtime.execute(
        "import sys\n"
        "print('stdout-start-' + ('x' * 25000) + '-stdout-end')\n"
        "print('stderr-start-' + ('y' * 25000) + '-stderr-end', file=sys.stderr)"
    )
    oversized = await running_runtime.runtime.execute(
        "print(" + repr("é" * 33_000) + ")"
    )

    assert output.exit_code == 0
    assert len(output.stdout) <= 20_000
    assert len(output.stderr) <= 20_000
    assert output.stdout.endswith("-stdout-end\n\n")
    assert output.stderr.endswith("-stderr-end\n")
    assert output.stdout_truncated is True
    assert output.stderr_truncated is True
    assert oversized.exit_code == 2
    assert oversized.stderr == "Browser Use code exceeds the 65,536-byte limit."


async def test_caller_cancellation_kills_active_invocation_and_propagates(
    running_runtime: _RunningRuntime,
) -> None:
    invocation = asyncio.create_task(
        running_runtime.runtime.execute("import time; time.sleep(30)")
    )
    await asyncio.sleep(0.2)

    invocation.cancel()

    with pytest.raises(asyncio.CancelledError):
        await invocation


async def test_absolute_deadline_is_session_timeout_not_invocation_timeout(
    tmp_path: Path,
) -> None:
    session_directory = tmp_path / "session"
    session_directory.mkdir(mode=0o700)
    workspace = tmp_path / "workspace"
    workspace.mkdir(mode=0o700)
    runtime = BrowserSkillRuntime(
        browser=_LoopbackEndpointBrowser(),
        session_directory=session_directory,
        workspace=workspace,
        bubblewrap_executable=Path("/usr/bin/bwrap"),
        deadline=asyncio.get_running_loop().time() + 0.75,
    )

    try:
        await runtime.start()
        with pytest.raises(BrowserSkillRuntimeError) as raised:
            await runtime.execute("import time; time.sleep(30)")
        assert raised.value.code == "session_timeout"
    finally:
        await runtime.close()


async def test_close_stops_daemon_before_browser_cleanup(
    running_runtime: _RunningRuntime,
) -> None:
    result = await running_runtime.runtime.execute("print(page_info())")
    daemon_pid = (
        running_runtime.session_directory / "browser-skill-runtime" / "bu.pid"
    )

    assert result.exit_code == 0
    assert daemon_pid.is_file()

    await running_runtime.runtime.close()

    assert not daemon_pid.exists()
    assert running_runtime.browser.is_cdp_connected is True


async def test_decoded_screenshot_over_eight_mib_is_rejected(
    running_runtime: _RunningRuntime,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = await running_runtime.browser.get_browser_state_summary(
        include_screenshot=True,
        cached=False,
    )
    oversized = base64.b64encode(b"x" * (8 * 1024 * 1024 + 1)).decode("ascii")

    async def oversized_state(_browser: Browser, **_kwargs: object):
        return replace(state, screenshot=oversized)

    monkeypatch.setattr(
        type(running_runtime.browser),
        "get_browser_state_summary",
        oversized_state,
    )

    with pytest.raises(BrowserSkillRuntimeError) as raised:
        await running_runtime.runtime.execute("print(page_info())")

    assert raised.value.code == "browser_failed"


async def test_missing_marker_is_model_visible_when_browser_remains_alive(
    running_runtime: _RunningRuntime,
) -> None:
    result = await running_runtime.runtime.execute("import os; os._exit(3)")

    assert result.exit_code == 3
    assert result.timed_out is False
    assert "Browser Use result metadata was unavailable." in result.stderr
    assert result.observation.url
