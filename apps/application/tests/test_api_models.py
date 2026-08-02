from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi import UploadFile
from pydantic import TypeAdapter, ValidationError

from jobhunter_browser_harness.api import HarnessDependencies, create_app
from jobhunter_browser_harness.models import (
    SESSION_ERROR_MESSAGES,
    AdditionalInfoRuntimeActionResponse,
    ApplicationRunResult,
    ReviewApplicationResult,
    ApproveRuntimeActionResponse,
    BrowserUseResultRuntimeActionResponse,
    BrowserUseExecutionResult,
    BrowserUseRuntimeAction,
    CancelledApplicationResult,
    CancelRuntimeActionResponse,
    ContinueRuntimeActionResponse,
    ProvideAdditionalInfoCommand,
    ApproveOriginCommand,
    BrowserLaunchConfig,
    CancelCommand,
    ContinueCommand,
    FieldResult,
    HarnessConfig,
    HarnessServiceError,
    RequestAdditionalInfoRuntimeAction,
    RequestHumanNavigationRuntimeAction,
    RequestHumanReviewRuntimeAction,
    RequestOriginApprovalRuntimeAction,
    ReportApplicationMismatchRuntimeAction,
    PostSubmitConfirmation,
    ReviseRuntimeActionResponse,
    RuntimeActionRequest,
    RuntimeActionResponse,
    SubmitRuntimeActionResponse,
    SubmitCommand,
    ReviseCommand,
    SessionCommand,
    SubmittedApplicationResult,
    SubmissionUncertainApplicationResult,
    SessionCreateResponse,
    SessionError,
    SessionSnapshot,
    sanitize_public_url,
    session_error,
    validate_approved_origin,
    validate_https_origin,
    validate_job_url,
)

TOKEN = "test-token-0123456789abcdef-0123456789"
SESSION_ID = UUID("39bb70b2-5ea4-4937-8090-32d7404ad597")
AUTHORIZATION = {"Authorization": f"Bearer {TOKEN}"}
COMMAND_ADAPTER = TypeAdapter(SessionCommand)
RUNTIME_ACTION_ADAPTER = TypeAdapter(RuntimeActionRequest)
RUNTIME_ACTION_RESPONSE_ADAPTER = TypeAdapter(RuntimeActionResponse)
NOW = datetime(2026, 7, 13, 12, 0, tzinfo=UTC)


def make_snapshot(**overrides: Any) -> SessionSnapshot:
    values: dict[str, Any] = {
        "session_id": SESSION_ID,
        "state": "awaiting_human_review",
        "created_at": NOW,
        "updated_at": NOW,
        "expires_at": NOW + timedelta(hours=1),
        "job_url": "https://jobs.example/apply?candidate=private#ignored",
        "company": "Example Corp",
        "role": "Engineer",
        "fields_filled": [
            {
                "label": "Email",
                "field_type": "text",
                "value_present": True,
                "note": "",
            }
        ],
        "fields_needing_human": [],
        "files_attached": ["resume.pdf"],
        "browser_use_diagnostics": [
            {
                "step": 1,
                "status": "failed",
                "exit_code": 7,
                "timed_out": False,
                "error_category": "process_exit",
                "stderr_excerpt": "[redacted]",
                "stderr_truncated": True,
            }
        ],
        "warnings": [],
        "revision_count": 0,
        "pending_action": {"type": "human_review"},
        "approved_origins": ["https://jobs.example"],
        "error": None,
    }
    values.update(overrides)
    return SessionSnapshot.model_validate(values)


@dataclass(slots=True)
class FakeSessionService:
    snapshot: SessionSnapshot = field(default_factory=make_snapshot)
    create_error: HarnessServiceError | None = None
    snapshot_error: Exception | None = None
    create_calls: list[dict[str, Any]] = field(default_factory=list)
    snapshot_calls: list[UUID] = field(default_factory=list)
    event_calls: list[tuple[UUID, int | None]] = field(default_factory=list)
    command_calls: list[tuple[UUID, SessionCommand]] = field(default_factory=list)
    runtime_action_calls: list[tuple[UUID, RuntimeActionRequest]] = field(
        default_factory=list
    )
    runtime_action_response: RuntimeActionResponse = field(
        default_factory=lambda: ContinueRuntimeActionResponse(type="continue")
    )
    delete_calls: list[UUID] = field(default_factory=list)
    shutdown_calls: int = 0

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
    ) -> SessionCreateResponse:
        if self.create_error is not None:
            raise self.create_error
        self.create_calls.append(
            {
                "session_id": session_id,
                "job_url": job_url,
                "allow_domains": list(allow_domains),
                "auto_submit": auto_submit,
                "max_steps": max_steps,
                "personal_information": (
                    personal_information.filename,
                    await personal_information.read(),
                ),
                "resume": (resume.filename, await resume.read()),
                "context": [
                    (upload.filename, await upload.read()) for upload in context
                ],
                "anecdotes": [
                    (upload.filename, await upload.read()) for upload in anecdotes
                ],
            }
        )
        return SessionCreateResponse(
            session_id=SESSION_ID,
            events_url=f"http://127.0.0.1:8765/v1/sessions/{SESSION_ID}/events",
            commands_url=f"http://127.0.0.1:8765/v1/sessions/{SESSION_ID}/commands",
        )

    def get_snapshot(self, session_id: UUID) -> SessionSnapshot:
        self.snapshot_calls.append(session_id)
        if self.snapshot_error is not None:
            raise self.snapshot_error
        if session_id != SESSION_ID:
            raise HarnessServiceError(404, "session_not_found", "Session not found")
        return self.snapshot

    async def stream_events(
        self, session_id: UUID, last_event_id: int | None
    ) -> AsyncIterator[str]:
        self.event_calls.append((session_id, last_event_id))
        yield 'id: 3\nevent: agent_step\ndata: {"step_number":2}\n\n'
        yield ": heartbeat\n\n"

    async def command(self, session_id: UUID, command: SessionCommand) -> None:
        if session_id != SESSION_ID:
            raise HarnessServiceError(404, "session_not_found", "Session not found")
        self.command_calls.append((session_id, command))

    async def runtime_action(
        self,
        session_id: UUID,
        action: RuntimeActionRequest,
    ) -> RuntimeActionResponse:
        if session_id != SESSION_ID:
            raise HarnessServiceError(404, "session_not_found", "Session not found")
        self.runtime_action_calls.append((session_id, action))
        return self.runtime_action_response

    async def delete(self, session_id: UUID) -> None:
        if session_id != SESSION_ID:
            raise HarnessServiceError(404, "session_not_found", "Session not found")
        # Repeated deletion deliberately remains successful, like a retained tombstone.
        self.delete_calls.append(session_id)

    async def shutdown(self) -> None:
        self.shutdown_calls += 1


