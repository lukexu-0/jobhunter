from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import re
import stat
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from email import policy
from email.message import Message
from email.parser import BytesParser
from email.utils import getaddresses
from html.parser import HTMLParser
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

import httpx

from .models import validate_approved_origin


GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
_GMAIL_API_ROOT = "https://gmail.googleapis.com"
_MAX_TOKEN_BYTES = 65_536
_MAX_RAW_MESSAGE_BYTES = 2_097_152
_MAX_TEXT_BYTES = 102_400
_MAX_RESULTS = 20
_HTTP_TIMEOUT_SECONDS = 10.0
_POLL_INTERVAL_SECONDS = 3.0
_VERIFICATION_TERMS = (
    "verify",
    "verification",
    "confirm",
    "confirmation",
    "activate",
    "security",
    "one-time",
    "one time",
    "otp",
    "code",
)
_URL_PATTERN = re.compile(r"https://[^\s<>\"']+", re.IGNORECASE)
_CODE_PATTERNS = (
    re.compile(
        r"\b(?:verification|confirmation|security|one[- ]time|otp)\s+"
        r"(?:code\s*)?(?:is\s*)?[:#-]?\s*([A-Z0-9]{4,10})\b",
        re.IGNORECASE,
    ),
    re.compile(r"\bcode\s*(?:is\s*)?[:#-]\s*([A-Z0-9]{4,10})\b", re.IGNORECASE),
)
_RECIPIENT_PATTERN = re.compile(
    r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?"
)


class GmailVerificationError(RuntimeError):
    """Base class for sanitized Gmail verification failures."""


class GmailNotConfigured(GmailVerificationError):
    pass


class GmailAuthorizationError(GmailVerificationError):
    pass


class GmailVerificationTimeout(GmailVerificationError):
    pass


class GmailUnavailable(GmailVerificationError):
    pass


@dataclass(frozen=True, slots=True)
class VerificationChallenge:
    message_id: str
    received_at: datetime
    sender: str
    subject: str
    urls: tuple[str, ...]
    codes: tuple[str, ...]


def _challenge_matches_origin(
    challenge: VerificationChallenge,
    expected_origin: str,
) -> bool:
    for url in challenge.urls:
        parsed = urlsplit(url)
        try:
            origin = validate_approved_origin(f"{parsed.scheme}://{parsed.netloc}")
        except (TypeError, ValueError):
            continue
        if origin == expected_origin:
            return True
    return False


class VerificationInbox(Protocol):
    async def wait_for_challenge(
        self,
        *,
        recipient: str,
        expected_origin: str,
        not_before: datetime,
        timeout_seconds: int,
    ) -> VerificationChallenge: ...


TokenProvider = Callable[[], Awaitable[str]]
Sleep = Callable[[float], Awaitable[None]]
Clock = Callable[[], float]


class _VerificationHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.text: list[str] = []
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._anchor_text: list[str] = []

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        if tag.lower() != "a":
            return
        self._href = next(
            (value for name, value in attrs if name.lower() == "href" and value),
            None,
        )
        self._anchor_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href is not None:
            self.links.append((self._href, " ".join(self._anchor_text)))
            self._href = None
            self._anchor_text = []

    def handle_data(self, data: str) -> None:
        self.text.append(data)
        if self._href is not None:
            self._anchor_text.append(data)


