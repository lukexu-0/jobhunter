from __future__ import annotations

import inspect
import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import httpx
import pytest
from pydantic import BaseModel, Field

import jobhunter_browser_harness

# Importing the package must set these before pipeline_model imports Browser Use.
_BROWSER_USE_ENV_BEFORE_MODEL_IMPORT = (
    os.environ.get("ANONYMIZED_TELEMETRY"),
    os.environ.get("BROWSER_USE_ACTION_TIMEOUT_S"),
)

from jobhunter_browser_harness import pipeline_model as pipeline_model_module  # noqa: E402
from jobhunter_browser_harness.pipeline_model import (  # noqa: E402
    MODEL_NAME,
    MODEL_PROVIDER,
    REASONING,
    PipelineModelError,
    PipelineOAuthChatModel,
)
from browser_use.llm.messages import (  # noqa: E402
    AssistantMessage,
    Function,
    SystemMessage,
    ToolCall,
    UserMessage,
)
from browser_use.llm.schema import SchemaOptimizer  # noqa: E402
from browser_use.llm.views import ChatInvokeUsage  # noqa: E402

_REAL_ASYNC_CLIENT = httpx.AsyncClient
_SESSION_ID = UUID("52aa48d2-c3c8-40df-80de-d213631a04aa")
_TOKEN = "unit-test-token-0123456789abcdef"
_GATEWAY_PATH = "/v1/internal/browser-harness/codex"


class DetailResult(BaseModel):
    note: str


class StructuredResult(BaseModel):
    answer: str
    score: int = Field(ge=0)
    detail: DetailResult


Handler = Callable[[httpx.Request], httpx.Response | Awaitable[httpx.Response]]


@dataclass
class ModelHarness:
    model: PipelineOAuthChatModel
    client: Any
    construction: dict[str, Any]
    requests: list[httpx.Request]


def _status_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "modelProvider": MODEL_PROVIDER,
        "model": MODEL_NAME,
        "reasoning": REASONING,
        "oauth": "connected",
    }
    payload.update(overrides)
    return payload


def _completion_payload(
    output: dict[str, Any] | None = None,
    *,
    input_tokens: int = 17,
    output_tokens: int = 5,
    total_tokens: int = 22,
    **overrides: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "modelProvider": MODEL_PROVIDER,
        "model": MODEL_NAME,
        "reasoning": REASONING,
        "output": output if output is not None else {"type": "text", "text": "done"},
        "usage": {
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
        },
    }
    payload.update(overrides)
    return payload


def _default_handler(request: httpx.Request) -> httpx.Response:
    if request.method == "GET":
        return httpx.Response(200, json=_status_payload())
    return httpx.Response(200, json=_completion_payload())