@pytest.fixture
async def api_client() -> AsyncIterator[tuple[httpx.AsyncClient, FakeSessionService]]:
    service = FakeSessionService()
    app = create_app(
        HarnessConfig(bearer_token=TOKEN),
        HarnessDependencies(sessions=service),
    )
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://harness.test") as client:
        yield client, service


def multipart_parts(
    *,
    domains: Sequence[str] = (),
    contexts: int = 0,
    anecdotes: int = 0,
    max_steps: int | str = 100,
    session_id: UUID | str | None = None,
    auto_submit: bool | str | None = None,
) -> list[tuple[str, tuple[None, str] | tuple[str, bytes, str]]]:
    parts: list[tuple[str, tuple[None, str] | tuple[str, bytes, str]]] = [
        ("job_url", (None, "https://jobs.example/openings/42?source=board")),
        ("max_steps", (None, str(max_steps))),
        (
            "personal_information",
            ("profile.md", b"---\nfull_name: Test Person\n---\nProfile", "text/markdown"),
        ),
        ("resume", ("resume.pdf", b"%PDF-1.7 synthetic", "application/pdf")),
    ]
    if auto_submit is not None:
        parts.insert(0, ("auto_submit", (None, str(auto_submit).lower())))
    if session_id is not None:
        parts.insert(0, ("session_id", (None, str(session_id))))
    parts.extend(("allow_domain", (None, domain)) for domain in domains)
    parts.extend(
        (
            "context",
            (f"context-{index}.md", f"context {index}".encode(), "text/markdown"),
        )
        for index in range(contexts)
    )
    parts.extend(
        (
            "anecdote",
            (f"anecdote-{index}.txt", f"anecdote {index}".encode(), "text/plain"),
        )
        for index in range(anecdotes)
    )
    return parts


def test_harness_config_requires_long_token_and_loopback_pipeline() -> None:
    config = HarnessConfig(
        bearer_token="x" * 32,
        pipeline_url="http://LOCALHOST:3457/",
        port=65_535,
        session_timeout=1,
    )
    assert config.pipeline_url == "http://LOCALHOST:3457"

    for token in ("", "x" * 31):
        with pytest.raises(ValidationError):
            HarnessConfig(bearer_token=token)

    for pipeline_url in (
        "https://127.0.0.1:3457",
        "http://pipeline.example:3457",
        "http://user:password@127.0.0.1:3457",
        "http://127.0.0.1:3457?token=secret",
        "http://127.0.0.1:3457/#fragment",
    ):
        with pytest.raises(ValidationError):
            HarnessConfig(bearer_token=TOKEN, pipeline_url=pipeline_url)


@pytest.mark.parametrize(
    "cdp_url",
    [
        "http://127.0.0.1:9222",
        "http://localhost:9222/",
        "http://[::1]:9222",
    ],
)
def test_browser_config_accepts_only_loopback_http_cdp(cdp_url: str) -> None:
    assert BrowserLaunchConfig(cdp_url=cdp_url).cdp_url == cdp_url.rstrip("/")


@pytest.mark.parametrize(
    "cdp_url",
    [
        "https://127.0.0.1:9222",
        "http://192.0.2.8:9222",
        "http://user:secret@localhost:9222",
        "http://localhost:9222?secret=yes",
        "http://localhost:9222/#fragment",
    ],
)
def test_browser_config_rejects_non_loopback_or_decorated_cdp(cdp_url: str) -> None:
    with pytest.raises(ValidationError):
        BrowserLaunchConfig(cdp_url=cdp_url)


def test_browser_config_rejects_cdp_and_local_executable_together() -> None:
    with pytest.raises(ValidationError):
        BrowserLaunchConfig(
            cdp_url="http://localhost:9222",
            chrome_executable=Path("/opt/chrome"),
        )


