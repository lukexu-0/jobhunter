from __future__ import annotations

import asyncio
import json
import stat
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from jobhunter_browser_harness.gmail_oauth import GmailOAuthManager
from jobhunter_browser_harness.models import HarnessServiceError
from jobhunter_browser_harness.gmail_verification import GMAIL_READONLY_SCOPE


NOW = datetime(2026, 8, 31, 12, 0, tzinfo=UTC)


@dataclass(slots=True)
class FakeCredentials:
    token: str = "private-access-token"
    scopes: tuple[str, ...] = (GMAIL_READONLY_SCOPE,)

    def to_json(self) -> str:
        return json.dumps(
            {
                "token": self.token,
                "refresh_token": "private-refresh-token",
                "token_uri": "https://oauth2.googleapis.com/token",
                "client_id": "desktop-client.apps.googleusercontent.com",
                "client_secret": "private-client-secret",
                "scopes": list(self.scopes),
                "type": "authorized_user",
            }
        )


class FakeFlow:
    def __init__(self, state: str) -> None:
        self.state = state
        self.credentials = FakeCredentials()
        self.fetch_codes: list[str] = []

    def authorization_url(self) -> tuple[str, str]:
        return (
            "https://accounts.google.com/o/oauth2/v2/auth"
            f"?client_id=desktop-client.apps.googleusercontent.com&state={self.state}",
            self.state,
        )

    def fetch_token(self, *, code: str) -> None:
        self.fetch_codes.append(code)


class FakeFlowFactory:
    def __init__(self) -> None:
        self.flows: list[FakeFlow] = []
        self.calls: list[tuple[dict[str, object], str, str]] = []

    def __call__(
        self,
        client_config: dict[str, object],
        state: str,
        redirect_uri: str,
    ) -> FakeFlow:
        self.calls.append((client_config, state, redirect_uri))
        flow = FakeFlow(state)
        self.flows.append(flow)
        return flow


def write_client_config(path: Path) -> None:
    path.parent.mkdir(mode=0o700)
    path.parent.chmod(0o700)
    path.write_text(
        json.dumps(
            {
                "installed": {
                    "client_id": "desktop-client.apps.googleusercontent.com",
                    "project_id": "jobhunter-local",
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
                    "client_secret": "private-client-secret",
                    "redirect_uris": ["http://localhost"],
                }
            }
        ),
        encoding="utf-8",
    )
    path.chmod(0o600)


