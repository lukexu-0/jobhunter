from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import stat
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol, cast
from urllib.parse import parse_qs, urlsplit

import httpx

from .gmail_verification import (
    GMAIL_READONLY_SCOPE,
    GmailVerificationError,
    _read_authorized_user_info,
)
from .models import (
    GmailAuthIdentity,
    GmailAuthSession,
    GmailAuthStatus,
    HarnessServiceError,
)

_SESSION_LIFETIME = timedelta(minutes=10)
_MAX_CLIENT_BYTES = 65_536
_MAX_TOKEN_BYTES = 65_536
_MAX_RETAINED_SESSIONS = 128
_OPAQUE_VALUE = re.compile(r"^[A-Za-z0-9_-]{43}$")
_ALLOWED_INSTALLED_KEYS = frozenset(
    {
        "auth_provider_x509_cert_url",
        "auth_uri",
        "client_id",
        "client_secret",
        "project_id",
        "redirect_uris",
        "token_uri",
    }
)


class OAuthCredentials(Protocol):
    token: str | None
    scopes: list[str] | tuple[str, ...] | None

    def to_json(self) -> str: ...


class OAuthFlow(Protocol):
    @property
    def credentials(self) -> OAuthCredentials: ...

    def authorization_url(self) -> tuple[str, str]: ...

    def fetch_token(self, *, code: str) -> None: ...


FlowFactory = Callable[[dict[str, object], str, str], OAuthFlow]
IdentityFetcher = Callable[[str], Awaitable[str]]
Clock = Callable[[], datetime]


@dataclass(slots=True, repr=False)
class _OAuthSession:
    id: str
    state_digest: bytes
    state: str
    expires_at: datetime
    authorization_url: str | None
    flow: OAuthFlow | None
    generation: int


class _GoogleOAuthFlow:
    __slots__ = ("_flow",)

    def __init__(self, flow: Any) -> None:
        self._flow = flow

    @property
    def credentials(self) -> OAuthCredentials:
        return cast(OAuthCredentials, self._flow.credentials)

    def authorization_url(self) -> tuple[str, str]:
        url, state = self._flow.authorization_url(
            access_type="offline",
            include_granted_scopes="false",
            prompt="consent",
        )
        return cast(str, url), cast(str, state)

    def fetch_token(self, *, code: str) -> None:
        self._flow.fetch_token(code=code)


