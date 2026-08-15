from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
import pytest

from jobhunter_browser_harness import pipeline_agent as pipeline_agent_module
from jobhunter_browser_harness.pipeline_agent import (
    MODEL_NAME,
    MODEL_PROVIDER,
    REASONING,
    PipelineApplicationAgentClient,
    PipelineApplicationAgentError,
)

_REAL_ASYNC_CLIENT = httpx.AsyncClient
_SESSION_ID = UUID("52aa48d2-c3c8-40df-80de-d213631a04aa")
_TOKEN = "unit-test-token-0123456789abcdef"
_AGENT_PATH = "/v1/internal/application-agent"
_STEER_PATH = f"{_AGENT_PATH}/{_SESSION_ID}/steer"

Handler = Callable[[httpx.Request], httpx.Response | Awaitable[httpx.Response]]


def _status_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "modelProvider": MODEL_PROVIDER,
        "model": MODEL_NAME,
        "reasoning": REASONING,
        "oauth": "connected",
    }
    payload.update(overrides)
    return payload


def _result_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": "submitted",
        "company": "Example Corp",
        "role": "Engineer",
        "job_url": "https://jobs.example.test/42",
        "final_url": "https://jobs.example.test/42/apply",
        "fields_filled": [
            {
                "label": "Name",
                "field_type": "text",
                "value_present": True,
                "note": "",
            }
        ],
        "fields_needing_human": [],
        "files_attached": ["resume.pdf"],
        "warnings": [],
        "revision_count": 1,
        "submit_attempted": True,
        "submission_confirmation": {
            "type": "post_submit_confirmation",
            "text": "Application received.",
        },
    }
    payload.update(overrides)
    return payload


def _success_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "modelProvider": MODEL_PROVIDER,
        "model": MODEL_NAME,
        "reasoning": REASONING,
        "result": _result_payload(),
    }
    payload.update(overrides)
    return payload


async def _run(agent: PipelineApplicationAgentClient):
    return await agent.run(
        runtime_url="http://127.0.0.1:8765",
        opportunity_kind="job",
        auto_submit=False,
        task="private task",
        max_turns=25,
        deadline_ms=30_000,
    )


def _assert_public_error(
    error: PipelineApplicationAgentError,
    code: str,
    message: str,
    *secrets: str,
) -> None:
    assert error.code == code
    assert error.public_message == message
    assert error.args == (message,)
    assert str(error) == message
    for secret in secrets:
        assert secret not in str(error)
        assert secret not in repr(error)
        assert secret not in error.public_message


@dataclass
class ClientHarness:
    agent: PipelineApplicationAgentClient
    client: Any
    construction: dict[str, Any]
    requests: list[httpx.Request]


