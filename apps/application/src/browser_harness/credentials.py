from __future__ import annotations

import asyncio
import json
import os
import re
import stat
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError, field_validator

from .models import HarnessServiceError, validate_approved_origin
from .playwright_cli import BrowserConfigurationError

_MAX_DOCUMENT_BYTES: Final = 8 * 1024 * 1024
_MAX_CREDENTIAL_ENTRIES: Final = 1_000
_TIMESTAMP_PATTERN: Final = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
)
_EMPTY_DOCUMENT_BYTES: Final = b'{"version":1,"credentials":[]}'

def _is_unicode_scalar_text(value: str) -> bool:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


@dataclass(frozen=True, slots=True, repr=False)
class SavedCredential:
    origin: str
    username: str
    password: str
    saved_at: str

    def __repr__(self) -> str:
        return "SavedCredential(<redacted>)"


class _StoredCredential(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    origin: str
    username: SecretStr = Field(repr=False)
    password: SecretStr = Field(repr=False)
    saved_at: str

    @field_validator("origin")
    @classmethod
    def _validate_origin(cls, value: str) -> str:
        canonical = validate_approved_origin(value)
        if canonical != value:
            raise ValueError("origin must be canonical")
        return canonical

    @field_validator("username", mode="before")
    @classmethod
    def _validate_username(cls, value: object) -> SecretStr:
        if (
            not isinstance(value, str)
            or value != value.strip()
            or not 1 <= len(value) <= 320
            or not _is_unicode_scalar_text(value)
            or "\x00" in value
        ):
            raise ValueError("username is invalid")
        return SecretStr(value)

    @field_validator("password", mode="before")
    @classmethod
    def _validate_password(cls, value: object) -> SecretStr:
        if (
            not isinstance(value, str)
            or not 1 <= len(value) <= 4_096
            or not _is_unicode_scalar_text(value)
            or "\x00" in value
        ):
            raise ValueError("password is invalid")
        return SecretStr(value)

    @field_validator("saved_at")
    @classmethod
    def _validate_saved_at(cls, value: str) -> str:
        if not _valid_utc_timestamp(value):
            raise ValueError("saved_at is invalid")
        return value


class _CredentialDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    version: Literal[1]
    credentials: list[_StoredCredential] = Field(
        max_length=_MAX_CREDENTIAL_ENTRIES
    )


class CredentialStore:
    """Own the private, versioned credential document for application origins."""

    def __init__(
        self,
        path: Path,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._path = path.expanduser()
        self._clock = clock or (lambda: datetime.now(UTC))
        self._lock = asyncio.Lock()
        self._initialize()

    def credentials_for_origin(self, origin: str) -> tuple[SavedCredential, ...]:
        try:
            canonical = validate_approved_origin(origin)
            document = self._read_document()
        except Exception as error:
            if isinstance(error, HarnessServiceError):
                raise
            raise _internal_error() from None
        matches = [
            _as_saved_credential(credential)
            for credential in document.credentials
            if credential.origin == canonical
        ]
        matches.sort(key=lambda credential: _parse_timestamp(credential.saved_at), reverse=True)
        return tuple(matches)

    async def upsert(self, origin: str, username: str, password: str) -> None:
        try:
            canonical = validate_approved_origin(origin)
            stored = _StoredCredential(
                origin=canonical,
                username=username,
                password=password,
                saved_at=_utc_timestamp(self._clock()),
            )
        except (TypeError, ValueError, ValidationError):
            raise _conflict_error() from None

        async with self._lock:
            try:
                current = self._read_document()
                identity = (canonical, username)
                remaining = [
                    credential
                    for credential in current.credentials
                    if (
                        credential.origin,
                        credential.username.get_secret_value(),
                    )
                    != identity
                ]
                if len(remaining) >= _MAX_CREDENTIAL_ENTRIES:
                    raise _conflict_error()
                credentials = [stored, *remaining]
                credentials.sort(
                    key=lambda credential: _parse_timestamp(credential.saved_at),
                    reverse=True,
                )
                candidate = _CredentialDocument(version=1, credentials=credentials)
                encoded = _encode_document(candidate)
                self._replace(encoded)
            except HarnessServiceError:
                raise
            except Exception:
                raise _internal_error() from None

    def _initialize(self) -> None:
        try:
            _prepare_private_directory(self._path.parent, create=True)
            if self._path.is_symlink():
                raise ValueError("symbolic link")
            if not self._path.exists():
                self._create_empty_store()
            self._read_document()
        except Exception:
            raise BrowserConfigurationError(
                "The credential store is invalid or unavailable"
            ) from None

    def _create_empty_store(self) -> None:
        descriptor = os.open(
            self._path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _no_follow_flag(),
            0o600,
        )
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=True) as target:
                descriptor = -1
                target.write(_EMPTY_DOCUMENT_BYTES)
                target.flush()
                os.fsync(target.fileno())
            _fsync_directory(self._path.parent)
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    def _read_document(self) -> _CredentialDocument:
        descriptor = _open_private_file(self._path)
        try:
            with os.fdopen(descriptor, "rb", closefd=True) as source:
                descriptor = -1
                encoded = source.read(_MAX_DOCUMENT_BYTES + 1)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        if len(encoded) > _MAX_DOCUMENT_BYTES:
            raise ValueError("document is too large")
        try:
            raw = json.loads(
                encoded,
                object_pairs_hook=_unique_object,
                parse_constant=_reject_json_constant,
            )
            document = _CredentialDocument.model_validate(raw)
        except (UnicodeDecodeError, json.JSONDecodeError, ValidationError, TypeError, ValueError):
            raise ValueError("document is invalid") from None
        identities = [
            (credential.origin, credential.username.get_secret_value())
            for credential in document.credentials
        ]
        if len(identities) != len(set(identities)):
            raise ValueError("document contains duplicate credentials")
        return document

    def _replace(self, encoded: bytes) -> None:
        _prepare_private_directory(self._path.parent, create=False)
        descriptor = _open_private_file(self._path)
        os.close(descriptor)
        temporary_path: Path | None = None
        descriptor = -1
        try:
            descriptor, temporary_name = tempfile.mkstemp(
                dir=self._path.parent,
                prefix=f".{self._path.name}.",
                suffix=".tmp",
            )
            temporary_path = Path(temporary_name)
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=True) as target:
                descriptor = -1
                target.write(encoded)
                target.flush()
                os.fsync(target.fileno())
            target_descriptor = _open_private_file(self._path)
            os.close(target_descriptor)
            os.replace(temporary_path, self._path)
            temporary_path = None
            _fsync_directory(self._path.parent)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass


