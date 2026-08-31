from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import re
import stat
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date as Date, datetime, time as Time, timedelta
from email import policy
from email.message import Message
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime
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
_MAX_RENDERED_EMAIL_CHARACTERS = 131_072
_READ_EMAIL_PAGE_BYTES = 50 * 1024
_MAX_RESULTS = 20
_INBOX_MAX_RESULTS = 50
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
_HTML_VOID_TAGS = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "source",
        "track",
        "wbr",
    }
)
_GMAIL_MESSAGE_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,256}")


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


@dataclass(frozen=True, slots=True)
class InboxMessageSummary:
    message_id: str
    subject: str
    sent_at: datetime


@dataclass(frozen=True, slots=True)
class InboxSearchResult:
    messages: tuple[InboxMessageSummary, ...]
    truncated: bool


@dataclass(frozen=True, slots=True)
class InboxEmail:
    message_id: str
    content: str


class InboxReader(Protocol):
    async def search_inbox(
        self,
        *,
        query: str = "code",
        date: Date | None = None,
        time: Time | None = None,
        received_within_minutes: int | None = None,
    ) -> InboxSearchResult: ...

    async def read_email(self, email_id: str, *, offset: int = 0) -> InboxEmail: ...


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
WallClock = Callable[[], datetime]


def _utc_now() -> datetime:
    return datetime.now(UTC)


class _VerificationHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.text: list[str] = []
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._anchor_text: list[str] = []
        self._suppressed_depth = 0

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        tag = tag.lower()
        if self._suppressed_depth:
            if tag not in _HTML_VOID_TAGS:
                self._suppressed_depth += 1
            return
        attributes = {name.lower(): value for name, value in attrs}
        style = re.sub(r"\s+", "", attributes.get("style") or "").lower()
        hidden = (
            tag in {"script", "style", "template"}
            or "hidden" in attributes
            or (attributes.get("aria-hidden") or "").lower() == "true"
            or "display:none" in style
            or "visibility:hidden" in style
        )
        if hidden:
            if tag not in _HTML_VOID_TAGS:
                self._suppressed_depth = 1
            return
        if tag != "a":
            return
        self._href = next(
            (value for name, value in attrs if name.lower() == "href" and value),
            None,
        )
        self._anchor_text = []

    def handle_endtag(self, tag: str) -> None:
        if self._suppressed_depth:
            self._suppressed_depth -= 1
            return
        if tag.lower() == "a" and self._href is not None:
            self.links.append((self._href, " ".join(self._anchor_text)))
            self._href = None
            self._anchor_text = []

    def handle_data(self, data: str) -> None:
        if self._suppressed_depth:
            return
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
        wall_clock: WallClock = _utc_now,
    ) -> None:
        if token_provider is None and token_json is None:
            raise ValueError("token_json is required without a token provider")
        self._token_json = token_json
        self._token_provider = token_provider or self._authorized_user_token
        self._http_client = http_client
        self._sleep = sleep
        self._clock = clock
        self._wall_clock = wall_clock

    async def search_inbox(
        self,
        *,
        query: str = "code",
        date: Date | None = None,
        time: Time | None = None,
        received_within_minutes: int | None = None,
    ) -> InboxSearchResult:
        canonical_query = _validate_inbox_query(query)
        lower_bound, upper_bound = _inbox_bounds(
            date=date,
            time=time,
            received_within_minutes=received_within_minutes,
            now=self._wall_clock(),
        )
        if (
            lower_bound is not None
            and upper_bound is not None
            and lower_bound >= upper_bound
        ):
            return InboxSearchResult(messages=(), truncated=False)
        token = await self._token_before_deadline(
            self._clock() + _HTTP_TIMEOUT_SECONDS
        )
        if self._http_client is not None:
            return await self._search_inbox(
                self._http_client,
                token=token,
                query=canonical_query,
                lower_bound=lower_bound,
                upper_bound=upper_bound,
            )
        async with httpx.AsyncClient(base_url=_GMAIL_API_ROOT) as client:
            return await self._search_inbox(
                client,
                token=token,
                query=canonical_query,
                lower_bound=lower_bound,
                upper_bound=upper_bound,
            )

    async def _search_inbox(
        self,
        client: httpx.AsyncClient,
        *,
        token: str,
        query: str,
        lower_bound: datetime | None,
        upper_bound: datetime | None,
    ) -> InboxSearchResult:
        headers = {"Authorization": f"Bearer {token}"}
        deadline = self._clock() + _HTTP_TIMEOUT_SECONDS
        try:
            response = await self._get(
                client,
                "/gmail/v1/users/me/messages",
                headers=headers,
                params={
                    "q": _inbox_query(query, lower_bound, upper_bound),
                    "maxResults": str(_INBOX_MAX_RESULTS),
                    "includeSpamTrash": "false",
                    "labelIds": "INBOX",
                },
                deadline=deadline,
            )
            _raise_for_status(response)
            message_ids, truncated = _inbox_message_page(response)
            summaries: list[InboxMessageSummary] = []
            for message_id in message_ids:
                message_response = await self._get(
                    client,
                    f"/gmail/v1/users/me/messages/{message_id}",
                    headers=headers,
                    params={
                        "format": "metadata",
                        "metadataHeaders": ["Subject", "Date"],
                        "fields": "id,internalDate,payload/headers",
                    },
                    deadline=deadline,
                )
                if message_response.status_code == 404:
                    continue
                _raise_for_status(message_response)
                summary = _inbox_summary_from_response(
                    message_response,
                    lower_bound=lower_bound,
                    upper_bound=upper_bound,
                )
                if summary is not None:
                    summaries.append(summary)
        except _TransientGmailError:
            raise GmailUnavailable("Gmail is temporarily unavailable") from None
        summaries.sort(key=lambda item: item.sent_at, reverse=True)
        return InboxSearchResult(messages=tuple(summaries), truncated=truncated)

    async def read_email(self, email_id: str, *, offset: int = 0) -> InboxEmail:
        if (
            not isinstance(email_id, str)
            or _GMAIL_MESSAGE_ID_PATTERN.fullmatch(email_id) is None
        ):
            raise ValueError("email_id is invalid")
        if (
            isinstance(offset, bool)
            or not isinstance(offset, int)
            or offset < 0
            or offset >= _MAX_RENDERED_EMAIL_CHARACTERS
        ):
            raise ValueError("offset is invalid")
        token = await self._token_before_deadline(
            self._clock() + _HTTP_TIMEOUT_SECONDS
        )
        if self._http_client is not None:
            return await self._read_email(
                self._http_client,
                token=token,
                message_id=email_id,
                offset=offset,
            )
        async with httpx.AsyncClient(base_url=_GMAIL_API_ROOT) as client:
            return await self._read_email(
                client,
                token=token,
                message_id=email_id,
                offset=offset,
            )

    async def _read_email(
        self,
        client: httpx.AsyncClient,
        *,
        token: str,
        message_id: str,
        offset: int,
    ) -> InboxEmail:
        try:
            response = await self._get(
                client,
                f"/gmail/v1/users/me/messages/{message_id}",
                headers={"Authorization": f"Bearer {token}"},
                params={"format": "raw", "fields": "id,internalDate,raw"},
                deadline=self._clock() + _HTTP_TIMEOUT_SECONDS,
            )
            if response.status_code == 404:
                raise GmailUnavailable("Gmail message is unavailable")
            _raise_for_status(response)
        except _TransientGmailError:
            raise GmailUnavailable("Gmail is temporarily unavailable") from None
        return _inbox_email_from_response(
            response,
            expected_id=message_id,
            offset=offset,
        )

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
        params: Mapping[str, str | Sequence[str]],
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