@pytest.fixture
async def build_client(monkeypatch: pytest.MonkeyPatch):
    clients: list[Any] = []

    def build(
        handler: Handler,
        *,
        pipeline_url: str = "http://127.0.0.1:3457",
        bearer_token: str = _TOKEN,
        session_id: UUID = _SESSION_ID,
    ) -> ClientHarness:
        requests: list[httpx.Request] = []
        constructions: list[dict[str, Any]] = []

        async def dispatch(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            response = handler(request)
            if inspect.isawaitable(response):
                response = await response
            return response

        class TrackingAsyncClient(_REAL_ASYNC_CLIENT):
            close_calls = 0

            async def aclose(self) -> None:
                self.close_calls += 1
                await super().aclose()

        def client_factory(**kwargs: Any) -> TrackingAsyncClient:
            constructions.append(kwargs.copy())
            client = TrackingAsyncClient(
                **kwargs,
                transport=httpx.MockTransport(dispatch),
            )
            clients.append(client)
            return client

        monkeypatch.setattr(pipeline_agent_module.httpx, "AsyncClient", client_factory)
        agent = PipelineApplicationAgentClient(session_id, pipeline_url, bearer_token)
        return ClientHarness(agent, clients[-1], constructions[0], requests)

    yield build

    for client in clients:
        if not client.is_closed:
            await client.aclose()


async def test_check_ready_uses_exact_authenticated_path_and_hardened_transport(
    build_client: Callable[..., ClientHarness],
) -> None:
    harness = build_client(lambda _request: httpx.Response(200, json=_status_payload()))

    assert await harness.agent.check_ready() is None

    assert len(harness.requests) == 1
    request = harness.requests[0]
    assert request.method == "GET"
    assert request.url == httpx.URL(f"http://127.0.0.1:3457{_AGENT_PATH}")
    assert request.headers["Authorization"] == f"Bearer {_TOKEN}"
    assert request.content == b""
    assert harness.construction["headers"] == {"Authorization": f"Bearer {_TOKEN}"}
    assert harness.construction["trust_env"] is False


@pytest.mark.parametrize(
    ("opportunity_kind", "expected_kind_json"),
    [
        ("competition", '"opportunityKind":"competition",'),
        ("networking_event", '"opportunityKind":"networking_event",'),
    ],
)
async def test_run_posts_exact_contract_with_deadline_transport_timeout(
    build_client: Callable[..., ClientHarness],
    opportunity_kind: str,
    expected_kind_json: str,
) -> None:
    harness = build_client(
        lambda _request: httpx.Response(200, json=_success_payload())
    )

    result = await harness.agent.run(
        runtime_url="http://localhost:8765",
        opportunity_kind=opportunity_kind,
        auto_submit=True,
        task="complete the application",
        max_turns=37,
        deadline_ms=12_345,
    )

    assert result.model_dump(mode="json") == _result_payload()
    assert len(harness.requests) == 1
    request = harness.requests[0]
    assert request.method == "POST"
    assert request.url == httpx.URL(f"http://127.0.0.1:3457{_AGENT_PATH}")
    assert request.headers["Authorization"] == f"Bearer {_TOKEN}"
    assert request.headers["Content-Type"] == "application/json"
    assert request.extensions["timeout"] == {
        "connect": 72.345,
        "read": 72.345,
        "write": 72.345,
        "pool": 72.345,
    }
    assert request.read().decode("utf-8") == (
        '{"sessionId":"52aa48d2-c3c8-40df-80de-d213631a04aa",'
        '"runtimeUrl":"http://localhost:8765",'
        + expected_kind_json
        + '"task":"complete the application",'
        + '"autoSubmit":true,'
        + '"maxTurns":37,"deadlineMs":12345}'
    )


async def test_steer_posts_exact_authenticated_path_body_and_requires_empty_202(
    build_client: Callable[..., ClientHarness],
) -> None:
    harness = build_client(
        lambda _request: httpx.Response(
            202,
            content=b"",
            headers={"cache-control": "no-store"},
        )
    )

    assert await harness.agent.steer("  Prefer the operator-updated location.  ") is None

    assert len(harness.requests) == 1
    request = harness.requests[0]
    assert request.method == "POST"
    assert request.url == httpx.URL(f"http://127.0.0.1:3457{_STEER_PATH}")
    assert request.headers["Authorization"] == f"Bearer {_TOKEN}"
    assert request.headers["Content-Type"] == "application/json"
    assert request.read() == b'{"message":"Prefer the operator-updated location."}'
    assert request.extensions["timeout"] == {
        "connect": 5.0,
        "read": 5.0,
        "write": 5.0,
        "pool": 5.0,
    }


@pytest.mark.parametrize(
    "message",
    [
        "",
        " \n ",
        "contains\x00nul",
        "\ud800",
        "x" * 8_001,
        "\U0001f680" * 8_001,
    ],
)
async def test_steer_rejects_invalid_text_before_network_io(
    build_client: Callable[..., ClientHarness],
    message: str,
) -> None:
    harness = build_client(lambda _request: httpx.Response(202))

    with pytest.raises(ValueError, match="message is invalid"):
        await harness.agent.steer(message)

    assert harness.requests == []


async def test_steer_maps_private_conflict_without_echoing_guidance(
    build_client: Callable[..., ClientHarness],
) -> None:
    message = "private operator guidance"
    private_detail = f"closed while handling {message}"
    harness = build_client(
        lambda _request: httpx.Response(
            409,
            json={
                "error": {
                    "code": "APPLICATION_COMMAND_CONFLICT",
                    "message": private_detail,
                }
            },
        )
    )

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await harness.agent.steer(message)

    _assert_public_error(
        raised.value,
        "command_conflict",
        "The application state changed; review the latest session state",
        message,
        private_detail,
    )
    assert len(harness.requests) == 1


@pytest.mark.parametrize(
    ("response", "secret"),
    [
        (
            httpx.Response(
                409,
                json={
                    "error": {
                        "code": "UNKNOWN_PRIVATE_CONFLICT",
                        "message": "private stale detail",
                    }
                },
            ),
            "private stale detail",
        ),
        (
            httpx.Response(202, content=b"unexpected private success body"),
            "unexpected private success body",
        ),
        (
            httpx.Response(500, content=b"private pipeline failure"),
            "private pipeline failure",
        ),
    ],
)
async def test_steer_maps_malformed_or_private_failures_without_retry_or_leakage(
    build_client: Callable[..., ClientHarness],
    response: httpx.Response,
    secret: str,
) -> None:
    harness = build_client(lambda _request: response)

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await harness.agent.steer("operator text")

    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
        "operator text",
        secret,
    )
    assert len(harness.requests) == 1