def test_job_url_validation_preserves_private_path_and_query() -> None:
    private_url = "https://Jobs.Example/openings/42?candidate=private"
    assert validate_job_url(private_url) == private_url
    assert validate_job_url("http://127.0.0.1:8080/form?fixture=1").endswith(
        "/form?fixture=1"
    )

    for invalid in (
        "http://jobs.example/openings/42",
        "https://user:secret@jobs.example/openings/42",
        "https://jobs.example/openings/42#apply",
        "/openings/42",
    ):
        with pytest.raises((TypeError, ValueError)):
            validate_job_url(invalid)


def test_public_url_removes_userinfo_query_and_fragment() -> None:
    public = sanitize_public_url(
        "HTTPS://user:secret@Jobs.Example:443/apply/42?email=private#answer"
    )
    assert public == "https://jobs.example/apply/42"
    assert all(secret not in public for secret in ("user", "secret", "email", "answer"))


def test_origins_are_canonical_exact_and_do_not_admit_lookalikes() -> None:
    approved = validate_https_origin("HTTPS://ATS.Example/")
    lookalike = validate_https_origin("https://ats.example.evil/")

    assert approved == "https://ats.example"
    assert validate_https_origin("https://ats.example:443") == approved
    assert lookalike == "https://ats.example.evil"
    assert approved != lookalike
    assert not f"{lookalike}/".startswith(f"{approved}/")
    assert validate_approved_origin("http://LOCALHOST:8080/") == "http://localhost:8080"

    for invalid in (
        "http://ats.example",
        "https://user:secret@ats.example",
        "https://ats.example/path",
        "https://ats.example?next=evil",
        "https://ats.example#fragment",
        "https://*.example",
    ):
        with pytest.raises((TypeError, ValueError)):
            validate_https_origin(invalid)


def test_field_result_enforces_bounds_and_never_contains_a_value() -> None:
    result = FieldResult(
        label="L" * 500,
        field_type="textarea",
        value_present=True,
        note="N" * 1_000,
    )
    assert result.model_dump() == {
        "label": "L" * 500,
        "field_type": "textarea",
        "value_present": True,
        "note": "N" * 1_000,
    }
    assert "value" not in FieldResult.model_fields

    for update in (
        {"label": ""},
        {"label": "L" * 501},
        {"note": "N" * 1_001},
        {"field_type": "password"},
        {"value_present": 1},
        {"value": "private answer"},
    ):
        values: dict[str, Any] = {
            "label": "Question",
            "field_type": "text",
            "value_present": False,
        }
        values.update(update)
        with pytest.raises(ValidationError):
            FieldResult.model_validate(values)


def test_review_application_result_sanitizes_urls_and_forces_submit_false() -> None:
    result = ReviewApplicationResult(
        status="ready_for_submission",
        company="C" * 500,
        role="R" * 500,
        job_url="https://user:secret@jobs.example/apply?candidate=private#fragment",
        final_url="https://ats.example/form/42?answer=private#review",
        fields_filled=[
            FieldResult(
                label="Email",
                field_type="text",
                value_present=True,
                note="filled from explicit profile data",
            )
        ],
        files_attached=[f"file-{index}.pdf" for index in range(20)],
        warnings=[f"warning {index}" for index in range(100)],
        revision_count=100,
    )
    dumped = result.model_dump(mode="json")

    assert dumped["job_url"] == "https://jobs.example/apply"
    assert dumped["final_url"] == "https://ats.example/form/42"
    assert dumped["submit_attempted"] is False
    serialized = result.model_dump_json()
    for private in ("user", "secret", "candidate", "answer", "private"):
        assert private not in serialized

    with pytest.raises(ValidationError):
        ReviewApplicationResult.model_validate(
            {
                **dumped,
                "submit_attempted": True,
            }
        )

@pytest.mark.parametrize(
    ("field", "value_present"),
    [
        ("fields_filled", False),
        ("fields_needing_human", True),
    ],
)
def test_application_result_field_groups_require_matching_presence(
    field: str,
    value_present: bool,
) -> None:
    values = ReviewApplicationResult(
        status="ready_for_submission",
        job_url="https://jobs.example/openings/42",
        final_url="https://ats.example/application/42",
    ).model_dump()
    values[field] = [
        {
            "label": "Candidate response",
            "field_type": "text",
            "value_present": value_present,
        }
    ]

    with pytest.raises(ValidationError):
        ReviewApplicationResult.model_validate(values)


def test_terminal_application_results_have_strict_submission_evidence() -> None:
    base = {
        **ReviewApplicationResult(
            status="ready_for_submission",
            company="Example Corp",
            role="Engineer",
            job_url="https://jobs.example/openings/42",
            final_url="https://ats.example/application/42",
            files_attached=["resume.pdf"],
            revision_count=2,
        ).model_dump(),
        "status": "submitted",
        "submit_attempted": True,
        "submission_confirmation": {
            "type": "post_submit_confirmation",
            "text": "  Application received.  ",
        },
    }
    submitted = SubmittedApplicationResult.model_validate(base)

    assert submitted.submission_confirmation == PostSubmitConfirmation(
        type="post_submit_confirmation",
        text="Application received.",
    )
    assert TypeAdapter(ApplicationRunResult).validate_python(base) == submitted

    uncertain = SubmissionUncertainApplicationResult.model_validate(
        {
            **base,
            "status": "submission_uncertain",
            "submission_confirmation": None,
        }
    )
    assert uncertain.submit_attempted is True
    assert uncertain.submission_confirmation is None

    cancelled = CancelledApplicationResult.model_validate(
        {
            **base,
            "status": "cancelled",
            "submit_attempted": False,
            "submission_confirmation": None,
        }
    )
    assert cancelled.submit_attempted is False

    for invalid_text in ("   ", "x" * 1_001):
        with pytest.raises(ValidationError):
            SubmittedApplicationResult.model_validate(
                {
                    **base,
                    "submission_confirmation": {
                        "type": "post_submit_confirmation",
                        "text": invalid_text,
                    },
                }
            )

    for invalid in (
        {**base, "submit_attempted": False},
        {**base, "submission_confirmation": None},
        {
            **base,
            "status": "submission_uncertain",
            "submission_confirmation": base["submission_confirmation"],
        },
        {
            **base,
            "status": "cancelled",
            "submit_attempted": True,
            "submission_confirmation": None,
        },
    ):
        with pytest.raises(ValidationError):
            TypeAdapter(ApplicationRunResult).validate_python(invalid)