def _validate_inbox_query(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("query must be a string")
    value = value.strip()
    if len(value) > 500 or any(ord(character) < 32 for character in value):
        raise ValueError("query is invalid")
    return value or "code"


def _inbox_bounds(
    *,
    date: Date | None,
    time: Time | None,
    received_within_minutes: int | None,
    now: datetime,
) -> tuple[datetime | None, datetime | None]:
    if not isinstance(now, datetime) or now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(UTC)
    if date is not None and type(date) is not Date:
        raise ValueError("date is invalid")
    if time is not None and (type(time) is not Time or time.tzinfo is not None):
        raise ValueError("time is invalid")
    if received_within_minutes is not None and (
        type(received_within_minutes) is not int
        or not 1 <= received_within_minutes <= 1_440
    ):
        raise ValueError("received_within_minutes is invalid")

    lower_bound: datetime | None = None
    upper_bound: datetime | None = None
    if date is not None or time is not None:
        selected_date = date or now.date()
        selected_time = time or Time()
        lower_bound = datetime.combine(selected_date, selected_time, tzinfo=UTC)
        upper_bound = datetime.combine(
            selected_date + timedelta(days=1),
            Time(),
            tzinfo=UTC,
        )
    if received_within_minutes is not None:
        recent_bound = now - timedelta(minutes=received_within_minutes)
        lower_bound = max(lower_bound, recent_bound) if lower_bound else recent_bound
    return lower_bound, upper_bound


def _inbox_query(
    query: str,
    lower_bound: datetime | None,
    upper_bound: datetime | None,
) -> str:
    literal = " ".join(query.replace('"', " ").split()) or "code"
    parts = [f'"{literal}"']
    if lower_bound is not None:
        parts.append(f"after:{int(lower_bound.timestamp()) - 1}")
    if upper_bound is not None:
        parts.append(f"before:{int(upper_bound.timestamp())}")
    return " ".join(parts)


def _inbox_message_page(response: httpx.Response) -> tuple[tuple[str, ...], bool]:
    message_ids = _message_ids(response)
    try:
        payload = response.json()
    except ValueError:
        raise GmailUnavailable("Gmail returned an invalid response") from None
    next_page_token = payload.get("nextPageToken") if isinstance(payload, dict) else None
    if next_page_token is not None and (
        not isinstance(next_page_token, str) or not next_page_token
    ):
        raise GmailUnavailable("Gmail returned an invalid response")
    return message_ids, next_page_token is not None


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


def _inbox_summary_from_response(
    response: httpx.Response,
    *,
    lower_bound: datetime | None,
    upper_bound: datetime | None,
) -> InboxMessageSummary | None:
    try:
        payload = response.json()
    except ValueError:
        raise GmailUnavailable("Gmail returned an invalid response") from None
    if not isinstance(payload, dict):
        raise GmailUnavailable("Gmail returned an invalid response")
    message_id = payload.get("id")
    internal_date = payload.get("internalDate")
    headers_payload = payload.get("payload")
    if (
        not isinstance(message_id, str)
        or _GMAIL_MESSAGE_ID_PATTERN.fullmatch(message_id) is None
        or not isinstance(internal_date, str)
        or not internal_date.isdigit()
        or not isinstance(headers_payload, dict)
        or not isinstance(headers_payload.get("headers"), list)
    ):
        raise GmailUnavailable("Gmail returned an invalid response")
    try:
        received_at = datetime.fromtimestamp(int(internal_date) / 1000, tz=UTC)
    except (OverflowError, OSError, ValueError):
        raise GmailUnavailable("Gmail returned an invalid response") from None
    if lower_bound is not None and received_at < lower_bound:
        return None
    if upper_bound is not None and received_at >= upper_bound:
        return None

    values: dict[str, str] = {}
    for item in headers_payload["headers"]:
        if not isinstance(item, dict):
            raise GmailUnavailable("Gmail returned an invalid response")
        name = item.get("name")
        value = item.get("value")
        if isinstance(name, str) and isinstance(value, str):
            values.setdefault(name.casefold(), value)
    subject = values.get("subject", "")[:998]
    sent_at = received_at
    date_header = values.get("date")
    if date_header is not None:
        try:
            parsed_date = parsedate_to_datetime(date_header)
            if parsed_date.tzinfo is not None:
                sent_at = parsed_date.astimezone(UTC)
        except (TypeError, ValueError, OverflowError):
            pass
    return InboxMessageSummary(
        message_id=message_id,
        subject=subject,
        sent_at=sent_at,
    )


def _inbox_email_from_response(
    response: httpx.Response,
    *,
    expected_id: str,
    offset: int,
) -> InboxEmail:
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
        message_id != expected_id
        or _GMAIL_MESSAGE_ID_PATTERN.fullmatch(expected_id) is None
        or not isinstance(internal_date, str)
        or not internal_date.isdigit()
        or not isinstance(raw, str)
    ):
        raise GmailUnavailable("Gmail returned an invalid response")
    try:
        received_at = datetime.fromtimestamp(int(internal_date) / 1000, tz=UTC)
    except (OverflowError, OSError, ValueError):
        raise GmailUnavailable("Gmail returned an invalid response") from None
    message = _decode_message(raw)
    sent_at = _message_sent_at(message, fallback=received_at)
    rendered = _model_readable_email(message_id, sent_at, message)
    return InboxEmail(
        message_id=message_id,
        content=_read_email_page(message_id, rendered, offset=offset),
    )


