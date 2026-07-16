from __future__ import annotations

import stat
import subprocess
from pathlib import Path
from typing import Any

import pytest
from browser_use.browser.watchdogs.security_watchdog import SecurityWatchdog

import jobhunter_browser_harness.browser as browser_module
from jobhunter_browser_harness.browser import (
    BrowserConfigurationError,
    ResolvedBrowserLaunch,
    create_browser,
    resolve_browser_launch,
    resolve_resume_upload_path,
)
from jobhunter_browser_harness.models import BrowserLaunchConfig


@pytest.mark.parametrize(
    ("url", "canonical"),
    [
        ("http://127.0.0.1:9222", "http://127.0.0.1:9222"),
        ("http://localhost:9333/", "http://localhost:9333"),
        ("http://[::1]:9444", "http://[::1]:9444"),
    ],
)
def test_loopback_cdp_requires_an_explicit_port_and_normalizes_root_slash(
    url: str,
    canonical: str,
) -> None:
    config = BrowserLaunchConfig(cdp_url=url)

    assert config.cdp_url == canonical
    assert resolve_browser_launch(config) == ResolvedBrowserLaunch(
        cdp_url=canonical,
        executable_path=None,
        user_data_dir=None,
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1",
        "http://localhost:9222/json/version",
        "http://localhost:9222?token=private",
        "http://localhost:9222/#fragment",
        "https://localhost:9222",
        "http://192.0.2.10:9222",
        "http://chrome.example:9222",
        "http://*:9222",
    ],
)
def test_cdp_rejects_missing_port_paths_public_hosts_and_wildcards(url: str) -> None:
    with pytest.raises(ValueError):
        BrowserLaunchConfig(cdp_url=url)


def test_cdp_and_explicit_executable_are_mutually_exclusive(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="mutually exclusive"):
        BrowserLaunchConfig(
            cdp_url="http://127.0.0.1:9222",
            chrome_executable=tmp_path / "chrome",
        )


def _make_executable(path: Path) -> Path:
    path.write_bytes(b"test chrome executable")
    path.chmod(0o700)
    return path


def test_resolve_native_launch_uses_explicit_executable_and_mode_0700_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = _make_executable(tmp_path / "chrome")
    profile = tmp_path / "dedicated-profile"
    monkeypatch.setattr(browser_module, "_default_profile_roots", lambda: ())
    monkeypatch.setattr(browser_module, "_is_wsl", lambda: False)

    resolved = resolve_browser_launch(
        BrowserLaunchConfig(
            chrome_executable=executable,
            chrome_user_data_dir=profile,
        )
    )

    assert resolved == ResolvedBrowserLaunch(
        cdp_url=None,
        executable_path=executable.resolve(),
        user_data_dir=profile.resolve(),
    )
    assert profile.is_dir()
    assert stat.S_IMODE(profile.stat().st_mode) == 0o700


def test_resolve_native_launch_rejects_os_default_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = _make_executable(tmp_path / "chrome")
    default_root = tmp_path / "default-chrome-user-data"
    profile = default_root / "Default"
    monkeypatch.setattr(browser_module, "_default_profile_roots", lambda: (default_root,))
    monkeypatch.setattr(browser_module, "_is_wsl", lambda: False)

    with pytest.raises(BrowserConfigurationError, match="operating-system default profile"):
        resolve_browser_launch(
            BrowserLaunchConfig(
                chrome_executable=executable,
                chrome_user_data_dir=profile,
            )
        )

    assert not profile.exists()


def test_resolve_native_launch_rejects_symlinked_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = _make_executable(tmp_path / "chrome")
    real_profile = tmp_path / "real-profile"
    real_profile.mkdir()
    profile_link = tmp_path / "profile-link"
    profile_link.symlink_to(real_profile, target_is_directory=True)
    monkeypatch.setattr(browser_module, "_default_profile_roots", lambda: ())
    monkeypatch.setattr(browser_module, "_is_wsl", lambda: False)

    with pytest.raises(BrowserConfigurationError, match="must not be a symbolic link"):
        resolve_browser_launch(
            BrowserLaunchConfig(
                chrome_executable=executable,
                chrome_user_data_dir=profile_link,
            )
        )