def _assert_public_error(
    error: PipelineModelError,
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


@pytest.fixture
async def build_model(monkeypatch: pytest.MonkeyPatch):
    clients: list[Any] = []

    def build(
        handler: Handler = _default_handler,
        *,
        pipeline_url: str = "http://127.0.0.1:3457",
        bearer_token: str = _TOKEN,
        session_id: UUID = _SESSION_ID,
    ) -> ModelHarness:
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

        # The transport is installed before construction, so no production client can
        # briefly exist without MockTransport.
        monkeypatch.setattr(pipeline_model_module.httpx, "AsyncClient", client_factory)
        model = PipelineOAuthChatModel(session_id, pipeline_url, bearer_token)
        assert len(constructions) == 1
        return ModelHarness(model, clients[-1], constructions[0], requests)

    yield build

    for client in clients:
        if not client.is_closed:
            await client.aclose()


def test_browser_use_environment_was_set_before_model_import() -> None:
    assert jobhunter_browser_harness.__name__ == "jobhunter_browser_harness"
    assert _BROWSER_USE_ENV_BEFORE_MODEL_IMPORT == ("false", "3600")
    assert os.environ["ANONYMIZED_TELEMETRY"] == "false"
    assert os.environ["BROWSER_USE_ACTION_TIMEOUT_S"] == "3600"


@pytest.mark.parametrize(
    ("pipeline_url", "normalized"),
    [
        ("http://127.0.0.1", "http://127.0.0.1"),
        ("http://127.0.0.1/", "http://127.0.0.1"),
        ("http://localhost:3457", "http://localhost:3457"),
        ("http://[::1]:3457", "http://[::1]:3457"),
    ],
)
async def test_accepts_only_supported_loopback_origins(
    build_model: Callable[..., ModelHarness],
    pipeline_url: str,
    normalized: str,
) -> None:
    harness = build_model(pipeline_url=pipeline_url)

    assert harness.construction["base_url"] == normalized
    assert harness.model.provider == MODEL_PROVIDER
    assert harness.model.name == MODEL_NAME
    assert harness.model.model_name == MODEL_NAME
    assert harness.model.model == MODEL_NAME
    assert harness.model.reasoning == REASONING
    assert harness.model._verified_api_keys is True

    await harness.model.aclose()


@pytest.mark.parametrize(
    "pipeline_url",
    [
        "https://127.0.0.1:3457",
        "http://example.test:3457",
        "http://0.0.0.0:3457",
        "http://user@127.0.0.1:3457",
        "http://user:password@localhost:3457",
        "http://127.0.0.1:3457/internal",
        "http://127.0.0.1:3457/?query=1",
        "http://127.0.0.1:3457/#fragment",
        "http://127.0.0.1:not-a-port",
    ],
)
async def test_rejects_remote_userinfo_path_and_non_origin_urls(
    build_model: Callable[..., ModelHarness],
    pipeline_url: str,
) -> None:
    with pytest.raises(ValueError, match="pipeline_url"):
        build_model(pipeline_url=pipeline_url)


@pytest.mark.parametrize("bearer_token", ["", "x", "x" * 31])
async def test_rejects_short_bearer_tokens(
    build_model: Callable[..., ModelHarness],
    bearer_token: str,
) -> None:
    with pytest.raises(ValueError, match="at least 32 characters"):
        build_model(bearer_token=bearer_token)


async def test_accepts_exactly_32_character_bearer_token(
    build_model: Callable[..., ModelHarness],
) -> None:
    harness = build_model(bearer_token="x" * 32)
    assert harness.construction["headers"] == {"Authorization": f"Bearer {'x' * 32}"}
    await harness.model.aclose()


async def test_check_ready_uses_exact_gateway_request_and_status(
    build_model: Callable[..., ModelHarness],
) -> None:
    harness = build_model()

    assert await harness.model.check_ready() is None

    assert len(harness.requests) == 1
    request = harness.requests[0]
    assert request.method == "GET"
    assert request.url == httpx.URL(f"http://127.0.0.1:3457{_GATEWAY_PATH}")
    assert request.headers["Authorization"] == f"Bearer {_TOKEN}"
    assert request.content == b""
    assert harness.construction["headers"] == {"Authorization": f"Bearer {_TOKEN}"}
    assert harness.construction["trust_env"] is False
    timeout = harness.construction["timeout"]
    assert isinstance(timeout, httpx.Timeout)
    assert (timeout.connect, timeout.read, timeout.write, timeout.pool) == (
        300.0,
        300.0,
        300.0,
        300.0,
    )
    assert request.extensions["timeout"] == {
        "connect": 300.0,
        "read": 300.0,
        "write": 300.0,
        "pool": 300.0,
    }


@pytest.mark.parametrize(
    "status",
    [
        _status_payload(modelProvider="another-provider"),
        _status_payload(model="another-model"),
        _status_payload(reasoning="medium"),
        _status_payload(oauth="disconnected"),
        {**_status_payload(), "unexpected": True},
        {"modelProvider": MODEL_PROVIDER},
    ],
)
async def test_check_ready_requires_exact_status_shape_and_literals(
    build_model: Callable[..., ModelHarness],
    status: dict[str, Any],
) -> None:
    harness = build_model(lambda request: httpx.Response(200, json=status))

    with pytest.raises(PipelineModelError) as raised:
        await harness.model.check_ready()

    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
    )


