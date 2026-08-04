from __future__ import annotations

import json
import stat
from datetime import UTC, datetime
from pathlib import Path

import pytest

from jobhunter_browser_harness.credentials import CredentialStore
from jobhunter_browser_harness.models import HarnessServiceError
from jobhunter_browser_harness.playwright_cli import BrowserConfigurationError


ORIGIN = "https://login.example.test"
OTHER_ORIGIN = "https://other.example.test"


def _private_parent(tmp_path: Path, name: str = "private") -> Path:
    parent = tmp_path / name
    parent.mkdir(mode=0o700)
    parent.chmod(0o700)
    return parent


def _write_document(path: Path, document: object) -> None:
    path.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    path.chmod(0o600)


def _credential(
    *,
    origin: str = ORIGIN,
    username: str = "ada@example.test",
    password: str = "correct horse battery staple",
    saved_at: str = "2026-08-03T12:00:00.000000Z",
) -> dict[str, object]:
    return {
        "origin": origin,
        "username": username,
        "password": password,
        "saved_at": saved_at,
    }


def test_missing_store_creates_only_private_directory_and_file(tmp_path: Path) -> None:
    path = tmp_path / "credentials" / "credentials.json"

    store = CredentialStore(path)

    assert json.loads(path.read_text(encoding="utf-8")) == {
        "version": 1,
        "credentials": [],
    }
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert store.credentials_for_origin(ORIGIN) == ()


def test_credentials_are_exact_origin_and_newest_first(tmp_path: Path) -> None:
    path = _private_parent(tmp_path) / "credentials.json"
    _write_document(
        path,
        {
            "version": 1,
            "credentials": [
                _credential(
                    username="old@example.test",
                    password="old-password",
                    saved_at="2026-08-01T12:00:00Z",
                ),
                _credential(
                    username="new@example.test",
                    password="new-password",
                    saved_at="2026-08-03T12:00:00Z",
                ),
                _credential(
                    origin=OTHER_ORIGIN,
                    username="other@example.test",
                    password="other-password",
                    saved_at="2026-08-04T12:00:00Z",
                ),
            ],
        },
    )

    saved = CredentialStore(path).credentials_for_origin(ORIGIN)

    assert [(item.username, item.password) for item in saved] == [
        ("new@example.test", "new-password"),
        ("old@example.test", "old-password"),
    ]
    assert all(item.origin == ORIGIN for item in saved)


@pytest.mark.asyncio
async def test_upsert_replaces_exact_identity_and_retains_other_usernames(
    tmp_path: Path,
) -> None:
    path = _private_parent(tmp_path) / "credentials.json"
    moments = iter(
        [
            datetime(2026, 8, 1, 12, 0, tzinfo=UTC),
            datetime(2026, 8, 2, 12, 0, tzinfo=UTC),
            datetime(2026, 8, 3, 12, 0, tzinfo=UTC),
        ]
    )
    store = CredentialStore(path, clock=lambda: next(moments))

    await store.upsert(ORIGIN, "ada@example.test", "first-password")
    await store.upsert(ORIGIN, "grace@example.test", "grace-password")
    await store.upsert(ORIGIN, "ada@example.test", "replacement-password")

    saved = store.credentials_for_origin(ORIGIN)
    assert [(item.username, item.password) for item in saved] == [
        ("ada@example.test", "replacement-password"),
        ("grace@example.test", "grace-password"),
    ]
    disk = json.loads(path.read_text(encoding="utf-8"))
    assert disk == {
        "version": 1,
        "credentials": [
            {
                "origin": ORIGIN,
                "username": "ada@example.test",
                "password": "replacement-password",
                "saved_at": "2026-08-03T12:00:00.000000Z",
            },
            {
                "origin": ORIGIN,
                "username": "grace@example.test",
                "password": "grace-password",
                "saved_at": "2026-08-02T12:00:00.000000Z",
            },
        ],
    }
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert list(path.parent.glob(f".{path.name}.*.tmp")) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("username", "password"),
    [
        ("ada\x00@example.test", "password"),
        ("ada@example.test", "pass\x00word"),
    ],
)
async def test_upsert_rejects_nul_credentials(
    tmp_path: Path,
    username: str,
    password: str,
) -> None:
    store = CredentialStore(_private_parent(tmp_path) / "credentials.json")
    with pytest.raises(HarnessServiceError) as caught:
        await store.upsert(ORIGIN, username, password)

    assert caught.value.status_code == 409
    assert caught.value.code == "command_conflict"