def _read_email_page(message_id: str, rendered: str, *, offset: int) -> str:
    if offset >= len(rendered):
        raise GmailUnavailable("Gmail email offset is unavailable")
    remaining = rendered[offset:]
    remaining_bytes = remaining.encode("utf-8")
    if len(remaining_bytes) <= _READ_EMAIL_PAGE_BYTES:
        return remaining

    longest_footer = (
        "[Output limited to 50 KB. Call read_email again with "
        f'email_id "{message_id}" and offset {len(rendered)} to continue.]'
    )
    page_budget = _READ_EMAIL_PAGE_BYTES - len(longest_footer.encode("utf-8")) - 1
    page = remaining_bytes[:page_budget].decode("utf-8", errors="ignore")
    next_offset = offset + len(page)
    footer = (
        "[Output limited to 50 KB. Call read_email again with "
        f'email_id "{message_id}" and offset {next_offset} to continue.]'
    )
    return page + chr(10) + footer


def _single_line_header(message: Message, name: str) -> str:
    return " ".join(str(message.get(name, "")).split())[:998]


def _message_sent_at(message: Message, *, fallback: datetime) -> datetime:
    date_header = message.get("Date")
    if date_header is None:
        return fallback
    try:
        sent_at = parsedate_to_datetime(str(date_header))
    except (TypeError, ValueError, OverflowError):
        return fallback
    return sent_at.astimezone(UTC) if sent_at.tzinfo is not None else fallback