def _as_saved_credential(value: _StoredCredential) -> SavedCredential:
    return SavedCredential(
        origin=value.origin,
        username=value.username.get_secret_value(),
        password=value.password.get_secret_value(),
        saved_at=value.saved_at,
    )


def _encode_document(document: _CredentialDocument) -> bytes:
    raw = {
        "version": 1,
        "credentials": [
            {
                "origin": credential.origin,
                "username": credential.username.get_secret_value(),
                "password": credential.password.get_secret_value(),
                "saved_at": credential.saved_at,
            }
            for credential in document.credentials
        ],
    }
    encoded = json.dumps(
        raw,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(encoded) > _MAX_DOCUMENT_BYTES:
        raise ValueError("document is too large")
    return encoded


def _utc_timestamp(value: datetime) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("clock must return an aware datetime")
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _valid_utc_timestamp(value: str) -> bool:
    if _TIMESTAMP_PATTERN.fullmatch(value) is None:
        return False
    try:
        return _parse_timestamp(value).utcoffset() == UTC.utcoffset(None)
    except ValueError:
        return False


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.removesuffix("Z") + "+00:00")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> object:
    raise ValueError("invalid JSON constant")


def _prepare_private_directory(path: Path, *, create: bool) -> None:
    lexical = Path(path)
    if ".." in lexical.parts:
        raise ValueError("parent traversal")
    absolute = Path(os.path.abspath(os.fspath(lexical)))
    parts = absolute.parts
    descriptor = os.open(
        parts[0],
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | _no_follow_flag(),
    )
    try:
        for part in parts[1:]:
            next_descriptor: int | None = None
            try:
                try:
                    next_descriptor = os.open(
                        part,
                        os.O_RDONLY
                        | getattr(os, "O_DIRECTORY", 0)
                        | getattr(os, "O_CLOEXEC", 0)
                        | _no_follow_flag(),
                        dir_fd=descriptor,
                    )
                except FileNotFoundError:
                    if not create:
                        raise
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                    next_descriptor = os.open(
                        part,
                        os.O_RDONLY
                        | getattr(os, "O_DIRECTORY", 0)
                        | getattr(os, "O_CLOEXEC", 0)
                        | _no_follow_flag(),
                        dir_fd=descriptor,
                    )
                    os.fchmod(next_descriptor, 0o700)
            except BaseException:
                if next_descriptor is not None:
                    os.close(next_descriptor)
                raise
            if next_descriptor is None:
                raise RuntimeError("failed to open credential directory")
            previous_descriptor = descriptor
            descriptor = next_descriptor
            os.close(previous_descriptor)
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise ValueError("not a directory")
        if stat.S_IMODE(os.fstat(descriptor).st_mode) != 0o700:
            raise ValueError("credential directory is not private")
    finally:
        os.close(descriptor)


def _open_private_file(path: Path) -> int:
    lexical_mode = path.lstat().st_mode
    if (
        not stat.S_ISREG(lexical_mode)
        or stat.S_IMODE(lexical_mode) != 0o600
    ):
        raise ValueError("credential file is not private")
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | _no_follow_flag(),
    )
    try:
        mode = os.fstat(descriptor).st_mode
        if not stat.S_ISREG(mode) or stat.S_IMODE(mode) != 0o600:
            raise ValueError("credential file is not private")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _no_follow_flag() -> int:
    return getattr(os, "O_NOFOLLOW", 0)


def _conflict_error() -> HarnessServiceError:
    return HarnessServiceError(409, "command_conflict", "Credentials were not accepted")


def _internal_error() -> HarnessServiceError:
    return HarnessServiceError(500, "internal_error", "Request failed")


__all__ = ["CredentialStore", "SavedCredential"]
