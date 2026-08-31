from __future__ import annotations

import base64
import json
import re
from datetime import UTC, date, datetime, time, timedelta
from email.message import EmailMessage
from pathlib import Path

import httpx
import pytest

from jobhunter_browser_harness.gmail_verification import (
    GmailAuthorizationError,
    GmailNotConfigured,
    GmailVerificationInbox,
)


@pytest.mark.asyncio
async def test_readonly_gmail_poll_returns_recent_verification_challenge() -> None:
    not_before = datetime(2026, 8, 28, 12, 0, tzinfo=UTC)
    message = EmailMessage()
    message["From"] = "Example Jobs <accounts@jobs.example>"
    message["To"] = "candidate@example.test"
    message["Subject"] = "Verify your email"
    message.set_content(
        "Verification code: 482913\n"
        "Verify your email at https://jobs.example/verify?token=private-token"
    )
    encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/messages"):
            return httpx.Response(200, json={"messages": [{"id": "message-1"}]})
        assert request.url.path.endswith("/messages/message-1")
        return httpx.Response(
            200,
            json={
                "id": "message-1",
                "internalDate": str(
                    int((not_before + timedelta(seconds=1)).timestamp() * 1000)
                ),
                "raw": encoded,
            },
        )

    async def token_provider() -> str:
        return "access-token"

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        inbox = GmailVerificationInbox(
            token_provider=token_provider,
            http_client=client,
        )
        challenge = await inbox.wait_for_challenge(
            recipient="candidate@example.test",
            expected_origin="https://jobs.example",
            not_before=not_before,
            timeout_seconds=1,
        )

    assert challenge.message_id == "message-1"
    assert challenge.received_at == not_before + timedelta(seconds=1)
    assert challenge.sender == "Example Jobs <accounts@jobs.example>"
    assert challenge.subject == "Verify your email"
    assert challenge.urls == (
        "https://jobs.example/verify?token=private-token",
    )
    assert challenge.codes == ("482913",)
    assert [request.method for request in requests] == ["GET", "GET"]
    assert all(
        request.headers["Authorization"] == "Bearer access-token"
        for request in requests
    )
    list_params = requests[0].url.params
    assert list_params["maxResults"] == "20"
    assert list_params["includeSpamTrash"] == "false"
    assert list_params["q"].startswith(
        f"after:{int(not_before.timestamp()) - 1} "
    )
    get_params = requests[1].url.params
    assert get_params["format"] == "raw"
    assert get_params["fields"] == "id,internalDate,raw"


@pytest.mark.asyncio
async def test_missing_gmail_token_is_lazy_and_reports_not_configured(
    tmp_path: Path,
) -> None:
    token_path = tmp_path / "private" / "gmail-token.json"
    inbox = GmailVerificationInbox(token_path)

    assert token_path.exists() is False
    with pytest.raises(GmailNotConfigured, match="not configured"):
        await inbox.wait_for_challenge(
            recipient="candidate@example.test",
            expected_origin="https://jobs.example",
            not_before=datetime(2026, 8, 28, 12, 0, tzinfo=UTC),
            timeout_seconds=1,
        )