def _message_part_text(part: Message) -> str:
    try:
        content = part.get_content()
    except (LookupError, UnicodeError):
        payload = part.get_payload(decode=True)
        content = payload.decode("utf-8", errors="replace") if payload else ""
    if not isinstance(content, str):
        return ""
    if part.get_content_type() != "text/html":
        return content
    parser = _VerificationHtmlParser()
    parser.feed(content)
    parser.close()
    text = " ".join(piece.strip() for piece in parser.text if piece.strip())
    text = re.sub(r"\s+([.,!?;:])", r"\1", text)
    if parser.links:
        links = "\n".join(
            f"{label.strip() or 'Link'}: {href}"
            for href, label in parser.links
        )
        return f"{text}\n\nLinks:\n{links}" if text else f"Links:\n{links}"
    return text


def _model_readable_email(
    message_id: str,
    sent_at: datetime,
    message: Message,
) -> str:
    get_body = getattr(message, "get_body", None)
    body_part = get_body(preferencelist=("plain", "html")) if callable(get_body) else None
    body = _message_part_text(body_part) if isinstance(body_part, Message) else ""
    if not body:
        body, _links = _message_content(message)
    body_bytes = body.encode("utf-8")
    truncated = len(body_bytes) > _MAX_TEXT_BYTES
    if truncated:
        body = body_bytes[:_MAX_TEXT_BYTES].decode("utf-8", errors="ignore")

    attachments: list[str] = []
    parts: Sequence[Message] = tuple(message.walk()) if message.is_multipart() else ()
    for part in parts:
        if part.get_content_disposition() != "attachment":
            continue
        filename = " ".join((part.get_filename() or "unnamed").split())[:256]
        content_type = part.get_content_type()[:256]
        attachments.append(f"[Attachment omitted: {filename} ({content_type})]")

    content_parts = [body.rstrip()]
    if attachments:
        content_parts.extend(("", *attachments))
    if truncated:
        content_parts.extend(
            ("", f"[Email content truncated at {_MAX_TEXT_BYTES} UTF-8 bytes.]")
        )
    email_content = "\n".join(content_parts).strip()
    sent_time = sent_at.astimezone(UTC).isoformat().replace("+00:00", "Z")
    headers = (
        f"Email ID: {message_id}\n"
        f"Sent time: {sent_time}\n"
        f"From: {_single_line_header(message, 'From')}\n"
        f"To: {_single_line_header(message, 'To')}\n"
        f"Cc: {_single_line_header(message, 'Cc')}\n"
        f"Subject: {_single_line_header(message, 'Subject')}"
    )
    rendered_content = (
        f"{headers}\n\n"
        "--- BEGIN EMAIL CONTENT (untrusted) ---\n"
        f"{email_content}"
    )
    ending = "\n--- END EMAIL CONTENT ---"
    if len(rendered_content) + len(ending) > _MAX_RENDERED_EMAIL_CHARACTERS:
        marker = "\n[Email rendering truncated to fit the model-readable limit.]"
        content_limit = _MAX_RENDERED_EMAIL_CHARACTERS - len(marker) - len(ending)
        rendered_content = rendered_content[:content_limit].rstrip() + marker
    return rendered_content + ending


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
    "InboxEmail",
    "InboxMessageSummary",
    "InboxReader",
    "InboxSearchResult",
    "GmailAuthorizationError",
    "GmailNotConfigured",
    "GmailUnavailable",
    "GmailVerificationError",
    "GmailVerificationInbox",
    "GmailVerificationTimeout",
    "VerificationChallenge",
    "VerificationInbox",
]