async def test_steer_lost_response_is_not_retried(
    build_client: Callable[..., ClientHarness],
) -> None:
    secret = "private lost-response detail"

    def lost_response(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadError(secret, request=request)

    harness = build_client(lost_response)

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await harness.agent.steer("send exactly once")

    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
        "send exactly once",
        secret,
    )
    assert len(harness.requests) == 1


async def test_steer_close_race_is_fixed_and_not_retried(
    build_client: Callable[..., ClientHarness],
) -> None:
    secret = "private concurrent-close detail"

    def closed_during_request(_request: httpx.Request) -> httpx.Response:
        raise RuntimeError(secret)

    harness = build_client(closed_during_request)

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await harness.agent.steer("send at most once")

    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
        "send at most once",
        secret,
    )
    assert len(harness.requests) == 1


async def test_steer_request_runs_concurrently_with_active_agent_request(
    build_client: Callable[..., ClientHarness],
) -> None:
    run_started = asyncio.Event()
    release_run = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == _AGENT_PATH:
            run_started.set()
            await release_run.wait()
            return httpx.Response(200, json=_success_payload())
        assert request.url.path == _STEER_PATH
        return httpx.Response(202)

    harness = build_client(handler)
    run_task = asyncio.create_task(_run(harness.agent))
    await run_started.wait()

    assert await harness.agent.steer("continue with the corrected detail") is None
    assert len(harness.requests) == 2
    assert not run_task.done()

    release_run.set()
    await run_task

@pytest.mark.parametrize(
    ("method", "expected_code", "expected_message"),
    [
        (
            "GET",
            "pipeline_unavailable",
            "The local pipeline model service is unavailable",
        ),
        ("POST", "model_failed", "The model request failed"),
    ],
)
async def test_redirect_response_never_counts_as_internal_success(
    build_client: Callable[..., ClientHarness],
    method: str,
    expected_code: str,
    expected_message: str,
) -> None:
    payload = _status_payload() if method == "GET" else _success_payload()
    harness = build_client(
        lambda _request: httpx.Response(302, json=payload)
    )

    with pytest.raises(PipelineApplicationAgentError) as raised:
        if method == "GET":
            await harness.agent.check_ready()
        else:
            await _run(harness.agent)

    _assert_public_error(
        raised.value,
        expected_code,
        expected_message,
    )