class GmailOAuthManager:
    """Own short-lived Desktop OAuth sessions and the private Gmail token file."""

    def __init__(
        self,
        *,
        client_json: Path,
        token_json: Path,
        redirect_uri: str,
        flow_factory: FlowFactory | None = None,
        identity_fetcher: IdentityFetcher | None = None,
        clock: Clock | None = None,
    ) -> None:
        parsed_redirect = urlsplit(redirect_uri)
        if (
            parsed_redirect.scheme != "http"
            or parsed_redirect.hostname != "127.0.0.1"
            or parsed_redirect.port is None
            or parsed_redirect.path != "/oauth/gmail/callback"
            or parsed_redirect.query
            or parsed_redirect.fragment
            or parsed_redirect.username is not None
            or parsed_redirect.password is not None
        ):
            raise ValueError("redirect_uri must be the fixed loopback Gmail callback")
        self._client_json = client_json.expanduser()
        self._token_json = token_json.expanduser()
        self._redirect_uri = redirect_uri
        self._flow_factory = flow_factory or _default_flow_factory
        self._identity_fetcher = identity_fetcher or _fetch_gmail_identity
        self._clock = clock or (lambda: datetime.now(UTC))
        self._lock = asyncio.Lock()
        self._sessions: dict[str, _OAuthSession] = {}
        self._states: dict[bytes, str] = {}
        self._identity: str | None = None
        self._generation = 0

    async def status(self) -> GmailAuthStatus:
        async with self._lock:
            try:
                await asyncio.to_thread(
                    _read_authorized_user_info,
                    self._token_json,
                )
            except GmailVerificationError:
                self._identity = None
                return GmailAuthStatus(state="disconnected")
            identity = self._identity
            return GmailAuthStatus(
                state="connected",
                identity=(
                    GmailAuthIdentity(email=identity)
                    if identity is not None
                    else None
                ),
            )

    async def start(self) -> GmailAuthSession:
        async with self._lock:
            now = self._now()
            self._expire_sessions(now)
            self._cancel_pending_sessions()
            self._prune_sessions()
            try:
                client_config = await asyncio.to_thread(
                    _read_desktop_client_config,
                    self._client_json,
                )
                session_id = secrets.token_urlsafe(32)
                state = secrets.token_urlsafe(32)
                if not _valid_opaque_value(session_id) or not _valid_opaque_value(state):
                    raise RuntimeError("secure random generator returned an invalid value")
                flow = self._flow_factory(client_config, state, self._redirect_uri)
                authorization_url, returned_state = flow.authorization_url()
                if not secrets.compare_digest(returned_state, state):
                    raise ValueError("OAuth state mismatch")
                _validate_authorization_url(authorization_url, state)
            except Exception:
                raise HarnessServiceError(
                    503,
                    "gmail_oauth_unavailable",
                    "Gmail connection is unavailable",
                ) from None
            expires_at = now + _SESSION_LIFETIME
            state_digest = _state_digest(state)
            session = _OAuthSession(
                id=session_id,
                state_digest=state_digest,
                state="pending",
                expires_at=expires_at,
                authorization_url=authorization_url,
                flow=flow,
                generation=self._generation,
            )
            self._sessions[session_id] = session
            self._states[state_digest] = session_id
            return _public_session(session, include_authorization_url=True)

    async def get_session(self, session_id: str) -> GmailAuthSession:
        async with self._lock:
            self._expire_sessions(self._now())
            session = self._sessions.get(session_id)
            if session is None:
                raise HarnessServiceError(
                    404,
                    "gmail_auth_session_not_found",
                    "Gmail authorization session not found",
                )
            return _public_session(session, include_authorization_url=False)

    async def complete_callback(
        self,
        *,
        state: str | None,
        code: str | None,
        error: str | None,
    ) -> bool:
        if not _valid_opaque_value(state):
            return False
        if code is not None and (not 1 <= len(code) <= 4_096 or "\x00" in code):
            return False
        if error is not None and (not 1 <= len(error) <= 256 or "\x00" in error):
            return False

        digest = _state_digest(state)
        async with self._lock:
            now = self._now()
            self._expire_sessions(now)
            session_id = self._states.pop(digest, None)
            session = self._sessions.get(session_id) if session_id is not None else None
            if (
                session is None
                or session.state != "pending"
                or not secrets.compare_digest(session.state_digest, digest)
            ):
                return False
            session.state_digest = b""
            flow = session.flow
            session.flow = None
            session.authorization_url = None
            if error is not None or code is None or flow is None:
                session.state = "failed"
                return False
            generation = session.generation

        try:
            await asyncio.to_thread(flow.fetch_token, code=code)
            credentials = flow.credentials
            encoded = _authorized_user_json(credentials)
            identity: str | None = None
            token = credentials.token
            if isinstance(token, str) and token:
                try:
                    identity = _redact_email(await self._identity_fetcher(token))
                except Exception:
                    identity = None
        except Exception:
            async with self._lock:
                current = self._sessions.get(session_id)
                if current is not None and current.state == "pending":
                    current.state = "failed"
            return False

        async with self._lock:
            current = self._sessions.get(session_id)
            now = self._now()
            if (
                current is None
                or current.state != "pending"
                or generation != self._generation
            ):
                return False
            if now >= current.expires_at:
                current.state = "expired"
                return False
            try:
                await asyncio.to_thread(_atomic_write_token, self._token_json, encoded)
            except Exception:
                current.state = "failed"
                return False
            current.state = "succeeded"
            self._identity = identity
            return True

    async def disconnect(self) -> None:
        async with self._lock:
            self._generation += 1
            self._cancel_pending_sessions()
            self._identity = None
            try:
                await asyncio.to_thread(_remove_token, self._token_json)
            except Exception:
                raise HarnessServiceError(
                    500,
                    "internal_error",
                    "Request failed",
                ) from None

    async def shutdown(self) -> None:
        async with self._lock:
            self._generation += 1
            self._cancel_pending_sessions()

    def _now(self) -> datetime:
        value = self._clock()
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise RuntimeError("OAuth clock must return an aware datetime")
        return value.astimezone(UTC)

    def _expire_sessions(self, now: datetime) -> None:
        for session in self._sessions.values():
            if session.state == "pending" and now >= session.expires_at:
                self._states.pop(session.state_digest, None)
                session.state_digest = b""
                session.state = "expired"
                session.authorization_url = None
                session.flow = None

    def _cancel_pending_sessions(self) -> None:
        for session in self._sessions.values():
            if session.state == "pending":
                self._states.pop(session.state_digest, None)
                session.state_digest = b""
                session.state = "failed"
                session.authorization_url = None
                session.flow = None

    def _prune_sessions(self) -> None:
        excess = len(self._sessions) - _MAX_RETAINED_SESSIONS + 1
        if excess <= 0:
            return
        terminal_ids = [
            session_id
            for session_id, session in self._sessions.items()
            if session.state != "pending"
        ]
        for session_id in terminal_ids[:excess]:
            del self._sessions[session_id]