@pytest.mark.parametrize(
    ("field", "invalid_value"),
    [
        ("company", "C" * 501),
        ("role", "R" * 501),
        (
            "fields_filled",
            [
                {
                    "label": "Field",
                    "field_type": "text",
                    "value_present": True,
                }
            ]
            * 501,
        ),
        (
            "fields_needing_human",
            [
                {
                    "label": "Field",
                    "field_type": "text",
                    "value_present": False,
                }
            ]
            * 501,
        ),
        ("files_attached", [f"file-{index}.pdf" for index in range(21)]),
        ("files_attached", ["../resume.pdf"]),
        ("warnings", ["warning"] * 101),
        ("warnings", ["W" * 1_001]),
        ("revision_count", -1),
        ("revision_count", 101),
    ],
)
def test_application_result_rejects_public_bounds(field: str, invalid_value: Any) -> None:
    values: dict[str, Any] = {
        "status": "cancelled",
        "job_url": "https://jobs.example/posting",
        "final_url": "https://jobs.example/posting",
        "submit_attempted": False,
        "submission_confirmation": None,
        field: invalid_value,
    }
    with pytest.raises(ValidationError):
        TypeAdapter(ApplicationRunResult).validate_python(values)


def test_session_errors_are_limited_to_the_fixed_catalog() -> None:
    expected = {
        "oauth_required": "Connect OpenAI Codex in Provider access",
        "pipeline_unavailable": "The local pipeline model service is unavailable",
        "model_timeout": "The model request timed out",
        "invalid_model_output": "The model returned invalid output",
        "model_failed": "The model request failed",
        "browser_failed": "The browser session failed",
        "application_mismatch": "The open page does not match the requested job",
        "step_limit": "The application step limit was reached",
        "session_timeout": "The application session expired",
    }
    assert dict(SESSION_ERROR_MESSAGES) == expected
    assert {
        code: session_error(code).model_dump()  # type: ignore[arg-type]
        for code in expected
    } == {
        code: {"code": code, "message": message}
        for code, message in expected.items()
    }

    with pytest.raises(ValidationError):
        SessionError(code="model_failed", message="provider said secret-token")
    with pytest.raises(ValidationError):
        SessionError.model_validate({"code": "new_error", "message": "anything"})
    with pytest.raises(TypeError):
        SESSION_ERROR_MESSAGES["model_failed"] = "changed"  # type: ignore[index]


@pytest.mark.parametrize(
    ("state", "pending_action"),
    [
        (
            "awaiting_human_navigation",
            {
                "type": "human_navigation",
                "instruction": "Complete identity verification",
            },
        ),
        (
            "awaiting_origin_approval",
            {
                "type": "origin_approval",
                "origin": "HTTPS://ATS.Example/",
            },
        ),
        (
            "awaiting_additional_info",
            {
                "type": "additional_info",
                "questions": [
                    {
                        "id": "availability",
                        "key": "availability.start_date",
                        "scope": "global",
                        "question": "When can you start?",
                        "answer_type": "text",
                    }
                ],
            },
        ),
        ("awaiting_human_review", {"type": "human_review"}),
    ],
)
def test_pending_action_exactly_matches_awaiting_state(
    state: str,
    pending_action: dict[str, Any],
) -> None:
    snapshot = make_snapshot(state=state, pending_action=pending_action)

    assert snapshot.pending_action is not None
    dumped = snapshot.pending_action.model_dump(mode="json")
    assert dumped["type"] == pending_action["type"]
    if state == "awaiting_origin_approval":
        assert dumped["origin"] == "https://ats.example"

    with pytest.raises(ValidationError):
        make_snapshot(state="running", pending_action=pending_action)
    with pytest.raises(ValidationError):
        make_snapshot(state=state, pending_action=None)


@pytest.mark.parametrize(
    "state",
    ["submitting", "submitted", "submission_uncertain"],
)
def test_submission_session_states_are_strict_and_have_no_pending_action(
    state: str,
) -> None:
    snapshot = make_snapshot(state=state, pending_action=None)

    assert snapshot.state == state
    assert snapshot.pending_action is None
    assert snapshot.error is None


def test_session_snapshot_requires_a_nonnegative_absolute_expiry() -> None:
    assert make_snapshot().expires_at == NOW + timedelta(hours=1)

    values = make_snapshot().model_dump()
    del values["expires_at"]
    with pytest.raises(ValidationError):
        SessionSnapshot.model_validate(values)
    with pytest.raises(ValidationError):
        make_snapshot(expires_at=NOW - timedelta(microseconds=1))