async def test_check_ready_rejects_malformed_json_without_leaking_it(
    build_model: Callable[..., ModelHarness],
) -> None:
    secret_body = "private-provider-status-body"
    harness = build_model(
        lambda request: httpx.Response(
            200,
            content=f"not-json:{secret_body}",
            headers={"content-type": "application/json"},
        )
    )

    with pytest.raises(PipelineModelError) as raised:
        await harness.model.check_ready()

    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
        secret_body,
    )

async def test_check_ready_maps_disabled_or_failed_gateway_to_pipeline_unavailable(
    build_model: Callable[..., ModelHarness],
) -> None:
    secret_body = "private-disabled-route-body"
    harness = build_model(
        lambda request: httpx.Response(404, content=secret_body)
    )
    with pytest.raises(PipelineModelError) as raised:
        await harness.model.check_ready()
    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
        secret_body,
    )


async def test_ainvoke_sends_one_system_prompt_and_role_labelled_transcript(
    build_model: Callable[..., ModelHarness],
) -> None:
    harness = build_model()
    messages = [
        SystemMessage(content="primary system instruction"),
        UserMessage(content="first user turn"),
        SystemMessage(content="second system instruction"),
        AssistantMessage(
            content="assistant answer",
            tool_calls=[
                ToolCall(
                    id="call-1",
                    function=Function(name="lookup", arguments='{"query":"role"}'),
                )
            ],
        ),
        UserMessage(content="final user turn"),
    ]

    completion = await harness.model.ainvoke(messages)

    assert completion.completion == "done"
    assert len(harness.requests) == 1
    request = harness.requests[0]
    assert request.method == "POST"
    assert request.url.path == _GATEWAY_PATH
    assert request.headers["Authorization"] == f"Bearer {_TOKEN}"
    assert request.headers["Content-Type"] == "application/json"
    assert json.loads(request.content) == {
        "sessionId": str(_SESSION_ID),
        "systemPrompt": "primary system instruction\n\nsecond system instruction",
        "transcript": (
            "[USER]\nfirst user turn\n\n"
            "[ASSISTANT]\nassistant answer\n"
            '{"id":"call-1","name":"lookup","arguments":"{\\"query\\":\\"role\\"}"}\n\n'
            "[USER]\nfinal user turn"
        ),
    }


async def test_structured_request_uses_strict_optimized_schema_and_validates_result(
    build_model: Callable[..., ModelHarness],
) -> None:
    value = {"answer": "qualified", "score": 9, "detail": {"note": "grounded"}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=_completion_payload({"type": "structured", "value": value}),
        )

    harness = build_model(handler)

    completion = await harness.model.ainvoke(
        [SystemMessage(content="system"), UserMessage(content="question")],
        output_format=StructuredResult,
    )

    assert completion.completion == StructuredResult.model_validate(value)
    body = json.loads(harness.requests[0].content)
    expected_schema = SchemaOptimizer.create_optimized_json_schema(StructuredResult)
    assert body["outputSchema"] == expected_schema
    assert expected_schema["additionalProperties"] is False
    assert expected_schema["required"] == ["answer", "score", "detail"]
    assert expected_schema["properties"]["detail"]["additionalProperties"] is False
    assert expected_schema["properties"]["detail"]["required"] == ["note"]
    assert "$defs" not in expected_schema
    assert "$ref" not in json.dumps(expected_schema)


async def test_text_completion_maps_exact_usage(
    build_model: Callable[..., ModelHarness],
) -> None:
    harness = build_model(
        lambda request: httpx.Response(
            200,
            json=_completion_payload(
                {"type": "text", "text": "plain response"},
                input_tokens=101,
                output_tokens=23,
                total_tokens=124,
            ),
        )
    )

    completion = await harness.model.ainvoke([UserMessage(content="hello")])

    assert completion.completion == "plain response"
    assert completion.usage == ChatInvokeUsage(
        prompt_tokens=101,
        prompt_cached_tokens=None,
        prompt_cache_creation_tokens=None,
        prompt_cache_creation_5m_tokens=None,
        prompt_cache_creation_1h_tokens=None,
        prompt_image_tokens=None,
        completion_tokens=23,
        total_tokens=124,
    )