class GmailVerificationInbox:
    def __init__(
        self,
        token_json: Path | None = None,
        *,
        token_provider: TokenProvider | None = None,
        http_client: httpx.AsyncClient | None = None,
        sleep: Sleep = asyncio.sleep,
        clock: Clock = time.monotonic,
    ) -> None:
        if token_provider is None and token_json is None:
            raise ValueError("token_json is required without a token provider")
        self._token_json = token_json
        self._token_provider = token_provider or self._authorized_user_token
        self._http_client = http_client
        self._sleep = sleep
        self._clock = clock

    async def wait_for_challenge(
        self,
        *,
        recipient: str,
        expected_origin: str,
        not_before: datetime,
        timeout_seconds: int,
    ) -> VerificationChallenge:
        canonical_recipient = _validate_recipient(recipient)
        canonical_origin = validate_approved_origin(expected_origin)
        if not isinstance(not_before, datetime) or not_before.tzinfo is None:
            raise ValueError("not_before must be timezone-aware")
        not_before = not_before.astimezone(UTC)
        if type(timeout_seconds) is not int or timeout_seconds < 1:
            raise ValueError("timeout_seconds must be positive")
        deadline = self._clock() + timeout_seconds
        token = await self._token_before_deadline(deadline)
        if self._http_client is not None:
            return await self._poll(
                self._http_client,
                token=token,
                recipient=canonical_recipient,
                expected_origin=canonical_origin,
                not_before=not_before,
                deadline=deadline,
            )
        async with httpx.AsyncClient(base_url=_GMAIL_API_ROOT) as client:
            return await self._poll(
                client,
                token=token,
                recipient=canonical_recipient,
                expected_origin=canonical_origin,
                not_before=not_before,
                deadline=deadline,
            )

    async def _token_before_deadline(self, deadline: float) -> str:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise GmailVerificationTimeout("Verification email did not arrive in time")
        try:
            async with asyncio.timeout(remaining):
                token = await self._token_provider()
        except TimeoutError:
            raise GmailVerificationTimeout(
                "Verification email did not arrive in time"
            ) from None
        except GmailVerificationError:
            raise
        except Exception:
            raise GmailAuthorizationError(
                "Gmail authorization is unavailable"
            ) from None
        if not isinstance(token, str) or not token:
            raise GmailAuthorizationError("Gmail authorization is unavailable")
        return token

    async def _poll(
        self,
        client: httpx.AsyncClient,
        *,
        token: str,
        recipient: str,
        expected_origin: str,
        not_before: datetime,
        deadline: float,
    ) -> VerificationChallenge:
        seen: set[str] = set()
        transient_failure = False
        headers = {"Authorization": f"Bearer {token}"}
        query = _gmail_query(recipient, not_before)
        while True:
            try:
                response = await self._get(
                    client,
                    "/gmail/v1/users/me/messages",
                    headers=headers,
                    params={
                        "q": query,
                        "maxResults": str(_MAX_RESULTS),
                        "includeSpamTrash": "false",
                    },
                    deadline=deadline,
                )
                _raise_for_status(response)
                message_ids = _message_ids(response)
                candidates: list[VerificationChallenge] = []
                for message_id in message_ids:
                    if message_id in seen:
                        continue
                    try:
                        message_response = await self._get(
                            client,
                            f"/gmail/v1/users/me/messages/{message_id}",
                            headers=headers,
                            params={"format": "raw", "fields": "id,internalDate,raw"},
                            deadline=deadline,
                        )
                        if message_response.status_code == 404:
                            seen.add(message_id)
                            continue
                        _raise_for_status(message_response)
                        challenge = _challenge_from_response(
                            message_response,
                            recipient=recipient,
                            not_before=not_before,
                        )
                    except _TransientGmailError:
                        transient_failure = True
                        continue
                    seen.add(message_id)
                    if challenge is not None and _challenge_matches_origin(
                        challenge,
                        expected_origin,
                    ):
                        candidates.append(challenge)
                if candidates:
                    return max(candidates, key=lambda candidate: candidate.received_at)
            except _TransientGmailError:
                transient_failure = True

            remaining = deadline - self._clock()
            if remaining <= 0:
                if transient_failure:
                    raise GmailUnavailable("Gmail is temporarily unavailable")
                raise GmailVerificationTimeout(
                    "Verification email did not arrive in time"
                )
            await self._sleep(min(_POLL_INTERVAL_SECONDS, remaining))
            if self._clock() >= deadline:
                if transient_failure:
                    raise GmailUnavailable("Gmail is temporarily unavailable")
                raise GmailVerificationTimeout(
                    "Verification email did not arrive in time"
                )

    async def _get(
        self,
        client: httpx.AsyncClient,
        path: str,
        *,
        headers: dict[str, str],
        params: dict[str, str],
        deadline: float,
    ) -> httpx.Response:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise GmailVerificationTimeout("Verification email did not arrive in time")
        try:
            async with asyncio.timeout(min(_HTTP_TIMEOUT_SECONDS, remaining)):
                return await client.get(path, headers=headers, params=params)
        except TimeoutError:
            raise _TransientGmailError from None
        except httpx.TransportError:
            raise _TransientGmailError from None

    async def _authorized_user_token(self) -> str:
        token_json = self._token_json
        if token_json is None:
            raise GmailNotConfigured("Gmail verification is not configured")
        info = await asyncio.to_thread(_read_authorized_user_info, token_json)

        def refresh() -> str:
            try:
                from google.auth.transport.requests import Request
                from google.oauth2.credentials import Credentials

                credentials = Credentials.from_authorized_user_info(
                    info,
                    scopes=[GMAIL_READONLY_SCOPE],
                )
                if not credentials.valid:
                    credentials.refresh(Request())
                token = credentials.token
            except Exception:
                raise GmailAuthorizationError(
                    "Gmail authorization is unavailable"
                ) from None
            if not isinstance(token, str) or not token:
                raise GmailAuthorizationError("Gmail authorization is unavailable")
            return token

        return await asyncio.to_thread(refresh)