def test_wsl_never_auto_discovers_chrome(monkeypatch: pytest.MonkeyPatch) -> None:
    discovery_called = False

    def unexpected_discovery() -> str:
        nonlocal discovery_called
        discovery_called = True
        return "/unexpected/chrome"

    monkeypatch.setattr(browser_module, "_is_wsl", lambda: True)
    monkeypatch.setattr(browser_module, "find_chrome_executable", unexpected_discovery)

    with pytest.raises(BrowserConfigurationError, match="not auto-discovered in WSL"):
        resolve_browser_launch(BrowserLaunchConfig())

    assert discovery_called is False


def test_wsl_rejects_direct_windows_executable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = _make_executable(tmp_path / "chrome.exe")
    monkeypatch.setattr(browser_module, "_is_wsl", lambda: True)

    with pytest.raises(BrowserConfigurationError, match="connected through --cdp-url"):
        resolve_browser_launch(
            BrowserLaunchConfig(
                chrome_executable=executable,
                chrome_user_data_dir=tmp_path / "profile",
            )
        )


class _CapturingBrowser:
    calls: list[dict[str, Any]] = []

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.browser_profile: Any = None
        self.__class__.calls.append(kwargs)


def test_create_browser_uses_exact_persistent_native_profile_without_copy_or_launch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = _make_executable(tmp_path / "chrome")
    user_data_dir = tmp_path / "dedicated-profile"
    user_data_dir.mkdir(mode=0o700)
    downloads = tmp_path / "downloads"
    launch = ResolvedBrowserLaunch(
        cdp_url=None,
        executable_path=executable,
        user_data_dir=user_data_dir,
    )
    copied = False

    def unexpected_base_copy(_profile: object) -> None:
        nonlocal copied
        copied = True
        raise AssertionError("the dedicated profile must never be copied")

    _CapturingBrowser.calls = []
    monkeypatch.setattr(browser_module, "Browser", _CapturingBrowser)
    monkeypatch.setattr(browser_module.BrowserProfile, "_copy_profile", unexpected_base_copy)

    browser = create_browser(
        launch,
        ["https://Jobs.Example:443/"],
        downloads,
    )

    assert isinstance(browser, _CapturingBrowser)
    assert _CapturingBrowser.calls == [{"is_local": True}]
    profile = browser.browser_profile
    assert isinstance(profile, browser_module._PersistentChromeProfile)
    assert profile.is_local is True
    assert profile.executable_path == executable
    assert profile.user_data_dir == user_data_dir
    assert profile.profile_directory == "Default"
    assert profile.headless is False
    assert profile.keep_alive is True
    assert profile.disable_security is False
    assert profile.chromium_sandbox is True
    assert profile.enable_default_extensions is False
    assert profile.allowed_domains == ["https://jobs.example/"]
    assert profile.downloads_path == downloads.resolve()
    assert profile.record_har_path is None
    assert profile.record_video_dir is None
    assert profile.traces_dir is None
    assert stat.S_IMODE(downloads.stat().st_mode) == 0o700

    profile._copy_profile()
    assert copied is False
    assert profile.user_data_dir == user_data_dir



def test_create_browser_preserves_no_copy_profile_with_real_browser_session(
    tmp_path: Path,
) -> None:
    executable = _make_executable(tmp_path / "chrome")
    user_data_dir = tmp_path / "dedicated-profile"
    user_data_dir.mkdir(mode=0o700)

    browser = create_browser(
        ResolvedBrowserLaunch(
            cdp_url=None,
            executable_path=executable,
            user_data_dir=user_data_dir,
        ),
        ["https://jobs.example"],
        tmp_path / "downloads",
    )

    assert type(browser.browser_profile) is browser_module._PersistentChromeProfile
    assert browser.browser_profile.user_data_dir == user_data_dir
    browser.browser_profile._copy_profile()
    assert browser.browser_profile.user_data_dir == user_data_dir

