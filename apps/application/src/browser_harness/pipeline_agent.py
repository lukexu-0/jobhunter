from __future__ import annotations

import asyncio
from typing import Any, Final, Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

import httpx
from pydantic import BaseModel, ConfigDict, ValidationError

from .models import ApplicationRunResult, OpportunityKind

MODEL_PROVIDER = "openai-codex"
MODEL_NAME = "gpt-5.6-sol"
REASONING = "high"
_AGENT_PATH = "/v1/internal/application-agent"


class PipelineApplicationAgentError(RuntimeError):
    """A fixed, public-safe application agent failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message


_ERROR_RESPONSES: Final[dict[tuple[int, str], tuple[str, str]]] = {
    (422, "INVALID_REQUEST"): ("invalid_request", "Request is invalid"),
    (409, "OAUTH_REQUIRED"): (
        "oauth_required",
        "Connect OpenAI Codex in Provider access",
    ),
    (504, "MODEL_TIMEOUT"): ("model_timeout", "The model request timed out"),
    (502, "INVALID_MODEL_OUTPUT"): (
        "invalid_model_output",
        "The model returned invalid output",
    ),
    (502, "MODEL_PROVIDER_FAILED"): (
        "model_failed",
        "The model request failed",
    ),
    (409, "APPLICATION_MISMATCH"): (
        "application_mismatch",
        "The open page does not match the requested job",
    ),
    (409, "STEP_LIMIT"): (
        "step_limit",
        "The application step limit was reached",
    ),
    (502, "BROWSER_FAILED"): (
        "browser_failed",
        "The browser session failed",
    ),
}


class _AgentStatus(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    modelProvider: Literal["openai-codex"]
    model: Literal["gpt-5.6-sol"]
    reasoning: Literal["high"]
    oauth: Literal["connected"]


class _AgentRunSuccess(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    modelProvider: Literal["openai-codex"]
    model: Literal["gpt-5.6-sol"]
    reasoning: Literal["high"]
    result: ApplicationRunResult


def _normalize_loopback_origin(value: str, *, name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a loopback HTTP origin")
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
        raise ValueError(f"{name} must be a loopback HTTP origin")
    try:
        parsed.port
    except ValueError as error:
        raise ValueError(f"{name} has an invalid port") from error
    host = f"[{parsed.hostname}]" if parsed.hostname == "::1" else parsed.hostname
    netloc = f"{host}:{parsed.port}" if parsed.port is not None else str(host)
    return urlunsplit(("http", netloc, "", "", ""))


def _validate_utf8_text(value: object, *, name: str, max_bytes: int) -> None:
    if not isinstance(value, str):
        raise ValueError(f"{name} is invalid")
    try:
        encoded_size = len(value.encode("utf-8"))
    except UnicodeEncodeError:
        raise ValueError(f"{name} is invalid") from None
    if encoded_size > max_bytes:
        raise ValueError(f"{name} is invalid")


class PipelineApplicationAgentClient:
    def __init__(self, session_id: UUID, pipeline_url: str, bearer_token: str) -> None:
        if len(bearer_token) < 32:
            raise ValueError("bearer_token must contain at least 32 characters")
        self._session_id = session_id
        self._client = httpx.AsyncClient(
            base_url=_normalize_loopback_origin(pipeline_url, name="pipeline_url"),
            headers={"Authorization": f"Bearer {bearer_token}"},
            timeout=httpx.Timeout(300.0),
            trust_env=False,
        )
        self._closed = False
        self._close_task: asyncio.Task[None] | None = None

    async def check_ready(self) -> None:
        response = await self._send("GET", timeout_is_model_error=False)
        try:
            _AgentStatus.model_validate(response.json())
        except (ValueError, ValidationError):
            raise PipelineApplicationAgentError(
                "pipeline_unavailable",
                "The local pipeline model service is unavailable",
            ) from None

    async def run(
        self,
        *,
        runtime_url: str,
        opportunity_kind: OpportunityKind,
        auto_submit: bool,
        task: str,
        max_turns: int,
        deadline_ms: int,
    ) -> ApplicationRunResult:
        runtime_origin = _normalize_loopback_origin(
            runtime_url, name="runtime_url"
        )
        if opportunity_kind not in (
            "job",
            "hackathon",
            "competition",
            "event",
        ):
            raise ValueError("opportunity_kind is invalid")
        if type(auto_submit) is not bool:
            raise ValueError("auto_submit is invalid")
        _validate_utf8_text(task, name="task", max_bytes=1_048_576)
        if type(max_turns) is not int or not 1 <= max_turns <= 500:
            raise ValueError("max_turns is invalid")
        if (
            type(deadline_ms) is not int
            or not 1_000 <= deadline_ms <= 86_400_000
        ):
            raise ValueError("deadline_ms is invalid")
        response = await self._send(
            "POST",
            json={
                "sessionId": str(self._session_id),
                "runtimeUrl": runtime_origin,
                "opportunityKind": opportunity_kind,
                "task": task,
                "autoSubmit": auto_submit,
                "maxTurns": max_turns,
                "deadlineMs": deadline_ms,
            },
            timeout=deadline_ms / 1_000 + 60,
            timeout_is_model_error=True,
        )
        try:
            success = _AgentRunSuccess.model_validate(response.json())
        except (ValueError, ValidationError):
            raise PipelineApplicationAgentError(
                "invalid_model_output", "The model returned invalid output"
            ) from None
        return success.result

    async def aclose(self) -> None:
        if self._closed:
            return
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._client.aclose())
        try:
            await asyncio.shield(self._close_task)
        except Exception:
            self._close_task = None
            raise
        self._closed = True

    async def _send(
        self,
        method: str,
        *,
        json: dict[str, Any] | None = None,
        timeout: float | None = None,
        timeout_is_model_error: bool,
    ) -> httpx.Response:
        if self._closed:
            raise PipelineApplicationAgentError(
                "pipeline_unavailable",
                "The local pipeline model service is unavailable",
            )
        try:
            if timeout is None:
                response = await self._client.request(
                    method, _AGENT_PATH, json=json
                )
            else:
                response = await self._client.request(
                    method, _AGENT_PATH, json=json, timeout=timeout
                )
        except httpx.TimeoutException as error:
            if timeout_is_model_error:
                raise PipelineApplicationAgentError(
                    "model_timeout", "The model request timed out"
                ) from error
            raise PipelineApplicationAgentError(
                "pipeline_unavailable",
                "The local pipeline model service is unavailable",
            ) from error
        except httpx.RequestError as error:
            raise PipelineApplicationAgentError(
                "pipeline_unavailable",
                "The local pipeline model service is unavailable",
            ) from error
        if response.status_code != 200:
            gateway_code: str | None = None
            try:
                body = response.json()
                if isinstance(body, dict):
                    error_value = body.get("error")
                    if isinstance(error_value, dict):
                        candidate = error_value.get("code")
                        if isinstance(candidate, str):
                            gateway_code = candidate
            except ValueError:
                pass
            mapped = _ERROR_RESPONSES.get(
                (response.status_code, gateway_code or "")
            )
            if mapped is not None and (
                timeout_is_model_error or gateway_code == "OAUTH_REQUIRED"
            ):
                raise PipelineApplicationAgentError(*mapped)
            if response.status_code == 401:
                raise PipelineApplicationAgentError(
                    "pipeline_unavailable",
                    "The local pipeline model service is unavailable",
                )
            if timeout_is_model_error:
                raise PipelineApplicationAgentError(
                    "model_failed", "The model request failed"
                )
            raise PipelineApplicationAgentError(
                "pipeline_unavailable",
                "The local pipeline model service is unavailable",
            )
        return response