def test_session_snapshot_releases_slot_only_after_terminal_cleanup() -> None:
    assert make_snapshot().slot_released is False
    released = make_snapshot(
        state="failed",
        pending_action=None,
        error=session_error("session_timeout"),
        slot_released=True,
    )
    assert released.slot_released is True

    with pytest.raises(ValidationError):
        make_snapshot(slot_released=True)


@pytest.mark.parametrize(
    ("payload", "command_type"),
    [
        ({"type": "continue"}, ContinueCommand),
        ({"type": "approve_origin", "origin": "HTTPS://ATS.Example/"}, ApproveOriginCommand),
        ({"type": "revise", "context": "  Correct this field.  "}, ReviseCommand),
        ({"type": "submit"}, SubmitCommand),
        ({"type": "cancel"}, CancelCommand),
        (
            {
                "type": "provide_additional_info",
                "answers": [
                    {
                        "id": "summer_availability",
                        "status": "answered",
                        "value": "June through August 2027",
                    },
                    {
                        "id": "referral_source",
                        "status": "declined",
                    },
                ],
            },
            ProvideAdditionalInfoCommand,
        ),
    ],
)
def test_command_union_uses_strict_discriminators(
    payload: dict[str, Any], command_type: type[SessionCommand]
) -> None:
    command = COMMAND_ADAPTER.validate_python(payload)
    assert isinstance(command, command_type)
    if isinstance(command, ApproveOriginCommand):
        assert command.origin == "https://ats.example"
    if isinstance(command, ReviseCommand):
        assert command.context == "Correct this field."