def test_create_browser_uses_only_cdp_connection_settings(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    downloads = tmp_path / "downloads"
    launch = ResolvedBrowserLaunch(
        cdp_url="http://127.0.0.1:9222",
        executable_path=None,
        user_data_dir=None,
    )
    _CapturingBrowser.calls = []
    monkeypatch.setattr(browser_module, "Browser", _CapturingBrowser)

    browser = create_browser(
        launch,
        ["https://jobs.example", "https://ats.example:8443/"],
        downloads,
    )

    assert isinstance(browser, _CapturingBrowser)
    assert _CapturingBrowser.calls == [
        {
            "cdp_url": "http://127.0.0.1:9222",
            "headless": False,
            "keep_alive": True,
            "allowed_domains": [
                "https://jobs.example/",
                "https://ats.example:8443/",
            ],
            "downloads_path": downloads.resolve(),
        }
    ]
    assert stat.S_IMODE(downloads.stat().st_mode) == 0o700


def test_trailing_slash_allowlist_distinguishes_exact_origin_from_lookalike(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _CapturingBrowser.calls = []
    monkeypatch.setattr(browser_module, "Browser", _CapturingBrowser)
    browser = create_browser(
        ResolvedBrowserLaunch(
            cdp_url="http://localhost:9222",
            executable_path=None,
            user_data_dir=None,
        ),
        ["https://jobs.example"],
        tmp_path / "downloads",
    )
    pattern = browser.kwargs["allowed_domains"][0]

    assert pattern == "https://jobs.example/"
    assert SecurityWatchdog._is_url_match(
        None,
        "https://jobs.example/application/42",
        "jobs.example",
        "https",
        pattern,
    )
    assert not SecurityWatchdog._is_url_match(
        None,
        "https://jobs.example.evil/application/42",
        "jobs.example.evil",
        "https",
        pattern,
    )


def test_wsl_cdp_translates_resume_path_with_wslpath(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resume = tmp_path / "resume.pdf"
    resume.write_bytes(b"%PDF-test")
    converter = "/usr/bin/wslpath"
    which_calls: list[str] = []
    run_calls: list[tuple[list[str], dict[str, Any]]] = []

    def fake_which(command: str) -> str:
        which_calls.append(command)
        return converter

    def fake_run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        run_calls.append((command, kwargs))
        return subprocess.CompletedProcess(
            args=command,
            returncode=0,
            stdout="C:\\Users\\Applicant\\resume.pdf\n",
            stderr="",
        )

    monkeypatch.setattr(browser_module, "_is_wsl", lambda: True)
    monkeypatch.setattr(browser_module.shutil, "which", fake_which)
    monkeypatch.setattr(browser_module.subprocess, "run", fake_run)

    translated = resolve_resume_upload_path(
        resume,
        ResolvedBrowserLaunch(
            cdp_url="http://127.0.0.1:9222",
            executable_path=None,
            user_data_dir=None,
        ),
    )

    assert translated == "C:\\Users\\Applicant\\resume.pdf"
    assert which_calls == ["wslpath"]
    assert run_calls == [
        (
            [converter, "-w", str(resume.resolve())],
            {
                "check": True,
                "capture_output": True,
                "text": True,
                "timeout": 5,
            },
        )
    ]


def test_native_resume_path_never_invokes_wsl_translation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    resume = tmp_path / "resume.pdf"
    resume.write_bytes(b"%PDF-test")

    def unexpected_wsl_check() -> bool:
        raise AssertionError("native upload paths do not need WSL translation")

    monkeypatch.setattr(browser_module, "_is_wsl", unexpected_wsl_check)

    assert resolve_resume_upload_path(
        resume,
        ResolvedBrowserLaunch(
            cdp_url=None,
            executable_path=tmp_path / "chrome",
            user_data_dir=tmp_path / "profile",
        ),
    ) == str(resume.resolve())