@pytest.mark.parametrize(
    "status",
    [
        _status_payload(modelProvider="other"),
        _status_payload(model="other"),
        _status_payload(reasoning="medium"),
        _status_payload(oauth="disconnected"),
        {**_status_payload(), "extra": True},
        {"modelProvider": MODEL_PROVIDER},
    ],
)
async def test_check_ready_requires_exact_status(
    build_client: Callable[..., ClientHarness],
    status: dict[str, Any],
) -> None:
    harness = build_client(lambda _request: httpx.Response(200, json=status))

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await harness.agent.check_ready()

    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
    )


@pytest.mark.parametrize(
    ("status_code", "gateway_code", "expected_code", "expected_message"),
    [
        (
            409,
            "OAUTH_REQUIRED",
            "oauth_required",
            "Connect OpenAI Codex in Provider access",
        ),
        (
            502,
            "MODEL_PROVIDER_FAILED",
            "pipeline_unavailable",
            "The local pipeline model service is unavailable",
        ),
    ],
)
async def test_check_ready_only_exposes_the_oauth_status_error(
    build_client: Callable[..., ClientHarness],
    status_code: int,
    gateway_code: str,
    expected_code: str,
    expected_message: str,
) -> None:
    secret = "private-readiness-provider-detail"
    harness = build_client(
        lambda _request: httpx.Response(
            status_code,
            json={"error": {"code": gateway_code, "message": secret}},
        )
    )

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await harness.agent.check_ready()

    _assert_public_error(
        raised.value,
        expected_code,
        expected_message,
        secret,
    )


@pytest.mark.parametrize(
    "payload",
    [
        _success_payload(modelProvider="other"),
        _success_payload(model="other"),
        _success_payload(reasoning="medium"),
        {**_success_payload(), "extra": True},
        _success_payload(result=_result_payload(status="ready_for_submission")),
        _success_payload(result={**_result_payload(), "providerSecret": "hidden"}),
    ],
)
async def test_run_rejects_malformed_success_metadata_or_result(
    build_client: Callable[..., ClientHarness],
    payload: dict[str, Any],
) -> None:
    secret = "hidden"
    harness = build_client(lambda _request: httpx.Response(200, json=payload))

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await _run(harness.agent)

    _assert_public_error(
        raised.value,
        "invalid_model_output",
        "The model returned invalid output",
        secret,
    )


@pytest.mark.parametrize("method", ["GET", "POST"])
async def test_malformed_success_or_status_json_is_fixed_and_sanitized(
    build_client: Callable[..., ClientHarness],
    method: str,
) -> None:
    secret = "malformed-success-provider-body"
    harness = build_client(
        lambda _request: httpx.Response(
            200,
            content=f"not-json:{secret}",
            headers={"content-type": "application/json"},
        )
    )

    if method == "GET":
        expected_code = "pipeline_unavailable"
        expected_message = "The local pipeline model service is unavailable"
    else:
        expected_code = "invalid_model_output"
        expected_message = "The model returned invalid output"
    with pytest.raises(PipelineApplicationAgentError) as raised:
        if method == "GET":
            await harness.agent.check_ready()
        else:
            await _run(harness.agent)

    _assert_public_error(
        raised.value,
        expected_code,
        expected_message,
        secret,
    )