@pytest.mark.asyncio
async def test_poll_ignores_stale_message_and_returns_new_arrival() -> None:
    not_before = datetime(2026, 8, 28, 12, 0, tzinfo=UTC)
    message = EmailMessage()
    message["From"] = "accounts@jobs.example"
    message["To"] = "candidate@example.test"
    message["Subject"] = "Confirmation code"
    message.set_content(
        "Confirmation code: 739204\n"
        "https://jobs.example/verify?token=recent-token"
    )
    encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")
    now = 0.0
    list_calls = 0
    get_calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal list_calls
        if request.url.path.endswith("/messages"):
            list_calls += 1
            message_id = "stale" if list_calls == 1 else "recent"
            return httpx.Response(200, json={"messages": [{"id": message_id}]})
        message_id = request.url.path.rsplit("/", 1)[-1]
        get_calls.append(message_id)
        received_at = (
            not_before - timedelta(milliseconds=1)
            if message_id == "stale"
            else not_before + timedelta(seconds=2)
        )
        return httpx.Response(
            200,
            json={
                "id": message_id,
                "internalDate": str(int(received_at.timestamp() * 1000)),
                "raw": encoded,
            },
        )

    async def token_provider() -> str:
        return "access-token"

    def clock() -> float:
        return now

    async def sleep(delay: float) -> None:
        nonlocal now
        now += delay

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        challenge = await GmailVerificationInbox(
            token_provider=token_provider,
            http_client=client,
            clock=clock,
            sleep=sleep,
        ).wait_for_challenge(
            recipient="candidate@example.test",
            expected_origin="https://jobs.example",
            not_before=not_before,
            timeout_seconds=10,
        )

    assert challenge.message_id == "recent"
    assert challenge.codes == ("739204",)
    assert list_calls == 2
    assert get_calls == ["stale", "recent"]