class _TransientGmailError(Exception):
    pass


def _validate_recipient(value: str) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or len(value) > 320
        or _RECIPIENT_PATTERN.fullmatch(value) is None
    ):
        raise ValueError("recipient is invalid")
    return value.lower()


def _gmail_query(recipient: str, not_before: datetime) -> str:
    floor_epoch = int(not_before.timestamp()) - 1
    terms = (
        "subject:verify subject:verification subject:confirm subject:confirmation "
        'subject:activate subject:code "verify your email" "confirm your email" '
        '"verification code" "confirmation code" "one-time code"'
    )
    return (
        f"after:{floor_epoch} {{to:{recipient} deliveredto:{recipient}}} "
        f"{{{terms}}}"
    )


def _raise_for_status(response: httpx.Response) -> None:
    if response.status_code in {401, 403}:
        raise GmailAuthorizationError("Gmail authorization is unavailable")
    if response.status_code == 429 or response.status_code >= 500:
        raise _TransientGmailError
    if not 200 <= response.status_code < 300:
        raise GmailUnavailable("Gmail is unavailable")


def _message_ids(response: httpx.Response) -> tuple[str, ...]:
    try:
        payload = response.json()
    except ValueError:
        raise GmailUnavailable("Gmail returned an invalid response") from None
    if not isinstance(payload, dict):
        raise GmailUnavailable("Gmail returned an invalid response")
    messages = payload.get("messages", [])
    if not isinstance(messages, list):
        raise GmailUnavailable("Gmail returned an invalid response")
    ids: list[str] = []
    for item in messages:
        if not isinstance(item, dict):
            raise GmailUnavailable("Gmail returned an invalid response")
        message_id = item.get("id")
        if not isinstance(message_id, str) or not message_id or len(message_id) > 256:
            raise GmailUnavailable("Gmail returned an invalid response")
        ids.append(message_id)
    return tuple(ids)


def _challenge_from_response(
    response: httpx.Response,
    *,
    recipient: str,
    not_before: datetime,
) -> VerificationChallenge | None:
    try:
        payload = response.json()
    except ValueError:
        raise GmailUnavailable("Gmail returned an invalid response") from None
    if not isinstance(payload, dict):
        raise GmailUnavailable("Gmail returned an invalid response")
    message_id = payload.get("id")
    internal_date = payload.get("internalDate")
    raw = payload.get("raw")
    if (
        not isinstance(message_id, str)
        or not message_id
        or len(message_id) > 256
        or not isinstance(internal_date, str)
        or not internal_date.isdigit()
        or not isinstance(raw, str)
    ):
        raise GmailUnavailable("Gmail returned an invalid response")
    try:
        received_at = datetime.fromtimestamp(int(internal_date) / 1000, tz=UTC)
    except (OverflowError, OSError, ValueError):
        raise GmailUnavailable("Gmail returned an invalid response") from None
    if received_at < not_before:
        return None
    message = _decode_message(raw)
    if not _message_targets_recipient(message, recipient):
        return None
    text, html_links = _message_content(message)
    subject = str(message.get("Subject", ""))[:998]
    sender = str(message.get("From", ""))[:998]
    urls = _verification_urls(text, html_links, subject)
    codes = _verification_codes(f"{subject}\n{text}")
    if not urls and not codes:
        return None
    return VerificationChallenge(
        message_id=message_id,
        received_at=received_at,
        sender=sender,
        subject=subject,
        urls=urls,
        codes=codes,
    )