def _default_flow_factory(
    client_config: dict[str, object],
    state: str,
    redirect_uri: str,
) -> OAuthFlow:
    from google_auth_oauthlib.flow import Flow

    flow = Flow.from_client_config(
        client_config,
        scopes=[GMAIL_READONLY_SCOPE],
        state=state,
        autogenerate_code_verifier=True,
    )
    flow.redirect_uri = redirect_uri
    return _GoogleOAuthFlow(flow)


async def _fetch_gmail_identity(access_token: str) -> str:
    headers = {"authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(
        base_url="https://gmail.googleapis.com",
        timeout=10.0,
    ) as client:
        response = await client.get(
            "/gmail/v1/users/me/profile",
            headers=headers,
            params={"fields": "emailAddress"},
        )
    if response.status_code != 200:
        raise ValueError("Gmail profile is unavailable")
    value = response.json()
    email = value.get("emailAddress") if isinstance(value, dict) else None
    if not isinstance(email, str):
        raise ValueError("Gmail profile is invalid")
    return email


def _read_desktop_client_config(path: Path) -> dict[str, object]:
    raw = _read_private_json(path, _MAX_CLIENT_BYTES)
    if not isinstance(raw, dict) or set(raw) != {"installed"}:
        raise ValueError("OAuth client must be a Desktop client")
    installed = raw.get("installed")
    if not isinstance(installed, dict) or not set(installed) <= _ALLOWED_INSTALLED_KEYS:
        raise ValueError("OAuth client is invalid")
    if installed.get("auth_uri") != "https://accounts.google.com/o/oauth2/auth":
        raise ValueError("OAuth authorization endpoint is invalid")
    if installed.get("token_uri") != "https://oauth2.googleapis.com/token":
        raise ValueError("OAuth token endpoint is invalid")
    client_id = installed.get("client_id")
    client_secret = installed.get("client_secret")
    if (
        not _safe_string(client_id, minimum=16, maximum=512)
        or not cast(str, client_id).endswith(".apps.googleusercontent.com")
        or not _safe_string(client_secret, minimum=8, maximum=2_048)
    ):
        raise ValueError("OAuth client credentials are invalid")
    redirect_uris = installed.get("redirect_uris")
    if (
        not isinstance(redirect_uris, list)
        or not 1 <= len(redirect_uris) <= 10
        or not all(_valid_desktop_redirect_uri(value) for value in redirect_uris)
    ):
        raise ValueError("OAuth client redirect URIs are invalid")
    for optional in ("project_id", "auth_provider_x509_cert_url"):
        value = installed.get(optional)
        if value is not None and not _safe_string(value, minimum=1, maximum=2_048):
            raise ValueError("OAuth client is invalid")
    return {"installed": dict(installed)}


def _read_private_json(path: Path, maximum_bytes: int) -> object:
    lexical = path.expanduser()
    parent_details = lexical.parent.stat(follow_symlinks=False)
    if not stat.S_ISDIR(parent_details.st_mode) or stat.S_IMODE(parent_details.st_mode) != 0o700:
        raise ValueError("private directory is invalid")
    descriptor = os.open(
        lexical,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or stat.S_IMODE(details.st_mode) != 0o600
            or details.st_size > maximum_bytes
        ):
            raise ValueError("private file is invalid")
        with os.fdopen(descriptor, "rb", closefd=True) as source:
            descriptor = -1
            encoded = source.read(maximum_bytes + 1)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(encoded) > maximum_bytes:
        raise ValueError("private file is too large")
    return json.loads(
        encoded,
        object_pairs_hook=_unique_object,
        parse_constant=_reject_json_constant,
    )