@pytest.mark.parametrize(
    "document",
    [
        {},
        {"version": 2, "credentials": []},
        {"version": 1, "credentials": [], "extra": True},
        {"version": 1, "credentials": [_credential(origin="https://login.example.test/path")]},
        {"version": 1, "credentials": [_credential(username=" padded@example.test ")]},
        {"version": 1, "credentials": [_credential(username="")]},
        {"version": 1, "credentials": [_credential(username="x" * 321)]},
        {"version": 1, "credentials": [_credential(username="ada\x00@example.test")]},
        {"version": 1, "credentials": [_credential(password="")]},
        {"version": 1, "credentials": [_credential(password="x" * 4_097)]},
        {"version": 1, "credentials": [_credential(password="secret\x00suffix")]},
        {"version": 1, "credentials": [_credential(saved_at="2026-08-03T12:00:00+00:00")]},
        {
            "version": 1,
            "credentials": [_credential(), _credential(password="second-password")],
        },
    ],
)
def test_malformed_or_noncanonical_documents_fail_closed_without_secret_errors(
    tmp_path: Path,
    document: object,
) -> None:
    path = _private_parent(tmp_path) / "credentials.json"
    _write_document(path, document)

    with pytest.raises(
        BrowserConfigurationError,
        match="^The credential store is invalid or unavailable$",
    ) as caught:
        CredentialStore(path)

    message = str(caught.value)
    assert "ada@example.test" not in message
    assert "correct horse battery staple" not in message


def test_document_rejects_more_than_one_thousand_credentials(
    tmp_path: Path,
) -> None:
    path = _private_parent(tmp_path) / "credentials.json"
    _write_document(
        path,
        {
            "version": 1,
            "credentials": [
                _credential(username=f"user-{index}@example.test")
                for index in range(1_001)
            ],
        },
    )

    with pytest.raises(BrowserConfigurationError):
        CredentialStore(path)


@pytest.mark.asyncio
async def test_upsert_rejects_a_new_credential_past_the_entry_limit_atomically(
    tmp_path: Path,
) -> None:
    path = _private_parent(tmp_path) / "credentials.json"
    _write_document(
        path,
        {
            "version": 1,
            "credentials": [
                _credential(username=f"user-{index}@example.test")
                for index in range(1_000)
            ],
        },
    )
    store = CredentialStore(path)
    before = path.read_bytes()

    with pytest.raises(HarnessServiceError) as caught:
        await store.upsert(ORIGIN, "overflow@example.test", "password")

    assert caught.value.status_code == 409
    assert caught.value.code == "command_conflict"
    assert path.read_bytes() == before


def test_duplicate_json_keys_fail_closed(tmp_path: Path) -> None:
    path = _private_parent(tmp_path) / "credentials.json"
    path.write_text('{"version":1,"version":1,"credentials":[]}', encoding="utf-8")
    path.chmod(0o600)

    with pytest.raises(BrowserConfigurationError):
        CredentialStore(path)


def test_unpaired_unicode_surrogates_fail_closed(tmp_path: Path) -> None:
    path = _private_parent(tmp_path) / "credentials.json"
    path.write_bytes(
        b'{"version":1,"credentials":[{"origin":"https://login.example.test",'
        b'"username":"\\ud800","password":"password",'
        b'"saved_at":"2026-08-03T12:00:00Z"}]}'
    )
    path.chmod(0o600)

    with pytest.raises(BrowserConfigurationError):
        CredentialStore(path)


@pytest.mark.parametrize("mode", [0o640, 0o660, 0o644])
def test_existing_credential_file_must_be_exactly_0600(
    tmp_path: Path,
    mode: int,
) -> None:
    path = _private_parent(tmp_path) / "credentials.json"
    _write_document(path, {"version": 1, "credentials": []})
    path.chmod(mode)

    with pytest.raises(BrowserConfigurationError):
        CredentialStore(path)


def test_existing_credential_parent_must_be_exactly_0700(tmp_path: Path) -> None:
    parent = _private_parent(tmp_path)
    path = parent / "credentials.json"
    _write_document(path, {"version": 1, "credentials": []})
    parent.chmod(0o750)

    with pytest.raises(BrowserConfigurationError):
        CredentialStore(path)


def test_symlink_components_nonregular_files_and_oversize_documents_are_rejected(
    tmp_path: Path,
) -> None:
    private = _private_parent(tmp_path, "real-private")
    target = private / "target.json"
    _write_document(target, {"version": 1, "credentials": []})

    linked_file = private / "linked.json"
    linked_file.symlink_to(target)
    with pytest.raises(BrowserConfigurationError):
        CredentialStore(linked_file)

    linked_parent = tmp_path / "linked-private"
    linked_parent.symlink_to(private, target_is_directory=True)
    with pytest.raises(BrowserConfigurationError):
        CredentialStore(linked_parent / "credentials.json")

    directory_target = private / "directory.json"
    directory_target.mkdir(mode=0o700)
    with pytest.raises(BrowserConfigurationError):
        CredentialStore(directory_target)

    oversized = private / "oversized.json"
    oversized.write_bytes(b" " * (8 * 1024 * 1024 + 1))
    oversized.chmod(0o600)
    with pytest.raises(BrowserConfigurationError):
        CredentialStore(oversized)


def test_saved_credential_repr_never_contains_values(tmp_path: Path) -> None:
    path = _private_parent(tmp_path) / "credentials.json"
    _write_document(
        path,
        {"version": 1, "credentials": [_credential()]},
    )

    saved = CredentialStore(path).credentials_for_origin(ORIGIN)[0]

    assert repr(saved) == "SavedCredential(<redacted>)"
    assert saved.username not in repr(saved)
    assert saved.password not in repr(saved)
