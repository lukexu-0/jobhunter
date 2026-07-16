from __future__ import annotations

import asyncio
import json
from typing import Annotated, Any, ClassVar, Literal, TypeVar, overload
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from browser_use.llm.base import BaseChatModel
from browser_use.llm.messages import AssistantMessage, BaseMessage, SystemMessage
from browser_use.llm.schema import SchemaOptimizer
from browser_use.llm.views import ChatInvokeCompletion, ChatInvokeUsage

MODEL_PROVIDER = "openai-codex"
MODEL_NAME = "gpt-5.6-sol"
REASONING = "high"
_GATEWAY_PATH = "/v1/internal/browser-harness/codex"

OutputModel = TypeVar("OutputModel", bound=BaseModel)


class PipelineModelError(RuntimeError):
    """A fixed, public-safe model failure suitable for a session snapshot."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message


class _GatewayStatus(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    modelProvider: Literal["openai-codex"]
    model: Literal["gpt-5.6-sol"]
    reasoning: Literal["high"]
    oauth: Literal["connected"]


class _GatewayUsage(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    inputTokens: int = Field(ge=0)
    outputTokens: int = Field(ge=0)
    totalTokens: int = Field(ge=0)


class _GatewayTextOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    type: Literal["text"]
    text: str


class _GatewayStructuredOutput(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    type: Literal["structured"]
    value: dict[str, Any]


_GatewayOutput = Annotated[
    _GatewayTextOutput | _GatewayStructuredOutput,
    Field(discriminator="type"),
]


class _GatewayCompletion(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    modelProvider: Literal["openai-codex"]
    model: Literal["gpt-5.6-sol"]
    reasoning: Literal["high"]
    output: _GatewayOutput
    usage: _GatewayUsage


_ERROR_MESSAGES: ClassVar[dict[str, tuple[str, str]]] = {
    "OAUTH_REQUIRED": ("oauth_required", "Connect OpenAI Codex in Provider access"),
    "MODEL_TIMEOUT": ("model_timeout", "The model request timed out"),
    "INVALID_MODEL_OUTPUT": ("invalid_model_output", "The model returned invalid output"),
    "MODEL_PROVIDER_FAILED": ("model_failed", "The model request failed"),
}


def _normalize_pipeline_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError("pipeline_url must be a loopback HTTP origin")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError("pipeline_url has an invalid port") from error
    host = f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname
    netloc = f"{host}:{parsed.port}" if parsed.port is not None else str(host)
    return urlunsplit(("http", netloc, "", "", ""))


def _message_text(message: BaseMessage) -> str:
    text = message.text
    if isinstance(message, AssistantMessage) and message.tool_calls:
        calls = [
            json.dumps(
                {
                    "id": call.id,
                    "name": call.function.name,
                    "arguments": call.function.arguments,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            for call in message.tool_calls
        ]
        return "\n".join([text, *calls]) if text else "\n".join(calls)
    return text


def _serialize_messages(messages: list[BaseMessage]) -> tuple[str, str]:
    system_parts: list[str] = []
    transcript_parts: list[str] = []
    for message in messages:
        text = _message_text(message)
        if isinstance(message, SystemMessage):
            system_parts.append(text)
        else:
            transcript_parts.append(f"[{message.role.upper()}]\n{text}")
    return "\n\n".join(system_parts), "\n\n".join(transcript_parts)


class PipelineOAuthChatModel(BaseChatModel):
    _verified_api_keys = True
    model = MODEL_NAME
    reasoning = REASONING

    def __init__(self, session_id: UUID, pipeline_url: str, bearer_token: str) -> None:
        if len(bearer_token) < 32:
            raise ValueError("bearer_token must contain at least 32 characters")
        self._session_id = session_id
        self._pipeline_url = _normalize_pipeline_url(pipeline_url)
        self._client = httpx.AsyncClient(
            base_url=self._pipeline_url,
            headers={"Authorization": f"Bearer {bearer_token}"},
            timeout=httpx.Timeout(300.0),
            trust_env=False,
        )
        self._closed = False
        self._close_task: asyncio.Task[None] | None = None

    @property
    def provider(self) -> str:
        return MODEL_PROVIDER

    @property
    def name(self) -> str:
        return MODEL_NAME

    @property
    def model_name(self) -> str:
        return MODEL_NAME

    async def aclose(self) -> None:
        if self._closed:
            return
        if self._close_task is None:
            if self._client.is_closed:
                transport = getattr(self._client, "_transport", None)
                transport_close = getattr(transport, "aclose", None)
                if not callable(transport_close):
                    raise RuntimeError("The model transport cannot be closed")
                self._close_task = asyncio.create_task(transport_close())
            else:
                self._close_task = asyncio.create_task(self._client.aclose())
        try:
            await asyncio.shield(self._close_task)
        except Exception:
            self._close_task = None
            raise
        self._closed = True

    async def check_ready(self) -> None:
        response = await self._send("GET", timeout_is_model_error=False)
        try:
            status = _GatewayStatus.model_validate(response.json())
        except (ValueError, ValidationError):
            raise PipelineModelError("pipeline_unavailable", "The local pipeline model service is unavailable") from None
        if (
            status.modelProvider != MODEL_PROVIDER
            or status.model != MODEL_NAME
            or status.reasoning != REASONING
            or status.oauth != "connected"
        ):
            raise PipelineModelError("pipeline_unavailable", "The local pipeline model service is unavailable")

    @overload
    async def ainvoke(
        self,
        messages: list[BaseMessage],
        output_format: None = None,
        **kwargs: Any,
    ) -> ChatInvokeCompletion[str]: ...

    @overload
    async def ainvoke(
        self,
        messages: list[BaseMessage],
        output_format: type[OutputModel],
        **kwargs: Any,
    ) -> ChatInvokeCompletion[OutputModel]: ...

    async def ainvoke(
        self,
        messages: list[BaseMessage],
        output_format: type[OutputModel] | None = None,
        **kwargs: Any,
    ) -> ChatInvokeCompletion[OutputModel] | ChatInvokeCompletion[str]:
        del kwargs
        system_prompt, transcript = _serialize_messages(messages)
        request: dict[str, Any] = {
            "sessionId": str(self._session_id),
            "systemPrompt": system_prompt,
            "transcript": transcript,
        }
        if output_format is not None:
            request["outputSchema"] = SchemaOptimizer.create_optimized_json_schema(output_format)
        response = await self._send("POST", json=request, timeout_is_model_error=True)
        try:
            gateway = _GatewayCompletion.model_validate(response.json())
        except (ValueError, ValidationError):
            raise PipelineModelError("invalid_model_output", "The model returned invalid output") from None
        if (
            gateway.modelProvider != MODEL_PROVIDER
            or gateway.model != MODEL_NAME
            or gateway.reasoning != REASONING
        ):
            raise PipelineModelError("invalid_model_output", "The model returned invalid output")

        usage = ChatInvokeUsage(
            prompt_tokens=gateway.usage.inputTokens,
            prompt_cached_tokens=None,
            prompt_cache_creation_tokens=None,
            prompt_cache_creation_5m_tokens=None,
            prompt_cache_creation_1h_tokens=None,
            prompt_image_tokens=None,
            completion_tokens=gateway.usage.outputTokens,
            total_tokens=gateway.usage.totalTokens,
        )
        if output_format is None:
            if not isinstance(gateway.output, _GatewayTextOutput):
                raise PipelineModelError("invalid_model_output", "The model returned invalid output")
            return ChatInvokeCompletion(completion=gateway.output.text, usage=usage)
        if not isinstance(gateway.output, _GatewayStructuredOutput):
            raise PipelineModelError("invalid_model_output", "The model returned invalid output")
        try:
            completion = output_format.model_validate(gateway.output.value)
        except ValidationError:
            raise PipelineModelError("invalid_model_output", "The model returned invalid output") from None
        return ChatInvokeCompletion(completion=completion, usage=usage)

    async def _send(
        self,
        method: str,
        *,
        json: dict[str, Any] | None = None,
        timeout_is_model_error: bool,
    ) -> httpx.Response:
        if self._closed:
            raise PipelineModelError("pipeline_unavailable", "The local pipeline model service is unavailable")
        try:
            response = await self._client.request(method, _GATEWAY_PATH, json=json)
        except httpx.TimeoutException as error:
            if timeout_is_model_error:
                raise PipelineModelError("model_timeout", "The model request timed out") from error
            raise PipelineModelError("pipeline_unavailable", "The local pipeline model service is unavailable") from error
        except httpx.RequestError as error:
            raise PipelineModelError("pipeline_unavailable", "The local pipeline model service is unavailable") from error
        if response.status_code < 400:
            return response
        gateway_code: str | None = None
        try:
            body = response.json()
            if isinstance(body, dict):
                error_value = body.get("error")
                if isinstance(error_value, dict) and isinstance(error_value.get("code"), str):
                    gateway_code = error_value["code"]
        except ValueError:
            pass
        mapped = _ERROR_MESSAGES.get(gateway_code or "")
        if mapped is not None and (timeout_is_model_error or gateway_code == "OAUTH_REQUIRED"):
            raise PipelineModelError(*mapped)
        if not timeout_is_model_error or response.status_code == 401:
            raise PipelineModelError("pipeline_unavailable", "The local pipeline model service is unavailable")
        raise PipelineModelError("model_failed", "The model request failed")
