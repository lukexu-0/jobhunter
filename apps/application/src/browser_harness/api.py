from __future__ import annotations

import hashlib
import secrets
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Annotated, Literal, Protocol
from uuid import UUID

from fastapi import Body, FastAPI, File, Form, Header, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import ValidationError

from .models import (
    AdditionalInfoQuestionId,
    ApplicationAnswerSuggestionsResponse,
    HarnessConfig,
    HarnessServiceError,
    SessionCommand,
    RuntimeActionRequest,
    RuntimeActionResponse,
    SessionCreateResponse,
    SessionSnapshot,
)


class HarnessSessionService(Protocol):
    async def startup(self) -> None: ...

    async def create_session(
        self,
        *,
        session_id: UUID | None,
        job_url: str,
        allow_domains: Sequence[str],
        auto_submit: bool,
        max_steps: int,
        personal_information: UploadFile,
        resume: UploadFile,
        context: Sequence[UploadFile],
        anecdotes: Sequence[UploadFile],
    ) -> SessionCreateResponse: ...

    def get_snapshot(self, session_id: UUID) -> SessionSnapshot: ...

    async def get_additional_info_suggestions(
        self,
        session_id: UUID,
        question_id: str,
    ) -> ApplicationAnswerSuggestionsResponse: ...

    def stream_events(self, session_id: UUID, last_event_id: int | None) -> AsyncIterator[str]: ...

    async def command(self, session_id: UUID, command: SessionCommand) -> None: ...

    async def runtime_action(
        self,
        session_id: UUID,
        action: RuntimeActionRequest,
    ) -> RuntimeActionResponse: ...

    async def delete(self, session_id: UUID) -> None: ...

    async def shutdown(self) -> None: ...


@dataclass(frozen=True, slots=True)
class HarnessDependencies:
    sessions: HarnessSessionService


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"code": code, "message": message},
        headers={"cache-control": "no-store"},
    )


def create_app(config: HarnessConfig, dependencies: HarnessDependencies) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await dependencies.sessions.startup()
        try:
            yield
        finally:
            await dependencies.sessions.shutdown()

    app = FastAPI(
        title="Jobhunter Browser Harness",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    expected_authorization_digest = hashlib.sha256(
        f"Bearer {config.bearer_token}".encode("utf-8")
    ).digest()

    @app.middleware("http")
    async def enforce_loopback_api_auth(request: Request, call_next):
        if request.url.path.startswith("/v1/"):
            authorization = request.headers.get("authorization", "")
            authorization_digest = hashlib.sha256(authorization.encode("utf-8")).digest()
            if not secrets.compare_digest(authorization_digest, expected_authorization_digest):
                return _error_response(401, "unauthorized", "Unauthorized")
        response = await call_next(request)
        response.headers["cache-control"] = "no-store"
        return response

    @app.exception_handler(HarnessServiceError)
    async def handle_service_error(_request: Request, error: HarnessServiceError) -> JSONResponse:
        if error.code == "session_active" and error.session_id is not None:
            return JSONResponse(
                status_code=409,
                content={"code": "session_active", "session_id": str(error.session_id)},
                headers={"cache-control": "no-store"},
            )
        return _error_response(error.status_code, error.code, error.public_message)

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation(_request: Request, _error: RequestValidationError) -> JSONResponse:
        return _error_response(422, "invalid_request", "Request is invalid")

    @app.exception_handler(ValidationError)
    async def handle_model_validation(_request: Request, _error: ValidationError) -> JSONResponse:
        return _error_response(422, "invalid_request", "Request is invalid")

    @app.exception_handler(Exception)
    async def handle_unexpected_error(_request: Request, _error: Exception) -> JSONResponse:
        return _error_response(500, "internal_error", "Request failed")

    @app.get("/healthz")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/sessions", status_code=202, response_model=SessionCreateResponse)
    async def create_session(
        job_url: Annotated[str, Form()],
        personal_information: Annotated[UploadFile, File()],
        resume: Annotated[UploadFile, File()],
        session_id: Annotated[UUID | None, Form()] = None,
        allow_domain: Annotated[list[str] | None, Form()] = None,
        auto_submit: Annotated[Literal["false", "true"], Form()] = "false",
        max_steps: Annotated[int, Form(ge=1, le=500)] = 100,
        context: Annotated[list[UploadFile] | None, File()] = None,
        anecdote: Annotated[list[UploadFile] | None, File()] = None,
    ) -> SessionCreateResponse:
        allow_domains = allow_domain or []
        context_files = context or []
        anecdote_files = anecdote or []
        if len(allow_domains) > 20 or len(context_files) > 10 or len(anecdote_files) > 20:
            raise HarnessServiceError(422, "invalid_request", "Request is invalid")
        return await dependencies.sessions.create_session(
            session_id=session_id,
            job_url=job_url,
            allow_domains=allow_domains,
            auto_submit=auto_submit == "true",
            max_steps=max_steps,
            personal_information=personal_information,
            resume=resume,
            context=context_files,
            anecdotes=anecdote_files,
        )

    @app.get("/v1/sessions/{session_id}", response_model=SessionSnapshot)
    async def get_session(session_id: UUID) -> SessionSnapshot:
        return dependencies.sessions.get_snapshot(session_id)

    @app.get(
        "/v1/sessions/{session_id}/additional-info/{question_id}/suggestions",
        response_model=ApplicationAnswerSuggestionsResponse,
    )
    async def get_additional_info_suggestions(
        session_id: UUID,
        question_id: AdditionalInfoQuestionId,
        request: Request,
    ) -> ApplicationAnswerSuggestionsResponse:
        if request.query_params or await request.body():
            raise HarnessServiceError(
                422,
                "invalid_request",
                "Request is invalid",
            )
        return await dependencies.sessions.get_additional_info_suggestions(
            session_id,
            question_id,
        )

    @app.get("/v1/sessions/{session_id}/events")
    async def get_events(
        session_id: UUID,
        last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    ) -> StreamingResponse:
        parsed_last_event_id: int | None = None
        if last_event_id is not None:
            try:
                parsed_last_event_id = int(last_event_id)
            except ValueError as error:
                raise HarnessServiceError(422, "invalid_request", "Last-Event-ID must be nonnegative") from error
            if parsed_last_event_id < 0:
                raise HarnessServiceError(422, "invalid_request", "Last-Event-ID must be nonnegative")
        dependencies.sessions.get_snapshot(session_id)
        return StreamingResponse(
            dependencies.sessions.stream_events(session_id, parsed_last_event_id),
            media_type="text/event-stream",
            headers={
                "cache-control": "no-store",
                "connection": "keep-alive",
                "x-accel-buffering": "no",
            },
        )

    @app.post("/v1/sessions/{session_id}/commands", status_code=202)
    async def command_session(
        session_id: UUID,
        command: Annotated[SessionCommand, Body(discriminator="type")],
    ) -> Response:
        await dependencies.sessions.command(session_id, command)
        return Response(status_code=202, headers={"cache-control": "no-store"})

    @app.post(
        "/v1/sessions/{session_id}/runtime/actions",
        response_model=RuntimeActionResponse,
    )
    async def runtime_action(
        session_id: UUID,
        action: Annotated[RuntimeActionRequest, Body(discriminator="type")],
    ) -> RuntimeActionResponse:
        return await dependencies.sessions.runtime_action(session_id, action)


    @app.delete("/v1/sessions/{session_id}", status_code=204)
    async def delete_session(session_id: UUID) -> Response:
        await dependencies.sessions.delete(session_id)
        return Response(status_code=204, headers={"cache-control": "no-store"})

    return app