@pytest.mark.parametrize(
    "metadata_override",
    [
        {"modelProvider": "other-provider"},
        {"model": "other-model"},
        {"reasoning": "low"},
    ],
)
async def test_completion_requires_exact_provider_model_and_reasoning(
    build_model: Callable[..., ModelHarness],
    metadata_override: dict[str, str],
) -> None:
    harness = build_model(
        lambda request: httpx.Response(
            200,
            json=_completion_payload(**metadata_override),
        )
    )

    with pytest.raises(PipelineModelError) as raised:
        await harness.model.ainvoke([UserMessage(content="hello")])

    _assert_public_error(
        raised.value,
        "invalid_model_output",
        "The model returned invalid output",
    )


@pytest.mark.parametrize(
    "output",
    [
        {"type": "structured", "value": {}},
        {"type": "text"},
        {"type": "text", "text": "answer", "value": {}},
        {"type": "text", "text": "answer", "extra": "forbidden"},
    ],
)
async def test_text_invocation_rejects_nonexact_output_shape(
    build_model: Callable[..., ModelHarness],
    output: dict[str, Any],
) -> None:
    harness = build_model(
        lambda request: httpx.Response(200, json=_completion_payload(output))
    )

    with pytest.raises(PipelineModelError) as raised:
        await harness.model.ainvoke([UserMessage(content="hello")])

    _assert_public_error(
        raised.value,
        "invalid_model_output",
        "The model returned invalid output",
    )


@pytest.mark.parametrize(
    "output",
    [
        {"type": "text", "text": "not structured"},
        {"type": "structured"},
        {
            "type": "structured",
            "value": {"answer": "x", "score": 1, "detail": {"note": "x"}},
            "text": "also text",
        },
        {"type": "structured", "value": {"answer": "missing fields"}},
        {
            "type": "structured",
            "value": {"answer": "x", "score": -1, "detail": {"note": "x"}},
        },
    ],
)
async def test_structured_invocation_rejects_wrong_or_invalid_output(
    build_model: Callable[..., ModelHarness],
    output: dict[str, Any],
) -> None:
    harness = build_model(
        lambda request: httpx.Response(200, json=_completion_payload(output))
    )

    with pytest.raises(PipelineModelError) as raised:
        await harness.model.ainvoke(
            [UserMessage(content="hello")],
            output_format=StructuredResult,
        )

    _assert_public_error(
        raised.value,
        "invalid_model_output",
        "The model returned invalid output",
    )


@pytest.mark.parametrize(
    "response_factory",
    [
        lambda: httpx.Response(
            200,
            content="private malformed completion",
            headers={"content-type": "application/json"},
        ),
        lambda: httpx.Response(200, json=["not", "an", "object"]),
        lambda: httpx.Response(
            200,
            json={
                "modelProvider": MODEL_PROVIDER,
                "model": MODEL_NAME,
                "reasoning": REASONING,
                "output": {"type": "text", "text": "answer"},
            },
        ),
        lambda: httpx.Response(
            200,
            json=_completion_payload(input_tokens=-1),
        ),
        lambda: httpx.Response(
            200,
            json={**_completion_payload(), "privateExtra": "private extra value"},
        ),
        lambda: httpx.Response(
            200,
            json={
                **_completion_payload(),
                "usage": {
                    "inputTokens": "17",
                    "outputTokens": 5,
                    "totalTokens": 22,
                },
            },
        ),
        lambda: httpx.Response(
            200,
            json=_completion_payload(
                output={"type": "text", "text": "answer", "value": None}
            ),
        ),
    ],
)
async def test_malformed_json_and_completion_envelopes_are_sanitized(
    build_model: Callable[..., ModelHarness],
    response_factory: Callable[[], httpx.Response],
) -> None:
    harness = build_model(lambda request: response_factory())

    with pytest.raises(PipelineModelError) as raised:
        await harness.model.ainvoke([UserMessage(content="hello")])

    _assert_public_error(
        raised.value,
        "invalid_model_output",
        "The model returned invalid output",
        "private malformed completion",
        "private extra value",
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
        (502, "UNKNOWN_PROVIDER_CODE", "model_failed", "The model request failed"),
        (
            401,
            "UNKNOWN_AUTH_CODE",
            "pipeline_unavailable",
            "The local pipeline model service is unavailable",
        ),
    ],
)
async def test_gateway_error_codes_map_to_fixed_errors_without_body_leakage(
    build_model: Callable[..., ModelHarness],
    status_code: int,
    gateway_code: str,
    expected_code: str,
    expected_message: str,
) -> None:
    secret = "provider-body-secret-never-expose"
    harness = build_model(
        lambda request: httpx.Response(
            status_code,
            json={"error": {"code": gateway_code, "message": secret}, "detail": secret},
        )
    )

    with pytest.raises(PipelineModelError) as raised:
        await harness.model.ainvoke([UserMessage(content="hello")])

    _assert_public_error(raised.value, expected_code, expected_message, secret)