@pytest.mark.asyncio
async def test_desktop_oauth_success_writes_the_existing_readonly_token_contract(
    tmp_path: Path,
) -> None:
    client_path = tmp_path / "oauth" / "client.json"
    token_path = tmp_path / "token" / "gmail-token.json"
    write_client_config(client_path)
    factory = FakeFlowFactory()

    async def identity(_access_token: str) -> str:
        return "Alex.Example@example.com"

    manager = GmailOAuthManager(
        client_json=client_path,
        token_json=token_path,
        redirect_uri="http://127.0.0.1:8765/oauth/gmail/callback",
        flow_factory=factory,
        identity_fetcher=identity,
        clock=lambda: NOW,
    )

    created = await manager.start()
    query = parse_qs(urlsplit(created.authorization_url).query)
    assert created.state == "pending"
    assert created.expires_at == NOW + timedelta(minutes=10)
    assert query["state"] == [factory.calls[0][1]]
    assert factory.calls[0][2] == "http://127.0.0.1:8765/oauth/gmail/callback"

    succeeded = await manager.complete_callback(
        state=factory.calls[0][1],
        code="one-time-private-code",
        error=None,
    )

    assert succeeded is True
    assert factory.flows[0].fetch_codes == ["one-time-private-code"]
    assert stat.S_IMODE(token_path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(token_path.stat().st_mode) == 0o600
    token = json.loads(token_path.read_text(encoding="utf-8"))
    assert token["scopes"] == [GMAIL_READONLY_SCOPE]
    assert token["refresh_token"] == "private-refresh-token"
    assert await manager.get_session(created.id) == created.model_copy(
        update={"state": "succeeded", "authorization_url": None}
    )
    status = await manager.status()
    assert status.model_dump(exclude_none=True) == {
        "state": "connected",
        "identity": {"email": "L***@e***.com"},
    }
@pytest.mark.asyncio
async def test_oauth_client_must_be_a_private_desktop_file_without_leaking_secrets(
    tmp_path: Path,
) -> None:
    client_path = tmp_path / "oauth" / "client.json"
    token_path = tmp_path / "token" / "gmail-token.json"
    write_client_config(client_path)
    client_path.chmod(0o644)
    manager = GmailOAuthManager(
        client_json=client_path,
        token_json=token_path,
        redirect_uri="http://127.0.0.1:8765/oauth/gmail/callback",
        flow_factory=FakeFlowFactory(),
        clock=lambda: NOW,
    )

    with pytest.raises(HarnessServiceError) as raised:
        await manager.start()

    assert raised.value.status_code == 503
    assert raised.value.code == "gmail_oauth_unavailable"
    assert raised.value.public_message == "Gmail connection is unavailable"
    assert "private-client-secret" not in str(raised.value)
@pytest.mark.asyncio
async def test_expired_state_is_one_time_and_never_exchanges_the_code(
    tmp_path: Path,
) -> None:
    client_path = tmp_path / "oauth" / "client.json"
    write_client_config(client_path)
    current = [NOW]
    factory = FakeFlowFactory()
    manager = GmailOAuthManager(
        client_json=client_path,
        token_json=tmp_path / "token" / "gmail-token.json",
        redirect_uri="http://127.0.0.1:8765/oauth/gmail/callback",
        flow_factory=factory,
        clock=lambda: current[0],
    )
    created = await manager.start()
    state = factory.calls[0][1]
    current[0] += timedelta(minutes=10)

    assert await manager.complete_callback(state=state, code="private-code", error=None) is False
    assert (await manager.get_session(created.id)).state == "expired"
    assert await manager.complete_callback(state=state, code="private-code", error=None) is False
    assert factory.flows[0].fetch_codes == []
@pytest.mark.asyncio
async def test_disconnect_wins_over_an_in_flight_callback_exchange(
    tmp_path: Path,
) -> None:
    client_path = tmp_path / "oauth" / "client.json"
    token_path = tmp_path / "token" / "gmail-token.json"
    write_client_config(client_path)
    factory = FakeFlowFactory()
    manager = GmailOAuthManager(
        client_json=client_path,
        token_json=token_path,
        redirect_uri="http://127.0.0.1:8765/oauth/gmail/callback",
        flow_factory=factory,
        clock=lambda: NOW,
    )
    created = await manager.start()
    started = threading.Event()
    release = threading.Event()

    def blocked_fetch(*, code: str) -> None:
        assert code == "private-code"
        started.set()
        assert release.wait(timeout=2)

    factory.flows[0].fetch_token = blocked_fetch  # type: ignore[method-assign]
    callback = asyncio.create_task(
        manager.complete_callback(
            state=factory.calls[0][1],
            code="private-code",
            error=None,
        )
    )
    assert await asyncio.to_thread(started.wait, 1)

    await manager.disconnect()
    release.set()

    assert await callback is False
    assert not token_path.exists()
    assert (await manager.get_session(created.id)).state == "failed"
    assert (await manager.status()).state == "disconnected"
@pytest.mark.asyncio
async def test_callback_rejects_any_grant_broader_than_the_sole_readonly_scope(
    tmp_path: Path,
) -> None:
    client_path = tmp_path / "oauth" / "client.json"
    token_path = tmp_path / "token" / "gmail-token.json"
    write_client_config(client_path)
    factory = FakeFlowFactory()
    manager = GmailOAuthManager(
        client_json=client_path,
        token_json=token_path,
        redirect_uri="http://127.0.0.1:8765/oauth/gmail/callback",
        flow_factory=factory,
        clock=lambda: NOW,
    )
    created = await manager.start()
    factory.flows[0].credentials.scopes = (
        GMAIL_READONLY_SCOPE,
        "https://www.googleapis.com/auth/gmail.modify",
    )

    assert (
        await manager.complete_callback(
            state=factory.calls[0][1],
            code="private-code",
            error=None,
        )
        is False
    )
    assert not token_path.exists()
    assert (await manager.get_session(created.id)).state == "failed"
@pytest.mark.asyncio
async def test_new_session_and_shutdown_cancel_previous_pending_authorizations(
    tmp_path: Path,
) -> None:
    client_path = tmp_path / "oauth" / "client.json"
    write_client_config(client_path)
    factory = FakeFlowFactory()
    manager = GmailOAuthManager(
        client_json=client_path,
        token_json=tmp_path / "token" / "gmail-token.json",
        redirect_uri="http://127.0.0.1:8765/oauth/gmail/callback",
        flow_factory=factory,
        clock=lambda: NOW,
    )

    first = await manager.start()
    second = await manager.start()
    assert (await manager.get_session(first.id)).state == "failed"
    assert (await manager.get_session(second.id)).state == "pending"

    await manager.shutdown()
    assert (await manager.get_session(second.id)).state == "failed"
    assert (
        await manager.complete_callback(
            state=factory.calls[1][1],
            code="private-code",
            error=None,
        )
        is False
    )
@pytest.mark.asyncio
async def test_provider_cancellation_fails_the_session_without_exchanging_a_code(
    tmp_path: Path,
) -> None:
    client_path = tmp_path / "oauth" / "client.json"
    write_client_config(client_path)
    factory = FakeFlowFactory()
    manager = GmailOAuthManager(
        client_json=client_path,
        token_json=tmp_path / "token" / "gmail-token.json",
        redirect_uri="http://127.0.0.1:8765/oauth/gmail/callback",
        flow_factory=factory,
        clock=lambda: NOW,
    )
    created = await manager.start()

    assert (
        await manager.complete_callback(
            state=factory.calls[0][1],
            code=None,
            error="access_denied",
        )
        is False
    )
    assert (await manager.get_session(created.id)).state == "failed"
    assert factory.flows[0].fetch_codes == []
@pytest.mark.asyncio
async def test_real_desktop_authorization_url_uses_pkce_and_the_sole_readonly_scope(
    tmp_path: Path,
) -> None:
    client_path = tmp_path / "oauth" / "client.json"
    write_client_config(client_path)
    manager = GmailOAuthManager(
        client_json=client_path,
        token_json=tmp_path / "token" / "gmail-token.json",
        redirect_uri="http://127.0.0.1:8765/oauth/gmail/callback",
        clock=lambda: NOW,
    )

    created = await manager.start()
    query = parse_qs(urlsplit(created.authorization_url).query)

    assert query["scope"] == [GMAIL_READONLY_SCOPE]
    assert query["redirect_uri"] == [
        "http://127.0.0.1:8765/oauth/gmail/callback"
    ]
    assert query["access_type"] == ["offline"]
    assert query["prompt"] == ["consent"]
    assert query["include_granted_scopes"] == ["false"]
    assert query["code_challenge_method"] == ["S256"]
    assert len(query["code_challenge"][0]) == 43