@pytest.mark.parametrize(
    (
        "status_code",
        "gateway_code",
        "expected_code",
        "expected_message",
    ),
    [
        (422, "INVALID_REQUEST", "invalid_request", "Request is invalid"),
        (
            409,
            "OAUTH_REQUIRED",
            "oauth_required",
            "Connect OpenAI Codex in Provider access",
        ),
        (504, "MODEL_TIMEOUT", "model_timeout", "The model request timed out"),
        (
            502,
            "INVALID_MODEL_OUTPUT",
            "invalid_model_output",
            "The model returned invalid output",
        ),
        (
            502,
            "MODEL_PROVIDER_FAILED",
            "model_failed",
            "The model request failed",
        ),
        (
            409,
            "APPLICATION_MISMATCH",
            "application_mismatch",
            "The open page does not match the requested job",
        ),
        (
            409,
            "STEP_LIMIT",
            "step_limit",
            "The application step limit was reached",
        ),
        (
            502,
            "BROWSER_FAILED",
            "browser_failed",
            "The browser session failed",
        ),
    ],
)
async def test_run_maps_each_exact_gateway_error_without_leaking_body(
    build_client: Callable[..., ClientHarness],
    status_code: int,
    gateway_code: str,
    expected_code: str,
    expected_message: str,
) -> None:
    secret = "provider-error-body-secret"
    harness = build_client(
        lambda _request: httpx.Response(
            status_code,
            json={"error": {"code": gateway_code, "message": secret}, "detail": secret},
        )
    )

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await _run(harness.agent)

    _assert_public_error(
        raised.value,
        expected_code,
        expected_message,
        secret,
    )


@pytest.mark.parametrize(
    ("status_code", "gateway_code"),
    [
        (409, "MODEL_TIMEOUT"),
        (504, "OAUTH_REQUIRED"),
        (502, "UNKNOWN_ERROR"),
    ],
)
async def test_run_requires_the_exact_status_and_gateway_code_pair(
    build_client: Callable[..., ClientHarness],
    status_code: int,
    gateway_code: str,
) -> None:
    secret = "mismatched-provider-error"
    harness = build_client(
        lambda _request: httpx.Response(
            status_code,
            json={"error": {"code": gateway_code, "message": secret}},
        )
    )

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await _run(harness.agent)

    _assert_public_error(
        raised.value,
        "model_failed",
        "The model request failed",
        secret,
    )


async def test_run_maps_non_json_error_to_fixed_model_failure(
    build_client: Callable[..., ClientHarness],
) -> None:
    secret = "raw-private-provider-body"
    harness = build_client(
        lambda _request: httpx.Response(
            502,
            content=secret,
            headers={"content-type": "text/plain", "x-provider-detail": secret},
        )
    )

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await _run(harness.agent)

    _assert_public_error(
        raised.value,
        "model_failed",
        "The model request failed",
        secret,
    )


async def test_unauthorized_run_is_pipeline_unavailable_without_body_leakage(
    build_client: Callable[..., ClientHarness],
) -> None:
    secret = "private-auth-gateway-detail"
    harness = build_client(
        lambda _request: httpx.Response(
            401,
            json={"error": {"code": "UNAUTHORIZED", "message": secret}},
        )
    )

    with pytest.raises(PipelineApplicationAgentError) as raised:
        await _run(harness.agent)

    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
        secret,
    )


async def test_run_transport_timeout_is_fixed_and_sanitized(
    build_client: Callable[..., ClientHarness],
) -> None:
    secret = "private-timeout-detail"

    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout(secret, request=request)

    harness = build_client(timeout)
    with pytest.raises(PipelineApplicationAgentError) as raised:
        await _run(harness.agent)
    _assert_public_error(
        raised.value,
        "model_timeout",
        "The model request timed out",
        secret,
    )


async def test_transport_failure_is_pipeline_unavailable_and_sanitized(
    build_client: Callable[..., ClientHarness],
) -> None:
    secret = "private-connect-detail"

    def failed(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(secret, request=request)

    harness = build_client(failed)
    with pytest.raises(PipelineApplicationAgentError) as raised:
        await _run(harness.agent)
    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
        secret,
    )


async def test_run_propagates_caller_cancellation(
    build_client: Callable[..., ClientHarness],
) -> None:
    started = asyncio.Event()
    blocker = asyncio.Event()

    async def blocked(_request: httpx.Request) -> httpx.Response:
        started.set()
        await blocker.wait()
        return httpx.Response(200, json=_success_payload())

    harness = build_client(blocked)
    task = asyncio.create_task(_run(harness.agent))
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