async def test_non_json_provider_error_is_fixed_and_does_not_leak_body(
    build_model: Callable[..., ModelHarness],
) -> None:
    secret = "raw-private-provider-body"
    harness = build_model(
        lambda request: httpx.Response(502, content=secret, headers={"x-private": secret})
    )

    with pytest.raises(PipelineModelError) as raised:
        await harness.model.ainvoke([UserMessage(content="hello")])

    _assert_public_error(
        raised.value,
        "model_failed",
        "The model request failed",
        secret,
    )


@pytest.mark.parametrize(
    ("method", "expected_code", "expected_message"),
    [
        (
            "GET",
            "pipeline_unavailable",
            "The local pipeline model service is unavailable",
        ),
        ("POST", "model_timeout", "The model request timed out"),
    ],
)
async def test_transport_timeout_has_fixed_readiness_or_model_mapping(
    build_model: Callable[..., ModelHarness],
    method: str,
    expected_code: str,
    expected_message: str,
) -> None:
    secret = "timeout-provider-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout(secret, request=request)

    harness = build_model(handler)

    with pytest.raises(PipelineModelError) as raised:
        if method == "GET":
            await harness.model.check_ready()
        else:
            await harness.model.ainvoke([UserMessage(content="hello")])

    _assert_public_error(raised.value, expected_code, expected_message, secret)


async def test_transport_failure_maps_to_pipeline_unavailable(
    build_model: Callable[..., ModelHarness],
) -> None:
    secret = "connect-provider-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(secret, request=request)

    harness = build_model(handler)

    with pytest.raises(PipelineModelError) as raised:
        await harness.model.ainvoke([UserMessage(content="hello")])

    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
        secret,
    )


async def test_client_is_reused_and_close_is_idempotent(
    build_model: Callable[..., ModelHarness],
) -> None:
    harness = build_model()

    await harness.model.check_ready()
    first = await harness.model.ainvoke([UserMessage(content="first")])
    second = await harness.model.ainvoke([UserMessage(content="second")])

    assert first.completion == "done"
    assert second.completion == "done"
    assert [request.method for request in harness.requests] == ["GET", "POST", "POST"]
    assert {
        (request.url.scheme, request.url.host, request.url.port)
        for request in harness.requests
    } == {("http", "127.0.0.1", 3457)}
    assert harness.client.close_calls == 0

    await harness.model.aclose()
    await harness.model.aclose()

    assert harness.client.close_calls == 1
    assert harness.client.is_closed is True
    request_count = len(harness.requests)
    with pytest.raises(PipelineModelError) as raised:
        await harness.model.ainvoke([UserMessage(content="after close")])
    _assert_public_error(
        raised.value,
        "pipeline_unavailable",
        "The local pipeline model service is unavailable",
    )
    assert len(harness.requests) == request_count