def _authorized_user_json(credentials: OAuthCredentials) -> bytes:
    scopes = credentials.scopes
    if scopes is None or list(scopes) != [GMAIL_READONLY_SCOPE]:
        raise ValueError("OAuth grant did not contain the exact Gmail scope")
    raw = json.loads(
        credentials.to_json(),
        object_pairs_hook=_unique_object,
        parse_constant=_reject_json_constant,
    )
    if not isinstance(raw, dict):
        raise ValueError("authorized user credentials are invalid")
    raw["type"] = "authorized_user"
    raw["scopes"] = [GMAIL_READONLY_SCOPE]
    required = ("refresh_token", "token_uri", "client_id", "client_secret")
    if not all(_safe_string(raw.get(key), minimum=1, maximum=8_192) for key in required):
        raise ValueError("authorized user credentials are incomplete")
    if raw.get("token_uri") != "https://oauth2.googleapis.com/token":
        raise ValueError("authorized user token endpoint is invalid")
    encoded = json.dumps(
        raw,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    if len(encoded) > _MAX_TOKEN_BYTES:
        raise ValueError("authorized user credentials are too large")
    return encoded


def _atomic_write_token(path: Path, encoded: bytes) -> None:
    parent = path.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent_details = parent.stat(follow_symlinks=False)
    if not stat.S_ISDIR(parent_details.st_mode) or stat.S_IMODE(parent_details.st_mode) != 0o700:
        raise ValueError("token directory is not private")
    if path.exists() or path.is_symlink():
        _validate_existing_token_path(path)
    descriptor = -1
    temporary_path: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            dir=parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        )
        temporary_path = Path(temporary_name)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as target:
            descriptor = -1
            target.write(encoded)
            target.flush()
            os.fsync(target.fileno())
        if path.exists() or path.is_symlink():
            _validate_existing_token_path(path)
        os.replace(temporary_path, path)
        temporary_path = None
        _fsync_directory(parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def _remove_token(path: Path) -> None:
    try:
        parent_details = path.parent.stat(follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(parent_details.st_mode) or stat.S_IMODE(parent_details.st_mode) != 0o700:
        raise ValueError("token directory is not private")
    try:
        details = path.lstat()
    except FileNotFoundError:
        return
    if not (stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode)):
        raise ValueError("token path is invalid")
    path.unlink()
    _fsync_directory(path.parent)


def _validate_existing_token_path(path: Path) -> None:
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or stat.S_IMODE(details.st_mode) != 0o600:
        raise ValueError("token path is not a private regular file")
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or stat.S_IMODE(opened.st_mode) != 0o600:
            raise ValueError("token path is not a private regular file")
    finally:
        os.close(descriptor)


def _public_session(
    session: _OAuthSession,
    *,
    include_authorization_url: bool,
) -> GmailAuthSession:
    return GmailAuthSession(
        id=session.id,
        state=cast(Any, session.state),
        authorization_url=(
            session.authorization_url if include_authorization_url else None
        ),
        expires_at=session.expires_at,
    )


def _validate_authorization_url(value: str, state: str) -> None:
    if len(value) > 8_192 or any(ord(character) < 32 for character in value):
        raise ValueError("authorization URL is invalid")
    parsed = urlsplit(value)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "accounts.google.com"
        or parsed.username is not None
        or parsed.password is not None
        or query.get("state") != [state]
        or "client_secret" in query
    ):
        raise ValueError("authorization URL is invalid")


def _valid_desktop_redirect_uri(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 2_048:
        return False
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return (
        parsed.scheme == "http"
        and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        and parsed.username is None
        and parsed.password is None
        and parsed.query == ""
        and parsed.fragment == ""
        and parsed.path in {"", "/"}
    )


def _redact_email(value: str) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or len(value) > 320
        or value.count("@") != 1
        or any(ord(character) < 32 for character in value)
    ):
        raise ValueError("email is invalid")
    local, domain = value.split("@", 1)
    labels = domain.split(".")
    if not local or not labels[0] or any(not label for label in labels):
        raise ValueError("email is invalid")
    redacted_local = local[0] + "***"
    redacted_domain = labels[0][0] + "***"
    if len(labels) > 1:
        redacted_domain += "." + labels[-1]
    return f"{redacted_local}@{redacted_domain}"


def _state_digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("ascii")).digest()


def _valid_opaque_value(value: object) -> bool:
    return isinstance(value, str) and _OPAQUE_VALUE.fullmatch(value) is not None


def _safe_string(value: object, *, minimum: int, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and minimum <= len(value) <= maximum
        and "\x00" not in value
        and not any(ord(character) < 32 for character in value)
    )


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> object:
    raise ValueError("invalid JSON constant")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(
        path,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


__all__ = ["GmailOAuthManager"]