async def test_close_is_idempotent_and_rejects_new_requests(
    build_client: Callable[..., ClientHarness],
) -> None:
    harness = build_client(
        lambda request: httpx.Response(
            200,
            json=_status_payload() if request.method == "GET" else _success_payload(),
        )
    )
    await harness.agent.check_ready()
    await _run(harness.agent)

    await harness.agent.aclose()
    await harness.agent.aclose()

    assert harness.client.close_calls == 1
    assert harness.client.is_closed is True
    request_count = len(harness.requests)
    with pytest.raises(PipelineApplicationAgentError) as raised:
        await _run(harness.agent)
    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
    )
    assert len(harness.requests) == request_count
    with pytest.raises(PipelineApplicationAgentError) as steer_raised:
        await harness.agent.steer("must not be sent")
    _assert_public_error(
        steer_raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
        "must not be sent",
    )
    assert len(harness.requests) == request_count


async def test_uppercase_loopback_pipeline_origin_is_canonicalized_for_requests(
    build_client: Callable[..., ClientHarness],
) -> None:
    harness = build_client(
        lambda _request: httpx.Response(200, json=_status_payload()),
        pipeline_url="HTTP://LOCALHOST:3457/",
    )

    assert await harness.agent.check_ready() is None
    assert len(harness.requests) == 1
    assert harness.requests[0].url == httpx.URL(
        "http://localhost:3457/v1/internal/application-agent"
    )


@pytest.mark.parametrize(
    "pipeline_url",
    [
        "https://127.0.0.1:3457",
        "http://192.0.2.1:3457",
        "http://user@127.0.0.1:3457",
        "http://127.0.0.1:3457/path",
        "http://127.0.0.1:3457?query=1",
        "http://127.0.0.1:3457#fragment",
    ],
)
def test_constructor_rejects_non_loopback_or_non_origin_pipeline_urls(
    build_client: Callable[..., ClientHarness],
    pipeline_url: str,
) -> None:
    with pytest.raises(ValueError, match="pipeline_url must be a loopback HTTP origin"):
        build_client(
            lambda _request: httpx.Response(200, json=_status_payload()),
            pipeline_url=pipeline_url,
        )


async def test_run_rejects_non_loopback_runtime_origin_before_request(
    build_client: Callable[..., ClientHarness],
) -> None:
    harness = build_client(
        lambda _request: httpx.Response(200, json=_success_payload())
    )

    with pytest.raises(ValueError, match="runtime_url must be a loopback HTTP origin"):
        await harness.agent.run(
            runtime_url="http://example.test:8765",
            opportunity_kind="job",
            auto_submit=False,
            task="task",
            max_turns=10,
            deadline_ms=30_000,
        )
    assert harness.requests == []


@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"opportunity_kind": "internship"}, "opportunity_kind is invalid"),
        ({"auto_submit": 1}, "auto_submit is invalid"),
        ({"task": "a" * (1_048_576 + 1)}, "task is invalid"),
        ({"task": b"not text"}, "task is invalid"),
        ({"max_turns": 0}, "max_turns is invalid"),
        ({"max_turns": 501}, "max_turns is invalid"),
        ({"max_turns": True}, "max_turns is invalid"),
        ({"deadline_ms": 999}, "deadline_ms is invalid"),
        ({"deadline_ms": 86_400_001}, "deadline_ms is invalid"),
        ({"deadline_ms": 1_000.0}, "deadline_ms is invalid"),
    ],
)
async def test_run_rejects_values_outside_the_strict_post_contract(
    build_client: Callable[..., ClientHarness],
    override: dict[str, Any],
    message: str,
) -> None:
    harness = build_client(
        lambda _request: httpx.Response(200, json=_success_payload())
    )
    arguments: dict[str, Any] = {
        "opportunity_kind": "job",
        "auto_submit": False,
        "runtime_url": "http://127.0.0.1:8765",
        "task": "task",
        "max_turns": 10,
        "deadline_ms": 30_000,
    }
    arguments.update(override)

    with pytest.raises(ValueError, match=message):
        await harness.agent.run(**arguments)

    assert harness.requests == []