def test_revision_command_accepts_twenty_thousand_trimmed_characters() -> None:
    context = "x" * 20_000
    command = COMMAND_ADAPTER.validate_python(
        {"type": "revise", "context": f"  {context}  "}
    )

    assert isinstance(command, ReviseCommand)
    assert command.context == context


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"type": "unknown"},
        {"type": "continue", "extra": "rejected"},
        {"type": "submit", "context": "not allowed"},
        {"type": "ready"},
        {"type": "approve_origin"},
        {"type": "approve_origin", "origin": "https://ats.example/path"},
        {"type": "revise"},
        {"type": "revise", "context": ""},
        {"type": "revise", "context": "   "},
        {"type": "revise", "context": "x" * 20_001},
    ],
)
def test_command_union_rejects_unknown_empty_oversize_and_extra_values(
    payload: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        COMMAND_ADAPTER.validate_python(payload)


async def test_health_is_unauthenticated_and_returns_only_status(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, _service = api_client
    response = await client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["cache-control"] == "no-store"

async def test_application_lifespan_shuts_down_session_service() -> None:
    service = FakeSessionService()
    app = create_app(
        HarnessConfig(bearer_token=TOKEN),
        HarnessDependencies(sessions=service),
    )
    async with app.router.lifespan_context(app):
        assert service.shutdown_calls == 0
    assert service.shutdown_calls == 1


async def test_missing_and_wrong_bearer_are_identical_and_cors_is_absent(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    missing = await client.get(f"/v1/sessions/{SESSION_ID}")
    wrong = await client.get(
        f"/v1/sessions/{SESSION_ID}",
        headers={
            "Authorization": "Bearer wrong-secret-that-is-long-enough",
            "Origin": "https://web.example",
        },
    )
    non_ascii = await client.get(
        f"/v1/sessions/{SESSION_ID}",
        headers=[(b"Authorization", b"Bearer \xff")],
    )

    assert missing.status_code == wrong.status_code == non_ascii.status_code == 401
    assert missing.json() == wrong.json() == non_ascii.json() == {
        "code": "unauthorized",
        "message": "Unauthorized",
    }
    for response in (missing, wrong, non_ascii):
        assert response.headers["cache-control"] == "no-store"
        assert not any(name.startswith("access-control-") for name in response.headers)
    assert service.snapshot_calls == []


async def test_authenticated_response_has_no_cors_headers(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, _service = api_client
    response = await client.get(
        f"/v1/sessions/{SESSION_ID}",
        headers={**AUTHORIZATION, "Origin": "https://web.example"},
    )

    assert response.status_code == 200
    assert not any(name.startswith("access-control-") for name in response.headers)


async def test_multipart_preserves_repeated_domains_files_and_bodies(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    response = await client.post(
        "/v1/sessions",
        headers=AUTHORIZATION,
        files=multipart_parts(
            session_id=SESSION_ID,
            auto_submit=True,
            domains=("https://jobs.example", "https://ats.example"),
            contexts=2,
            anecdotes=2,
            max_steps=321,
        ),
    )

    assert response.status_code == 202
    assert response.json() == {
        "session_id": str(SESSION_ID),
        "state": "starting",
        "events_url": f"http://127.0.0.1:8765/v1/sessions/{SESSION_ID}/events",
        "commands_url": f"http://127.0.0.1:8765/v1/sessions/{SESSION_ID}/commands",
    }
    assert len(service.create_calls) == 1
    call = service.create_calls[0]
    assert call["session_id"] == SESSION_ID
    assert call["job_url"] == "https://jobs.example/openings/42?source=board"
    assert call["allow_domains"] == ["https://jobs.example", "https://ats.example"]
    assert call["auto_submit"] is True
    assert call["max_steps"] == 321
    assert call["personal_information"] == (
        "profile.md",
        b"---\nfull_name: Test Person\n---\nProfile",
    )
    assert call["resume"] == ("resume.pdf", b"%PDF-1.7 synthetic")
    assert call["context"] == [
        ("context-0.md", b"context 0"),
        ("context-1.md", b"context 1"),
    ]
    assert call["anecdotes"] == [
        ("anecdote-0.txt", b"anecdote 0"),
        ("anecdote-1.txt", b"anecdote 1"),
    ]


async def test_multipart_omits_optional_caller_session_id(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client

    response = await client.post(
        "/v1/sessions",
        headers=AUTHORIZATION,
        files=multipart_parts(),
    )

    assert response.status_code == 202
    assert service.create_calls[0]["session_id"] is None
    assert service.create_calls[0]["auto_submit"] is False


async def test_multipart_rejects_invalid_caller_session_id_before_dispatch(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client

    response = await client.post(
        "/v1/sessions",
        headers=AUTHORIZATION,
        files=multipart_parts(session_id="not-a-uuid"),
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert service.create_calls == []


async def test_multipart_rejects_non_boolean_auto_submit_before_dispatch(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client

    response = await client.post(
        "/v1/sessions",
        headers=AUTHORIZATION,
        files=multipart_parts(auto_submit="yes"),
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert service.create_calls == []


@pytest.mark.parametrize(
    ("parts", "expected_status"),
    [
        (multipart_parts(max_steps=1), 202),
        (multipart_parts(max_steps=500), 202),
        (multipart_parts(max_steps=0), 422),
        (multipart_parts(max_steps=501), 422),
        (multipart_parts(domains=[f"https://d{index}.example" for index in range(21)]), 422),
        (multipart_parts(contexts=11), 422),
        (multipart_parts(anecdotes=21), 422),
    ],
)
async def test_multipart_count_and_max_steps_validation(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    parts: list[tuple[str, tuple[None, str] | tuple[str, bytes, str]]],
    expected_status: int,
) -> None:
    client, service = api_client
    response = await client.post(
        "/v1/sessions", headers=AUTHORIZATION, files=parts
    )

    assert response.status_code == expected_status
    if expected_status == 422:
        assert response.json() == {
            "code": "invalid_request",
            "message": "Request is invalid",
        }
        assert service.create_calls == []
    else:
        assert len(service.create_calls) == 1


async def test_singleton_conflict_passes_through_fixed_service_error(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    service.create_error = HarnessServiceError(
        409,
        "session_active",
        "A session is already active",
        session_id=SESSION_ID,
    )
    response = await client.post(
        "/v1/sessions", headers=AUTHORIZATION, files=multipart_parts()
    )

    assert response.status_code == 409
    assert response.json() == {
        "code": "session_active",
        "session_id": str(SESSION_ID),
    }
    assert response.headers["cache-control"] == "no-store"


async def test_snapshot_get_returns_sanitized_public_model(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    response = await client.get(
        f"/v1/sessions/{SESSION_ID}", headers=AUTHORIZATION
    )

    assert response.status_code == 200
    assert response.json() == service.snapshot.model_dump(mode="json")
    assert response.json()["job_url"] == "https://jobs.example/apply"
    assert response.json()["model_provider"] == "openai-codex"
    assert response.json()["model"] == "gpt-5.6-sol"
    assert response.json()["reasoning"] == "high"
    assert response.json()["browser_use_diagnostics"] == [
        {
            "step": 1,
            "status": "failed",
            "exit_code": 7,
            "timed_out": False,
            "error_category": "process_exit",
            "stderr_excerpt": "[redacted]",
            "stderr_truncated": True,
        }
    ]
    assert service.snapshot_calls == [SESSION_ID]


@pytest.mark.parametrize("last_event_id", [0, 2])
async def test_sse_passes_last_event_id_and_sets_streaming_headers(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    last_event_id: int,
) -> None:
    client, service = api_client
    response = await client.get(
        f"/v1/sessions/{SESSION_ID}/events",
        headers={**AUTHORIZATION, "Last-Event-ID": str(last_event_id)},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["connection"] == "keep-alive"
    assert response.headers["x-accel-buffering"] == "no"
    assert response.text == (
        'id: 3\nevent: agent_step\ndata: {"step_number":2}\n\n'
        ": heartbeat\n\n"
    )
    assert service.snapshot_calls == [SESSION_ID]
    assert service.event_calls == [(SESSION_ID, last_event_id)]


@pytest.mark.parametrize("last_event_id", ["-1", "not-an-integer", "1.5"])
async def test_sse_rejects_invalid_or_negative_last_event_id(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    last_event_id: str,
) -> None:
    client, service = api_client
    response = await client.get(
        f"/v1/sessions/{SESSION_ID}/events",
        headers={**AUTHORIZATION, "Last-Event-ID": last_event_id},
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Last-Event-ID must be nonnegative",
    }
    assert service.snapshot_calls == []
    assert service.event_calls == []


@pytest.mark.parametrize(
    ("payload", "command_type"),
    [
        ({"type": "continue"}, ContinueCommand),
        ({"type": "approve_origin", "origin": "https://ats.example"}, ApproveOriginCommand),
        ({"type": "revise", "context": "  use corrected fact  "}, ReviseCommand),
        ({"type": "submit"}, SubmitCommand),
        ({"type": "cancel"}, CancelCommand),
    ],
)
async def test_command_endpoint_dispatches_typed_commands_and_returns_202(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    payload: dict[str, Any],
    command_type: type[SessionCommand],
) -> None:
    client, service = api_client
    response = await client.post(
        f"/v1/sessions/{SESSION_ID}/commands",
        headers=AUTHORIZATION,
        json=payload,
    )

    assert response.status_code == 202
    assert response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert len(service.command_calls) == 1
    dispatched_id, dispatched = service.command_calls[0]
    assert dispatched_id == SESSION_ID
    assert isinstance(dispatched, command_type)
    if isinstance(dispatched, ReviseCommand):
        assert dispatched.context == "use corrected fact"


async def test_command_endpoint_rejects_bad_discriminator_without_dispatch(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    response = await client.post(
        f"/v1/sessions/{SESSION_ID}/commands",
        headers=AUTHORIZATION,
        json={"type": "submit", "secret": "must not appear"},
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert "secret" not in response.text
    assert service.command_calls == []


def _application_result_payload(
    status: str = "ready_for_submission",
) -> dict[str, Any]:
    return {
        "status": status,
        "company": "Example Corp",
        "role": "Engineer",
        "job_url": "https://jobs.example/openings/42",
        "final_url": "https://ats.example/application/42",
        "fields_filled": [],
        "fields_needing_human": [],
        "files_attached": ["resume.pdf"],
        "warnings": [],
        "revision_count": 1,
        "submit_attempted": False,
        **({"submission_confirmation": None} if status == "cancelled" else {}),
    }


@pytest.mark.parametrize(
    ("payload", "action_type"),
    [
        (
            {"type": "browser_use", "code": "print(page_info())"},
            BrowserUseRuntimeAction,
        ),
        (
            {
                "type": "request_human_navigation",
                "instruction": "Complete the hardware-key prompt.",
            },
            RequestHumanNavigationRuntimeAction,
        ),
        (
            {
                "type": "request_origin_approval",
                "origin": "https://ats.example",
            },
            RequestOriginApprovalRuntimeAction,
        ),
        (
            {
                "type": "request_human_review",
                "result": _application_result_payload(),
            },
            RequestHumanReviewRuntimeAction,
        ),
        (
            {"type": "report_application_mismatch"},
            ReportApplicationMismatchRuntimeAction,
        ),
        (
            {
                "type": "request_additional_info",
                "questions": [
                    {
                        "id": "summer_availability",
                        "key": "availability.summer_2027",
                        "scope": "global",
                        "question": "What dates are you available?",
                        "answer_type": "text",
                    },
                    {
                        "id": "referral_source",
                        "key": "referral.source",
                        "scope": "application",
                        "question": "How did you hear about this position?",
                        "answer_type": "single_select",
                        "options": [
                            {"id": "friend", "label": "A friend"},
                            {"id": "board", "label": "Job board"},
                        ],
                    },
                ],
            },
            RequestAdditionalInfoRuntimeAction,
        ),
    ],
)
async def test_runtime_action_endpoint_dispatches_strict_typed_actions(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    payload: dict[str, Any],
    action_type: type[RuntimeActionRequest],
) -> None:
    client, service = api_client

    response = await client.post(
        f"/v1/sessions/{SESSION_ID}/runtime/actions",
        headers=AUTHORIZATION,
        json=payload,
    )

    assert response.status_code == 200
    assert response.json() == {"type": "continue"}
    assert response.headers["cache-control"] == "no-store"
    assert len(service.runtime_action_calls) == 1
    dispatched_id, dispatched = service.runtime_action_calls[0]
    assert dispatched_id == SESSION_ID
    assert isinstance(dispatched, action_type)


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "unknown"},
        {"type": "browser_use", "code": "print('ok')", "token": "secret"},
        {"type": "request_human_navigation", "instruction": " "},
        {"type": "request_origin_approval", "origin": "https://ats.example/path"},
        {"type": "request_human_review", "result": {"status": "cancelled"}},
        {
            "type": "request_additional_info",
            "questions": [
                {
                    "id": "duplicate",
                    "key": "first.key",
                    "scope": "global",
                    "question": "First?",
                    "answer_type": "boolean",
                },
                {
                    "id": "duplicate",
                    "key": "second.key",
                    "scope": "application",
                    "question": "Second?",
                    "answer_type": "boolean",
                },
            ],
        },
    ],
)
async def test_runtime_action_endpoint_rejects_invalid_union_without_dispatch(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    payload: dict[str, Any],
) -> None:
    client, service = api_client

    response = await client.post(
        f"/v1/sessions/{SESSION_ID}/runtime/actions",
        headers=AUTHORIZATION,
        json=payload,
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert service.runtime_action_calls == []


@pytest.mark.parametrize(
    ("adapter", "payload"),
    [
        (
            RUNTIME_ACTION_ADAPTER,
            {"type": "submit_application", "selector": "button[type='submit']"},
        ),
        (
            RUNTIME_ACTION_RESPONSE_ADAPTER,
            {
                "type": "submit_application_result",
                "pre_click_dom": "button Final submit",
                "exit_code": 0,
                "timed_out": False,
                "stdout": "",
                "stderr": "",
                "stdout_truncated": False,
                "stderr_truncated": False,
                "observation": {
                    "url": "https://ats.example/confirmation",
                    "title": "Application received",
                    "tabs": [],
                    "dom": "Application received",
                    "page_info": None,
                    "screenshot": None,
                },
            },
        ),
    ],
)
def test_runtime_unions_reject_removed_selector_submission_contract(
    adapter: TypeAdapter[Any],
    payload: dict[str, Any],
) -> None:
    with pytest.raises(ValidationError):
        adapter.validate_python(payload)


def test_submit_runtime_action_response_requires_exact_permission() -> None:
    payload = {
        "type": "submit",
        "instruction": "You're good to submit.",
        "result": _application_result_payload(),
    }
    response = RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(payload)
    assert isinstance(response, SubmitRuntimeActionResponse)
    assert response.instruction == "You're good to submit."

    for invalid_instruction in (None, "You may submit.", "You're good to submit. "):
        invalid = dict(payload)
        if invalid_instruction is None:
            invalid.pop("instruction")
        else:
            invalid["instruction"] = invalid_instruction
        with pytest.raises(ValidationError):
            RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(invalid)


def test_rejects_removed_candidate_question_preflight_contract() -> None:
    question = {
        "id": "candidate_deadbeef",
        "key": "form.candidate_deadbeef",
        "scope": "application",
        "question": "Review emphasis",
        "answer_type": "text",
    }
    with pytest.raises(ValidationError):
        BrowserUseExecutionResult.model_validate(
            {
                "exit_code": 0,
                "timed_out": False,
                "stdout": "",
                "stderr": "",
                "stdout_truncated": False,
                "stderr_truncated": False,
                "observation": {
                    "url": "https://ats.example/application",
                    "title": "Application",
                    "tabs": [],
                    "dom": "textarea Review emphasis",
                    "page_info": None,
                    "screenshot": None,
                },
                "candidate_questions": [question],
            }
        )
    with pytest.raises(ValidationError):
        RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(
            {
                "type": "candidate_questions_required",
                "questions": [question],
            }
        )


@pytest.mark.parametrize(
    "payload",
    [
        {
            "type": "browser_use_result",
            "exit_code": 0,
            "timed_out": False,
            "stdout": "ok",
            "stderr": "",
            "stdout_truncated": False,
            "stderr_truncated": False,
            "observation": {
                "url": "https://jobs.example/openings/42",
                "title": "Application",
                "tabs": [
                    {
                        "url": "https://jobs.example/openings/42",
                        "title": "Application",
                        "tab_id": "target-1",
                        "parent_tab_id": None,
                    }
                ],
                "dom": "Application form",
                "page_info": {"url": "https://jobs.example/openings/42"},
                "screenshot": {
                    "media_type": "image/png",
                    "data": "cG5n",
                },
            },
        },
        {"type": "continue"},
        {
            "type": "approve",
            "origin": "https://ats.example",
            "approved_origins": [
                "https://jobs.example",
                "https://ats.example",
            ],
        },
        {"type": "revise", "context": "Use the corrected date.", "revision_count": 1},
        {
            "type": "submit",
            "instruction": "You're good to submit.",
            "result": _application_result_payload(),
        },
        {"type": "cancel", "result": _application_result_payload("cancelled")},
        {"type": "application_mismatch"},
        {
            "type": "additional_info",
            "answers": [
                {
                    "id": "summer_availability",
                    "key": "availability.summer_2027",
                    "scope": "global",
                    "answer_type": "text",
                    "status": "answered",
                    "value": "June through August 2027",
                },
                {
                    "id": "referral_source",
                    "key": "referral.source",
                    "scope": "application",
                    "answer_type": "single_select",
                    "status": "declined",
                },
            ],
        },
    ],
)
def test_runtime_action_response_union_is_strict_and_round_trips(
    payload: dict[str, Any],
) -> None:
    parsed = RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(payload)

    assert parsed.model_dump(mode="json") == payload


def test_runtime_action_unions_reject_unknown_properties() -> None:
    with pytest.raises(ValidationError):
        RUNTIME_ACTION_ADAPTER.validate_python(
            {"type": "report_application_mismatch", "unexpected": True}
        )
    with pytest.raises(ValidationError):
        RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(
            {"type": "continue", "unexpected": True}
        )


async def test_delete_is_204_and_idempotent_for_known_fake_session(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    first = await client.delete(
        f"/v1/sessions/{SESSION_ID}", headers=AUTHORIZATION
    )
    second = await client.delete(
        f"/v1/sessions/{SESSION_ID}", headers=AUTHORIZATION
    )

    assert first.status_code == second.status_code == 204
    assert first.content == second.content == b""
    assert service.delete_calls == [SESSION_ID, SESSION_ID]


async def test_unknown_session_exposes_only_fixed_service_error(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, _service = api_client
    unknown_id = UUID("e276cd41-1c40-4800-a5dc-28311f80fe6e")
    response = await client.get(
        f"/v1/sessions/{unknown_id}", headers=AUTHORIZATION
    )

    assert response.status_code == 404
    assert response.json() == {
        "code": "session_not_found",
        "message": "Session not found",
    }
    assert response.headers["cache-control"] == "no-store"


async def test_unexpected_secret_bearing_exception_is_sanitized(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    secret = "oauth-refresh-token-and-private-answer"
    service.snapshot_error = RuntimeError(f"provider failed with {secret}")
    response = await client.get(
        f"/v1/sessions/{SESSION_ID}", headers=AUTHORIZATION
    )

    assert response.status_code == 500
    assert response.json() == {
        "code": "internal_error",
        "message": "Request failed",
    }
    assert secret not in response.text
    assert TOKEN not in response.text
    assert response.headers["cache-control"] == "no-store"
