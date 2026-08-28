from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
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
    assert list_params["includeSpamTrash"] == "true"
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
    message.set_content("Confirmation code: 739204")
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
            not_before=not_before,
            timeout_seconds=10,
        )

    assert challenge.message_id == "recent"
    assert challenge.codes == ("739204",)
    assert list_calls == 2
    assert get_calls == ["stale", "recent"]


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
            not_before=datetime(2026, 8, 28, 12, 0, tzinfo=UTC),
            timeout_seconds=1,
        )

    assert "private" not in str(raised.value)