@pytest.mark.asyncio
async def test_poll_ignores_newer_challenge_for_an_unrelated_origin() -> None:
    not_before = datetime(2026, 8, 28, 12, 0, tzinfo=UTC)
    encoded_messages: dict[str, str] = {}
    for message_id, origin, code in (
        ("unrelated", "https://unrelated.example", "111111"),
        ("correct", "https://jobs.example", "482913"),
    ):
        message = EmailMessage()
        message["From"] = f"accounts@{origin.removeprefix('https://')}"
        message["To"] = "candidate@example.test"
        message["Subject"] = "Verification code"
        message.set_content(
            f"Verification code: {code}\n{origin}/verify?token={message_id}"
        )
        encoded_messages[message_id] = base64.urlsafe_b64encode(
            message.as_bytes()
        ).decode("ascii").rstrip("=")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/messages"):
            return httpx.Response(
                200,
                json={"messages": [{"id": "unrelated"}, {"id": "correct"}]},
            )
        message_id = request.url.path.rsplit("/", 1)[-1]
        offset = 2 if message_id == "unrelated" else 1
        return httpx.Response(
            200,
            json={
                "id": message_id,
                "internalDate": str(
                    int((not_before + timedelta(seconds=offset)).timestamp() * 1000)
                ),
                "raw": encoded_messages[message_id],
            },
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        challenge = await GmailVerificationInbox(
            token_provider=_access_token,
            http_client=client,
        ).wait_for_challenge(
            recipient="candidate@example.test",
            expected_origin="https://jobs.example",
            not_before=not_before,
            timeout_seconds=1,
        )

    assert challenge.message_id == "correct"
    assert challenge.codes == ("482913",)


@pytest.mark.asyncio
async def test_poll_retries_message_after_transient_fetch_failure() -> None:
    not_before = datetime(2026, 8, 28, 12, 0, tzinfo=UTC)
    message = EmailMessage()
    message["From"] = "accounts@jobs.example"
    message["To"] = "candidate@example.test"
    message["Subject"] = "Verify email"
    message.set_content(
        "Verification code: 482913\nhttps://jobs.example/verify?token=retry"
    )
    encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")
    now = 0.0
    get_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal get_calls
        if request.url.path.endswith("/messages"):
            return httpx.Response(200, json={"messages": [{"id": "retry"}]})
        get_calls += 1
        if get_calls == 1:
            return httpx.Response(503)
        return httpx.Response(
            200,
            json={
                "id": "retry",
                "internalDate": str(
                    int((not_before + timedelta(seconds=1)).timestamp() * 1000)
                ),
                "raw": encoded,
            },
        )

    def clock() -> float:
        return now

    async def sleep(delay: float) -> None:
        nonlocal now
        now += delay

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        challenge = await GmailVerificationInbox(
            token_provider=_access_token,
            http_client=client,
            clock=clock,
            sleep=sleep,
        ).wait_for_challenge(
            recipient="candidate@example.test",
            expected_origin="https://jobs.example",
            not_before=not_before,
            timeout_seconds=10,
        )

    assert challenge.message_id == "retry"
    assert get_calls == 2


async def _access_token() -> str:
    return "access-token"


@pytest.mark.asyncio
async def test_gmail_token_rejects_any_scope_beyond_readonly(tmp_path: Path) -> None:
    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    token_path = private / "gmail-token.json"
    token_path.write_text(
        json.dumps(
            {
                "client_id": "private-client-id",
                "client_secret": "private-client-secret",
                "refresh_token": "private-refresh-token",
                "type": "authorized_user",
                "scopes": ["https://www.googleapis.com/auth/gmail.modify"],
            }
        ),
        encoding="utf-8",
    )
    token_path.chmod(0o600)

    with pytest.raises(GmailAuthorizationError) as raised:
        await GmailVerificationInbox(token_path).wait_for_challenge(
            recipient="candidate@example.test",
            expected_origin="https://jobs.example",
            not_before=datetime(2026, 8, 28, 12, 0, tzinfo=UTC),
            timeout_seconds=1,
        )

    assert "private" not in str(raised.value)


@pytest.mark.asyncio
async def test_search_inbox_defaults_to_code_and_returns_bounded_summaries() -> None:
    received = datetime(2026, 8, 30, 14, 22, 3, tzinfo=UTC)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/messages"):
            return httpx.Response(
                200,
                json={
                    "messages": [{"id": "message-1"}],
                    "nextPageToken": "private-page-token",
                },
            )
        assert request.url.path.endswith("/messages/message-1")
        return httpx.Response(
            200,
            json={
                "id": "message-1",
                "internalDate": str(int(received.timestamp() * 1000)),
                "payload": {
                    "headers": [
                        {"name": "Subject", "value": "Your verification code"},
                        {"name": "Date", "value": "Sun, 30 Aug 2026 10:22:03 -0400"},
                    ]
                },
            },
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        result = await GmailVerificationInbox(
            token_provider=_access_token,
            http_client=client,
        ).search_inbox(
            query="   ",
            date=date(2026, 8, 30),
            time=time(14, 0),
            received_within_minutes=None,
        )

    assert result.truncated is True
    assert len(result.messages) == 1
    summary = result.messages[0]
    assert summary.message_id == "message-1"
    assert summary.subject == "Your verification code"
    assert summary.sent_at == received
    list_request, message_request = requests
    assert list_request.url.params["maxResults"] == "50"
    assert list_request.url.params["includeSpamTrash"] == "false"
    assert list_request.url.params.get_list("labelIds") == ["INBOX"]
    assert '"code"' in list_request.url.params["q"]
    assert message_request.url.params["format"] == "metadata"
    assert message_request.url.params.get_list("metadataHeaders") == ["Subject", "Date"]


@pytest.mark.asyncio
async def test_search_inbox_intersects_utc_date_time_and_recent_bounds() -> None:
    now = datetime(2026, 8, 30, 15, 0, tzinfo=UTC)
    queries: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/messages")
        queries.append(request.url.params["q"])
        return httpx.Response(200, json={"messages": []})

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        inbox = GmailVerificationInbox(
            token_provider=_access_token,
            http_client=client,
            wall_clock=lambda: now,
        )
        await inbox.search_inbox(
            query="verification",
            date=date(2026, 8, 30),
            time=time(14, 45),
            received_within_minutes=30,
        )
        await inbox.search_inbox(
            query="verification",
            time=time(13, 0),
        )
        await inbox.search_inbox(
            query="verification",
            received_within_minutes=1_440,
        )
        with pytest.raises(ValueError, match="received_within_minutes"):
            await inbox.search_inbox(
                query="verification",
                received_within_minutes=1_441,
            )

    assert queries == [
        (
            '"verification" '
            f"after:{int(datetime(2026, 8, 30, 14, 45, tzinfo=UTC).timestamp()) - 1} "
            f"before:{int(datetime(2026, 8, 31, tzinfo=UTC).timestamp())}"
        ),
        (
            '"verification" '
            f"after:{int(datetime(2026, 8, 30, 13, 0, tzinfo=UTC).timestamp()) - 1} "
            f"before:{int(datetime(2026, 8, 31, tzinfo=UTC).timestamp())}"
        ),
        (
            '"verification" '
            f"after:{int(datetime(2026, 8, 29, 15, 0, tzinfo=UTC).timestamp()) - 1}"
        ),
    ]


@pytest.mark.asyncio
async def test_search_inbox_filters_messages_newer_than_relative_cutoff() -> None:
    now = datetime(2026, 8, 30, 15, 0, tzinfo=UTC)
    received_times = {
        "message-older": datetime(2026, 8, 30, 14, 30, tzinfo=UTC),
        "message-newer": datetime(2026, 8, 30, 14, 50, tzinfo=UTC),
    }
    queries: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/messages"):
            queries.append(request.url.params["q"])
            return httpx.Response(
                200,
                json={"messages": [{"id": message_id} for message_id in received_times]},
            )
        message_id = request.url.path.rsplit("/", 1)[-1]
        received = received_times[message_id]
        return httpx.Response(
            200,
            json={
                "id": message_id,
                "internalDate": str(int(received.timestamp() * 1000)),
                "payload": {
                    "headers": [
                        {"name": "Subject", "value": message_id},
                        {"name": "Date", "value": "Sun, 30 Aug 2026 14:30:00 +0000"},
                    ]
                },
            },
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        inbox = GmailVerificationInbox(
            token_provider=_access_token,
            http_client=client,
            wall_clock=lambda: now,
        )
        result = await inbox.search_inbox(
            query="verification",
            received_within_minutes=60,
            received_before_minutes_ago=15,
        )
        with pytest.raises(ValueError, match="received_before_minutes_ago"):
            await inbox.search_inbox(received_before_minutes_ago=1_441)

    assert [message.message_id for message in result.messages] == ["message-older"]
    assert queries == [
        (
            '"verification" '
            f"after:{int(datetime(2026, 8, 30, 14, 0, tzinfo=UTC).timestamp()) - 1} "
            f"before:{int(datetime(2026, 8, 30, 14, 45, tzinfo=UTC).timestamp())}"
        )
    ]


@pytest.mark.asyncio
async def test_read_email_parses_mime_into_bounded_untrusted_content() -> None:
    received = datetime(2026, 8, 30, 14, 30, tzinfo=UTC)
    message = EmailMessage()
    message["From"] = "Example Jobs <accounts@jobs.example>"
    message["To"] = "candidate@example.test"
    message["Subject"] = "Your verification code"
    message["Date"] = "Sun, 30 Aug 2026 10:22:03 -0400"
    message.set_content("Your code is 482913.\n")
    message.add_alternative("<p>Your code is <b>482913</b>.</p>", subtype="html")
    message.add_attachment(
        b"private-binary-content",
        maintype="application",
        subtype="pdf",
        filename="offer.pdf",
    )
    encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/messages/message-1")
        assert request.url.params["format"] == "raw"
        return httpx.Response(
            200,
            json={
                "id": "message-1",
                "internalDate": str(int(received.timestamp() * 1000)),
                "raw": encoded,
            },
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        result = await GmailVerificationInbox(
            token_provider=_access_token,
            http_client=client,
        ).read_email("message-1")

    assert result.message_id == "message-1"
    assert "Sent time: 2026-08-30T14:22:03Z" in result.content
    assert "Subject: Your verification code" in result.content
    assert "--- BEGIN EMAIL CONTENT (untrusted) ---" in result.content
    assert "Your code is 482913." in result.content
    assert "[Attachment omitted: offer.pdf (application/pdf)]" in result.content
    assert "private-binary-content" not in result.content
    assert result.content.endswith("--- END EMAIL CONTENT ---")


@pytest.mark.asyncio
async def test_read_email_omits_hidden_html_and_bounds_the_complete_render() -> None:
    received = datetime(2026, 8, 30, 14, 30, tzinfo=UTC)
    message = EmailMessage()
    message["From"] = "accounts@jobs.example"
    message["To"] = "candidate@example.test"
    message["Subject"] = "HTML verification"
    message["Date"] = "Sun, 30 Aug 2026 10:22:03 -0400"
    message.set_content(
        "<style>hidden-style-instruction</style>"
        "<script>hidden-script-instruction</script>"
        "<p>Your visible code is <b>482913</b>.</p>"
        f"<p>{'x' * 102_000}</p>",
        subtype="html",
    )
    for index in range(120):
        message.add_attachment(
            b"x",
            maintype="application",
            subtype="octet-stream",
            filename=f"{index:03d}-{'a' * 240}.bin",
        )
    encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "message-html",
                "internalDate": str(int(received.timestamp() * 1000)),
                "raw": encoded,
            },
        )

    rendered_pages: list[str] = []
    offset = 0
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        inbox = GmailVerificationInbox(
            token_provider=_access_token,
            http_client=client,
        )
        for _ in range(4):
            result = await inbox.read_email("message-html", offset=offset)
            continuation = re.search(
                r'\n\[Output limited to 50 KB\. Call read_email again with '
                r'email_id "message-html" and offset ([1-9][0-9]*) to continue\.\]$',
                result.content,
            )
            if continuation is None:
                rendered_pages.append(result.content)
                break
            rendered_pages.append(result.content[: continuation.start()])
            next_offset = int(continuation.group(1))
            assert next_offset > offset
            offset = next_offset
        else:
            pytest.fail("read_email did not reach the final page")

    rendered = "".join(rendered_pages)
    assert "Your visible code is 482913." in rendered
    assert "hidden-style-instruction" not in rendered
    assert "hidden-script-instruction" not in rendered
    assert len(rendered) <= 131_072
    assert "[Email rendering truncated to fit the model-readable limit.]" in rendered
    assert rendered.endswith("--- END EMAIL CONTENT ---")


@pytest.mark.asyncio
async def test_read_email_pages_large_render_with_actionable_fifty_kilobyte_limit() -> None:
    received = datetime(2026, 8, 30, 14, 30, tzinfo=UTC)
    message = EmailMessage()
    message["From"] = "accounts@jobs.example"
    message["To"] = "candidate@example.test"
    message["Subject"] = "Long verification email"
    message["Date"] = "Sun, 30 Aug 2026 10:22:03 -0400"
    message.set_content("🙂" * 16_000)
    encoded = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "message-large",
                "internalDate": str(int(received.timestamp() * 1000)),
                "raw": encoded,
            },
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://gmail.googleapis.com",
    ) as client:
        inbox = GmailVerificationInbox(
            token_provider=_access_token,
            http_client=client,
        )
        first = await inbox.read_email("message-large")
        continuation = re.search(
            r'\n\[Output limited to 50 KB\. Call read_email again with '
            r'email_id "message-large" and offset ([1-9][0-9]*) to continue\.\]$',
            first.content,
        )
        assert continuation is not None
        second = await inbox.read_email(
            "message-large",
            offset=int(continuation.group(1)),
        )

    assert len(first.content.encode("utf-8")) <= 50 * 1024
    assert not first.content.endswith("--- END EMAIL CONTENT ---")
    assert len(second.content.encode("utf-8")) <= 50 * 1024
    assert "[Output limited to 50 KB." not in second.content
    assert second.content.endswith("--- END EMAIL CONTENT ---")