def _decode_message(raw: str) -> Message:
    if len(raw) > (_MAX_RAW_MESSAGE_BYTES * 4 // 3) + 8:
        raise GmailUnavailable("Gmail message is too large")
    try:
        padding = "=" * (-len(raw) % 4)
        decoded = base64.b64decode(raw + padding, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError):
        raise GmailUnavailable("Gmail returned an invalid message") from None
    if len(decoded) > _MAX_RAW_MESSAGE_BYTES:
        raise GmailUnavailable("Gmail message is too large")
    try:
        return BytesParser(policy=policy.default).parsebytes(decoded)
    except Exception:
        raise GmailUnavailable("Gmail returned an invalid message") from None


def _message_targets_recipient(message: Message, recipient: str) -> bool:
    values: list[str] = []
    for name in ("to", "delivered-to", "x-original-to"):
        values.extend(str(value) for value in message.get_all(name, []))
    addresses = {address.lower() for _name, address in getaddresses(values)}
    return recipient in addresses


def _message_content(message: Message) -> tuple[str, tuple[tuple[str, str], ...]]:
    text_parts: list[str] = []
    links: list[tuple[str, str]] = []
    used = 0
    parts: Sequence[Message] = tuple(message.walk()) if message.is_multipart() else (message,)
    for part in parts:
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        if part.get_content_type() not in {"text/plain", "text/html"}:
            continue
        try:
            content = part.get_content()
        except (LookupError, UnicodeError):
            payload = part.get_payload(decode=True)
            content = payload.decode("utf-8", errors="replace") if payload else ""
        if not isinstance(content, str):
            continue
        remaining = _MAX_TEXT_BYTES - used
        if remaining <= 0:
            break
        content = content[:remaining]
        used += len(content)
        if part.get_content_type() == "text/html":
            parser = _VerificationHtmlParser()
            parser.feed(content)
            parser.close()
            text_parts.extend(parser.text)
            links.extend(parser.links)
        else:
            text_parts.append(content)
    return "\n".join(text_parts), tuple(links)


def _verification_urls(
    text: str,
    html_links: Sequence[tuple[str, str]],
    subject: str,
) -> tuple[str, ...]:
    candidates: list[tuple[str, str]] = list(html_links)
    for match in _URL_PATTERN.finditer(text):
        context = text[max(0, match.start() - 100) : match.end() + 20]
        candidates.append((match.group(0).rstrip(".,);]}>"), context))
    result: list[str] = []
    seen: set[str] = set()
    for url, context in candidates:
        try:
            parsed = urlsplit(url)
        except ValueError:
            continue
        searchable = f"{subject} {context} {parsed.path} {parsed.query}".lower()
        if (
            parsed.scheme != "https"
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or not any(term in searchable for term in _VERIFICATION_TERMS)
            or url in seen
        ):
            continue
        seen.add(url)
        result.append(url)
    return tuple(result)


def _verification_codes(text: str) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for pattern in _CODE_PATTERNS:
        for match in pattern.finditer(text):
            code = match.group(1).upper()
            if not any(character.isdigit() for character in code) or code in seen:
                continue
            seen.add(code)
            result.append(code)
    return tuple(result)


def _read_authorized_user_info(path: Path) -> dict[str, object]:
    lexical = Path(path).expanduser()
    try:
        parent = lexical.parent
        parent_details = parent.stat(follow_symlinks=False)
        if not stat.S_ISDIR(parent_details.st_mode) or stat.S_IMODE(parent_details.st_mode) != 0o700:
            raise GmailAuthorizationError("Gmail authorization is unavailable")
        descriptor = os.open(
            lexical,
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
        )
    except FileNotFoundError:
        raise GmailNotConfigured("Gmail verification is not configured") from None
    except GmailVerificationError:
        raise
    except OSError:
        raise GmailAuthorizationError("Gmail authorization is unavailable") from None
    try:
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or stat.S_IMODE(details.st_mode) != 0o600
            or details.st_size > _MAX_TOKEN_BYTES
        ):
            raise GmailAuthorizationError("Gmail authorization is unavailable")
        data = os.read(descriptor, _MAX_TOKEN_BYTES + 1)
        if len(data) > _MAX_TOKEN_BYTES:
            raise GmailAuthorizationError("Gmail authorization is unavailable")
    finally:
        os.close(descriptor)
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise GmailAuthorizationError("Gmail authorization is unavailable") from None
    if not isinstance(value, dict):
        raise GmailAuthorizationError("Gmail authorization is unavailable")
    scopes = value.get("scopes")
    if scopes != [GMAIL_READONLY_SCOPE]:
        raise GmailAuthorizationError("Gmail authorization is unavailable")
    return value


__all__ = [
    "GMAIL_READONLY_SCOPE",
    "GmailAuthorizationError",
    "GmailNotConfigured",
    "GmailUnavailable",
    "GmailVerificationError",
    "GmailVerificationInbox",
    "GmailVerificationTimeout",
    "VerificationChallenge",
    "VerificationInbox",
]
