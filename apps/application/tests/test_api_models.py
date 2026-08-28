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
    APPLICATION_ANECDOTE_MAX_COUNT,
    APPLICATION_CONTEXT_MAX_COUNT,
    SESSION_ERROR_MESSAGES,
    AdditionalInfoRuntimeActionResponse,
    ApplicationAnswerSuggestion,
    ApplicationAnswerSuggestionsResponse,
    ApplicationRunResult,
    ReviewApplicationResult,
    PlaywrightCliDiagnostic,
    PlaywrightCliExecutionResult,
    PlaywrightCliResultRuntimeActionResponse,
    PlaywrightCliRuntimeAction,
    CancelledApplicationResult,
    CancelRuntimeActionResponse,
    ContinueRuntimeActionResponse,
    EmailVerificationRuntimeActionResponse,
    ContinueWithoutAdditionalInfoRuntimeActionResponse,
    ProvideAdditionalInfoCommand,
    ApproveOriginCommand,
    BrowserLaunchConfig,
    CancelCommand,
    ContinueCommand,
    ContinueWithoutAdditionalInfoCommand,
    SaveCredentialsCommand,
    SignInCommand,
    FieldResult,
    HarnessConfig,
    OpportunityKind,
    HarnessServiceError,
    RequestAdditionalInfoRuntimeAction,
    RequestEmailVerificationRuntimeAction,
    RequestHumanNavigationRuntimeAction,
    RequestSignInRuntimeAction,
    RequestHumanReviewRuntimeAction,
    ReportApplicationMismatchRuntimeAction,
    PostSubmitConfirmation,
    ReviseRuntimeActionResponse,
    RuntimeActionRequest,
    RuntimeActionResponse,
    SubmitRuntimeActionResponse,
    SignInRuntimeActionResponse,
    SubmitCommand,
    ReviseCommand,
    SteerCommand,
    SessionCommand,
    SubmittedApplicationResult,
    SubmissionUncertainApplicationResult,
    SessionCreateResponse,
    SessionError,
    SessionSnapshot,
    SourceCaptureCreateResponse,
    SourceCaptureCreateRequest,
    SourceCaptureResult,
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
        "playwright_cli_diagnostics": [
            {
                "step": 1,
                "status": "failed",
                "exit_code": 7,
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
    suggestions_error: HarnessServiceError | None = None
    create_calls: list[dict[str, Any]] = field(default_factory=list)
    source_capture_calls: list[dict[str, Any]] = field(default_factory=list)
    source_capture_complete_calls: list[UUID] = field(default_factory=list)
    source_capture_delete_calls: list[UUID] = field(default_factory=list)
    snapshot_calls: list[UUID] = field(default_factory=list)
    event_calls: list[tuple[UUID, int | None]] = field(default_factory=list)
    suggestion_calls: list[tuple[UUID, str]] = field(default_factory=list)
    command_calls: list[tuple[UUID, SessionCommand]] = field(default_factory=list)
    runtime_action_calls: list[tuple[UUID, RuntimeActionRequest]] = field(
        default_factory=list
    )
    runtime_model_action_calls: list[tuple[UUID, RuntimeActionRequest]] = field(
        default_factory=list
    )
    runtime_action_response: RuntimeActionResponse = field(
        default_factory=lambda: ContinueRuntimeActionResponse(type="continue")
    )
    suggestions_response: ApplicationAnswerSuggestionsResponse = field(
        default_factory=lambda: ApplicationAnswerSuggestionsResponse(
            suggestions=[
                ApplicationAnswerSuggestion(
                    question="What did a previous application ask?",
                    answer="A safe previous answer.",
                )
            ]
        )
    )
    delete_calls: list[UUID] = field(default_factory=list)
    startup_calls: int = 0
    shutdown_calls: int = 0

    async def startup(self) -> None:
        self.startup_calls += 1

    async def create_session(
        self,
        *,
        session_id: UUID | None,
        job_url: str,
        opportunity_kind: OpportunityKind,
        allow_domains: Sequence[str],
        auto_submit: bool,
        personal_information: UploadFile,
        resume: UploadFile,
        resume_source: UploadFile,
        context: Sequence[UploadFile],
        anecdotes: Sequence[UploadFile],
    ) -> SessionCreateResponse:
        if self.create_error is not None:
            raise self.create_error
        self.create_calls.append(
            {
                "session_id": session_id,
                "job_url": job_url,
                "opportunity_kind": opportunity_kind,
                "allow_domains": list(allow_domains),
                "auto_submit": auto_submit,
                "personal_information": (
                    personal_information.filename,
                    await personal_information.read(),
                ),
                "resume": (resume.filename, await resume.read()),
                "resume_source": (
                    resume_source.filename,
                    await resume_source.read(),
                ),
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

    async def create_source_capture(
        self,
        *,
        capture_id: UUID,
        job_url: str,
        approved_origins: Sequence[str],
    ) -> SourceCaptureCreateResponse:
        self.source_capture_calls.append(
            {
                "capture_id": capture_id,
                "job_url": job_url,
                "approved_origins": list(approved_origins),
            }
        )
        return SourceCaptureCreateResponse(
            capture_id=capture_id,
            state="awaiting_human_verification",
        )

    async def complete_source_capture(
        self,
        capture_id: UUID,
    ) -> SourceCaptureResult:
        self.source_capture_complete_calls.append(capture_id)
        return SourceCaptureResult(
            capture_id=capture_id,
            final_url="https://jobs.tal.net/application/verified",
            source="Verified role\nEmployer details",
        )

    async def delete_source_capture(self, capture_id: UUID) -> None:
        self.source_capture_delete_calls.append(capture_id)

    def get_snapshot(self, session_id: UUID) -> SessionSnapshot:
        self.snapshot_calls.append(session_id)
        if self.snapshot_error is not None:
            raise self.snapshot_error
        if session_id != SESSION_ID:
            raise HarnessServiceError(404, "session_not_found", "Session not found")
        return self.snapshot

    async def get_additional_info_suggestions(
        self,
        session_id: UUID,
        question_id: str,
    ) -> ApplicationAnswerSuggestionsResponse:
        self.suggestion_calls.append((session_id, question_id))
        if self.suggestions_error is not None:
            raise self.suggestions_error
        return self.suggestions_response

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

    async def runtime_model_action(
        self,
        session_id: UUID,
        action: RuntimeActionRequest,
    ) -> RuntimeActionResponse:
        if session_id != SESSION_ID:
            raise HarnessServiceError(404, "session_not_found", "Session not found")
        self.runtime_model_action_calls.append((session_id, action))
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
    session_id: UUID | str | None = None,
    opportunity_kind: str | None = "job",
    auto_submit: bool | str | None = None,
) -> list[tuple[str, tuple[None, str] | tuple[str, bytes, str]]]:
    parts: list[tuple[str, tuple[None, str] | tuple[str, bytes, str]]] = [
        ("job_url", (None, "https://jobs.example/openings/42?source=board")),
        (
            "personal_information",
            ("profile.md", b"---\nfull_name: Test Person\n---\nProfile", "text/markdown"),
        ),
        ("resume", ("resume.pdf", b"%PDF-1.7 synthetic", "application/pdf")),
        (
            "resume_source",
            ("resume.tex", b"\\documentclass{article}\nResume", "text/x-tex"),
        ),
    ]
    if opportunity_kind is not None:
        parts.insert(0, ("opportunity_kind", (None, opportunity_kind)))
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
    assert config.gmail_token_json == Path(
        "~/.jobhunter/browser-harness/gmail-token.json"
    )
    assert config.gmail_verification_timeout == 180

    for token in ("", "x" * 31):
        with pytest.raises(ValidationError):
            HarnessConfig(bearer_token=token)
    for timeout in (0, 901):
        with pytest.raises(ValidationError):
            HarnessConfig(
                bearer_token=TOKEN,
                gmail_verification_timeout=timeout,
            )

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


def test_origins_canonicalize_expanded_ipv6_like_whatwg_urls() -> None:
    expanded = "0:0:0:0:0:0:0:1"
    capture = SourceCaptureCreateRequest(
        capture_id=UUID("5cd2d80d-d615-4a56-a53e-01d174d6b88d"),
        job_url=f"https://[{expanded}]/jobs/1?verified=true",
        approved_origins=[f"https://[{expanded}]:443/"],
    )

    assert validate_https_origin(
        f"https://[{expanded}]:443/"
    ) == "https://[::1]"
    assert validate_approved_origin(
        f"http://[{expanded}]:8080/"
    ) == "http://[::1]:8080"
    assert capture.approved_origins == ["https://[::1]"]


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
        ("awaiting_human_navigation", {"type": "credentials"}),
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


def test_session_snapshot_accepts_unlimited_or_nonnegative_finite_expiry() -> None:
    assert make_snapshot().expires_at == NOW + timedelta(hours=1)
    assert make_snapshot(expires_at=None).expires_at is None

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
        (
            {"type": "continue_without_additional_info"},
            ContinueWithoutAdditionalInfoCommand,
        ),
        ({"type": "approve_origin", "origin": "HTTPS://ATS.Example/"}, ApproveOriginCommand),
        ({"type": "revise", "context": "  Correct this field.  "}, ReviseCommand),
        ({"type": "steer", "message": "  Use the updated operator guidance.  "}, SteerCommand),
        ({"type": "submit"}, SubmitCommand),
        ({"type": "cancel"}, CancelCommand),
        (
            {
                "type": "sign_in",
                "username": "  ada@example.test  ",
                "password": " password with spaces ",
            },
            SignInCommand,
        ),
        (
            {
                "type": "save_credentials",
                "username": "ada@example.test",
                "password": "new-account-password",
            },
            SaveCredentialsCommand,
        ),
        (
            {
                "type": "provide_additional_info",
                "answers": [
                    {
                        "id": "summer_availability",
                        "status": "answered",
                        "raw_value": "Available for the summer",
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
    if isinstance(command, SteerCommand):
        assert command.message == "Use the updated operator guidance."
    if isinstance(command, (SignInCommand, SaveCredentialsCommand)):
        assert command.credentials()[0] == "ada@example.test"
        if isinstance(command, SignInCommand):
            assert command.credentials()[1] == " password with spaces "
        projected = command.model_dump(mode="json")
        assert projected["username"] == "**********"
        assert projected["password"] == "**********"
        assert "ada@example.test" not in repr(command)


def test_additional_info_continue_is_distinct_from_navigation_and_strict() -> None:
    navigation = COMMAND_ADAPTER.validate_python({"type": "continue"})
    additional_info = COMMAND_ADAPTER.validate_python(
        {"type": "continue_without_additional_info"}
    )
    response = RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(
        {"type": "continue_without_additional_info"}
    )

    assert isinstance(navigation, ContinueCommand)
    assert isinstance(additional_info, ContinueWithoutAdditionalInfoCommand)
    assert isinstance(
        response,
        ContinueWithoutAdditionalInfoRuntimeActionResponse,
    )
    assert additional_info.model_dump(mode="json") == {
        "type": "continue_without_additional_info"
    }
    assert response.model_dump(mode="json") == {
        "type": "continue_without_additional_info"
    }
    for adapter in (COMMAND_ADAPTER, RUNTIME_ACTION_RESPONSE_ADAPTER):
        with pytest.raises(ValidationError):
            adapter.validate_python(
                {
                    "type": "continue_without_additional_info",
                    "answers": [],
                }
            )


def test_text_additional_info_command_requires_distinct_trimmed_raw_and_final_values() -> None:
    command = COMMAND_ADAPTER.validate_python(
        {
            "type": "provide_additional_info",
            "answers": [
                {
                    "id": "summer_availability",
                    "status": "answered",
                    "raw_value": "  loose thoughts  ",
                    "value": "  A concise professional answer.  ",
                }
            ],
        }
    )

    assert isinstance(command, ProvideAdditionalInfoCommand)
    answer = command.answers[0]
    assert answer.model_dump() == {
        "id": "summer_availability",
        "status": "answered",
        "raw_value": "loose thoughts",
        "value": "A concise professional answer.",
    }


@pytest.mark.parametrize(
    "answer",
    [
        {"id": "answer", "status": "answered", "value": "final only"},
        {
            "id": "answer",
            "status": "answered",
            "raw_value": "raw only",
        },
        {
            "id": "answer",
            "status": "answered",
            "raw_value": "raw",
            "value": "final",
            "extra": True,
        },
        {
            "id": "answer",
            "status": "answered",
            "raw_value": "x" * 2_001,
            "value": "final",
        },
        {
            "id": "answer",
            "status": "answered",
            "raw_value": "raw",
            "value": "x" * 2_001,
        },
    ],
)
def test_text_additional_info_command_rejects_missing_extra_and_oversize_values(
    answer: dict[str, object],
) -> None:
    with pytest.raises(ValidationError):
        COMMAND_ADAPTER.validate_python(
            {"type": "provide_additional_info", "answers": [answer]}
        )


@pytest.mark.parametrize(
    "payload",
    [
        {
            "type": "sign_in",
            "username": "ada\x00@example.test",
            "password": "password",
        },
        {
            "type": "save_credentials",
            "username": "ada@example.test",
            "password": "pass\x00word",
        },
    ],
)
def test_credential_commands_reject_nul(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        COMMAND_ADAPTER.validate_python(payload)

def test_revision_command_accepts_twenty_thousand_trimmed_characters() -> None:
    context = "x" * 20_000
    command = COMMAND_ADAPTER.validate_python(
        {"type": "revise", "context": f"  {context}  "}
    )

    assert isinstance(command, ReviseCommand)
    assert command.context == context


def test_steer_command_accepts_eight_thousand_unicode_scalars_after_edge_trim() -> None:
    message = "\U0001f680" * 8_000
    command = COMMAND_ADAPTER.validate_python(
        {"type": "steer", "message": f" \n{message}\t "}
    )

    assert isinstance(command, SteerCommand)
    assert command.message == message
    assert message not in repr(command)


@pytest.mark.parametrize(
    "message",
    [
        "",
        " \n\t ",
        "contains\x00nul",
        "\ud800",
        "\udfff",
        "x" * 8_001,
        "\U0001f680" * 8_001,
    ],
)
def test_steer_command_rejects_empty_nul_non_scalar_and_oversize_text(
    message: str,
) -> None:
    with pytest.raises(ValidationError):
        COMMAND_ADAPTER.validate_python({"type": "steer", "message": message})


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"type": "unknown"},
        {"type": "continue", "extra": "rejected"},
        {
            "type": "continue_without_additional_info",
            "extra": "rejected",
        },
        {"type": "submit", "context": "not allowed"},
        {"type": "ready"},
        {"type": "approve_origin"},
        {"type": "approve_origin", "origin": "https://ats.example/path"},
        {"type": "revise"},
        {"type": "revise", "context": ""},
        {"type": "revise", "context": "   "},
        {"type": "revise", "context": "x" * 20_001},
        {"type": "steer"},
        {"type": "steer", "message": "valid", "extra": True},
        {"type": "sign_in", "username": "", "password": "password"},
        {"type": "sign_in", "username": "\ud800", "password": "password"},
        {"type": "sign_in", "username": "user@example.test", "password": "\ud800"},
        {"type": "sign_in", "username": "user@example.test", "password": ""},
        {"type": "sign_in", "username": "x" * 321, "password": "password"},
        {"type": "sign_in", "username": "user@example.test", "password": "x" * 4_097},
        {
            "type": "save_credentials",
            "username": "user@example.test",
            "password": "password",
            "extra": True,
        },
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
        assert service.startup_calls == 1
        assert service.shutdown_calls == 0
    assert service.shutdown_calls == 1
    assert service.startup_calls == 1


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


async def test_authenticated_source_capture_creation_dispatches_validated_request_once(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    response = await client.post(
        "/v1/source-captures",
        headers=AUTHORIZATION,
        json={
            "capture_id": "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
            "job_url": (
                "https://jobs.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/"
                "brand-4/candidate/so/pm/1/pl/3/opp/1234-Engineer/en-GB"
            ),
            "approved_origins": ["https://jobs.tal.net"],
        },
    )

    assert response.status_code == 202
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "capture_id": "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
        "state": "awaiting_human_verification",
    }
    assert service.source_capture_calls == [
        {
            "capture_id": UUID("f4d9a10e-e63a-4ff5-9bf7-c2d054418979"),
            "job_url": (
                "https://jobs.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/"
                "brand-4/candidate/so/pm/1/pl/3/opp/1234-Engineer/en-GB"
            ),
            "approved_origins": ["https://jobs.tal.net"],
        }
    ]


async def test_source_capture_completion_is_bodyless_and_returns_only_private_source_result(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    capture_id = UUID("f4d9a10e-e63a-4ff5-9bf7-c2d054418979")

    response = await client.post(
        f"/v1/source-captures/{capture_id}/complete",
        headers=AUTHORIZATION,
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "capture_id": str(capture_id),
        "final_url": "https://jobs.tal.net/application/verified",
        "source": "Verified role\nEmployer details",
    }
    assert service.source_capture_complete_calls == [capture_id]
    assert set(response.json()) == {"capture_id", "final_url", "source"}


async def test_source_capture_cancel_is_bodyless_and_returns_no_content(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    capture_id = UUID("f4d9a10e-e63a-4ff5-9bf7-c2d054418979")

    response = await client.delete(
        f"/v1/source-captures/{capture_id}",
        headers=AUTHORIZATION,
    )

    assert response.status_code == 204
    assert response.content == b""
    assert response.headers["cache-control"] == "no-store"
    assert service.source_capture_delete_calls == [capture_id]


@pytest.mark.parametrize("method,suffix", [("POST", "/complete"), ("DELETE", "")])
@pytest.mark.parametrize(
    "target_suffix,content",
    [("?unexpected=true", None), ("", b"{}")],
)
async def test_source_capture_terminal_routes_reject_queries_and_bodies(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    method: str,
    suffix: str,
    target_suffix: str,
    content: bytes | None,
) -> None:
    client, service = api_client
    capture_id = UUID("f4d9a10e-e63a-4ff5-9bf7-c2d054418979")

    response = await client.request(
        method,
        f"/v1/source-captures/{capture_id}{suffix}{target_suffix}",
        headers=AUTHORIZATION,
        content=content,
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert service.source_capture_complete_calls == []
    assert service.source_capture_delete_calls == []

@pytest.mark.parametrize("method,suffix", [("POST", "/complete"), ("DELETE", "")])
async def test_source_capture_terminal_routes_reject_declared_oversized_bodies_without_reading(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    method: str,
    suffix: str,
) -> None:
    client, service = api_client
    capture_id = UUID("f4d9a10e-e63a-4ff5-9bf7-c2d054418979")

    async def unread_body() -> AsyncIterator[bytes]:
        raise AssertionError("declared nonempty body must not be consumed")
        yield b"unreachable"

    response = await client.request(
        method,
        f"/v1/source-captures/{capture_id}{suffix}",
        headers={**AUTHORIZATION, "content-length": str(64 * 1024 * 1024)},
        content=unread_body(),
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert service.source_capture_complete_calls == []
    assert service.source_capture_delete_calls == []


@pytest.mark.parametrize("method,suffix", [("POST", "/complete"), ("DELETE", "")])
async def test_source_capture_terminal_routes_stop_at_first_chunked_body_byte(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    method: str,
    suffix: str,
) -> None:
    client, service = api_client
    capture_id = UUID("f4d9a10e-e63a-4ff5-9bf7-c2d054418979")

    async def chunked_body() -> AsyncIterator[bytes]:
        yield b"x"
        raise AssertionError("bodyless check must stop after the first byte")

    response = await client.request(
        method,
        f"/v1/source-captures/{capture_id}{suffix}",
        headers=AUTHORIZATION,
        content=chunked_body(),
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert service.source_capture_complete_calls == []
    assert service.source_capture_delete_calls == []


def test_source_capture_urls_accept_4096_characters_and_reject_4097() -> None:
    capture_id = UUID("f4d9a10e-e63a-4ff5-9bf7-c2d054418979")
    origin_prefix = "https://"
    maximum_origin = origin_prefix + "a" * (4096 - len(origin_prefix))
    maximum_job_url = "https://jobs.tal.net/" + "a" * (
        4096 - len("https://jobs.tal.net/")
    )

    assert SourceCaptureCreateRequest(
        capture_id=capture_id,
        job_url=maximum_origin,
        approved_origins=[maximum_origin],
    ).approved_origins == [maximum_origin]
    assert SourceCaptureCreateRequest(
        capture_id=capture_id,
        job_url=maximum_job_url,
        approved_origins=["https://jobs.tal.net"],
    ).job_url == maximum_job_url

    with pytest.raises(ValidationError):
        SourceCaptureCreateRequest(
            capture_id=capture_id,
            job_url=maximum_origin + "a",
            approved_origins=[maximum_origin + "a"],
        )
    with pytest.raises(ValidationError):
        SourceCaptureCreateRequest(
            capture_id=capture_id,
            job_url=maximum_job_url + "a",
            approved_origins=["https://jobs.tal.net"],
        )


@pytest.mark.parametrize(
    "payload",
    [
        {
            "capture_id": "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
            "job_url": "http://jobs.tal.net/application",
            "approved_origins": ["http://jobs.tal.net"],
        },
        {
            "capture_id": "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
            "job_url": "https://jobs.tal.net./application",
            "approved_origins": ["https://jobs.tal.net"],
        },
        {
            "capture_id": "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
            "job_url": "https://jobs.tal.net/application",
            "approved_origins": ["https://login.tal.net"],
        },
        {
            "capture_id": "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
            "job_url": "https://jobs.tal.net/application",
            "approved_origins": ["https://jobs.tal.net"],
            "timeout_seconds": 900,
        },
        {
            "capture_id": "f4d9a10e-e63a-4ff5-9bf7-c2d054418979",
            "job_url": "https://jobs.tal.net/application",
            "approved_origins": ["https://jobs.tal.net"],
            "extra": "rejected",
        },
    ],
)
async def test_source_capture_create_rejects_any_boundary_broader_than_one_exact_https_origin(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    payload: dict[str, Any],
) -> None:
    client, service = api_client

    response = await client.post(
        "/v1/source-captures",
        headers=AUTHORIZATION,
        json=payload,
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert service.source_capture_calls == []


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
    assert call["opportunity_kind"] == "job"
    assert call["job_url"] == "https://jobs.example/openings/42?source=board"
    assert call["allow_domains"] == ["https://jobs.example", "https://ats.example"]
    assert call["auto_submit"] is True
    assert call["personal_information"] == (
        "profile.md",
        b"---\nfull_name: Test Person\n---\nProfile",
    )
    assert call["resume"] == ("resume.pdf", b"%PDF-1.7 synthetic")
    assert call["resume_source"] == (
        "resume.tex",
        b"\\documentclass{article}\nResume",
    )
    assert call["context"] == [
        ("context-0.md", b"context 0"),
        ("context-1.md", b"context 1"),
    ]
    assert call["anecdotes"] == [
        ("anecdote-0.txt", b"anecdote 0"),
        ("anecdote-1.txt", b"anecdote 1"),
    ]


@pytest.mark.parametrize(
    "opportunity_kind",
    ["job", "hackathon", "competition", "event", "networking_event"],
)
async def test_multipart_propagates_every_valid_opportunity_kind(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    opportunity_kind: str,
) -> None:
    client, service = api_client

    response = await client.post(
        "/v1/sessions",
        headers=AUTHORIZATION,
        files=multipart_parts(opportunity_kind=opportunity_kind),
    )

    assert response.status_code == 202
    assert service.create_calls[0]["opportunity_kind"] == opportunity_kind
    assert "opportunity_kind" not in response.json()


@pytest.mark.parametrize(
    "opportunity_kind",
    [None, "", "internship", "Job"],
    ids=["missing", "empty", "unknown", "wrong-case"],
)
async def test_multipart_rejects_missing_or_invalid_opportunity_kind_before_dispatch(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
    opportunity_kind: str | None,
) -> None:
    client, service = api_client

    response = await client.post(
        "/v1/sessions",
        headers=AUTHORIZATION,
        files=multipart_parts(opportunity_kind=opportunity_kind),
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert service.create_calls == []


async def test_multipart_requires_resume_source_before_dispatch(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    response = await client.post(
        "/v1/sessions",
        headers=AUTHORIZATION,
        files=[part for part in multipart_parts() if part[0] != "resume_source"],
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert service.create_calls == []


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
        (multipart_parts(domains=[f"https://d{index}.example" for index in range(21)]), 422),
        (multipart_parts(contexts=APPLICATION_CONTEXT_MAX_COUNT), 202),
        (multipart_parts(contexts=APPLICATION_CONTEXT_MAX_COUNT + 1), 422),
        (multipart_parts(anecdotes=APPLICATION_ANECDOTE_MAX_COUNT), 202),
        (multipart_parts(anecdotes=APPLICATION_ANECDOTE_MAX_COUNT + 1), 422),
    ],
)
async def test_multipart_count_validation(
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
    assert response.json()["playwright_cli_diagnostics"] == [
        {
            "step": 1,
            "status": "failed",
            "exit_code": 7,
            "error_category": "process_exit",
            "stderr_excerpt": "[redacted]",
            "stderr_truncated": True,
        }
    ]
    assert isinstance(
        service.snapshot.playwright_cli_diagnostics[0],
        PlaywrightCliDiagnostic,
    )
    assert service.snapshot_calls == [SESSION_ID]


@pytest.mark.parametrize(
    "removed_field",
    [
        {"timed_out": False},
        {"status": "timed_out"},
        {"error_category": "execution_timeout"},
        {"error_category": "session_timeout"},
    ],
)
def test_playwright_diagnostic_rejects_removed_timeout_contract(
    removed_field: dict[str, object],
) -> None:
    payload: dict[str, object] = {
        "step": 1,
        "status": "succeeded",
        "exit_code": 0,
        "error_category": None,
        "stderr_excerpt": None,
        "stderr_truncated": False,
    }
    payload.update(removed_field)
    with pytest.raises(ValidationError):
        PlaywrightCliDiagnostic.model_validate(payload)


async def test_private_suggestions_get_is_authenticated_strict_and_public_safe(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    path = f"/v1/sessions/{SESSION_ID}/additional-info/pending_answer/suggestions"

    unauthorized = await client.get(path)
    invalid = await client.get(
        f"/v1/sessions/{SESSION_ID}/additional-info/Not-Valid/suggestions",
        headers=AUTHORIZATION,
    )
    extra_query = await client.get(
        f"{path}?storage_key=private.key",
        headers=AUTHORIZATION,
    )
    response = await client.get(path, headers=AUTHORIZATION)

    assert unauthorized.status_code == 401
    assert invalid.status_code == 422
    assert extra_query.status_code == 422
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "suggestions": [
            {
                "question": "What did a previous application ask?",
                "answer": "A safe previous answer.",
            }
        ]
    }
    serialized = response.text
    for private_value in (
        "storage_key",
        "private.key",
        "raw_value",
        "sanitized_value",
        "job_url",
    ):
        assert private_value not in serialized
    assert service.suggestion_calls == [(SESSION_ID, "pending_answer")]


async def test_private_suggestions_get_maps_stale_question_to_bounded_error(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    service.suggestions_error = HarnessServiceError(
        409,
        "command_conflict",
        "No matching text question is pending",
    )

    response = await client.get(
        f"/v1/sessions/{SESSION_ID}/additional-info/stale_answer/suggestions",
        headers=AUTHORIZATION,
    )

    assert response.status_code == 409
    assert response.json() == {
        "code": "command_conflict",
        "message": "No matching text question is pending",
    }


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
        (
            {"type": "continue_without_additional_info"},
            ContinueWithoutAdditionalInfoCommand,
        ),
        ({"type": "approve_origin", "origin": "https://ats.example"}, ApproveOriginCommand),
        ({"type": "revise", "context": "  use corrected fact  "}, ReviseCommand),
        ({"type": "steer", "message": "  use the changed posting details  "}, SteerCommand),
        ({"type": "submit"}, SubmitCommand),
        ({"type": "cancel"}, CancelCommand),
        (
            {
                "type": "sign_in",
                "username": "  ada@example.test  ",
                "password": " transient password ",
            },
            SignInCommand,
        ),
        (
            {
                "type": "save_credentials",
                "username": "ada@example.test",
                "password": "saved password",
            },
            SaveCredentialsCommand,
        ),
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
    if isinstance(dispatched, (SignInCommand, SaveCredentialsCommand)):
        assert dispatched.credentials()[0] == "ada@example.test"
    if isinstance(dispatched, ReviseCommand):
        assert dispatched.context == "use corrected fact"
    if isinstance(dispatched, SteerCommand):
        assert dispatched.message == "use the changed posting details"


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


async def test_invalid_steer_command_returns_fixed_error_without_message(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    private_message = "private operator guidance"

    response = await client.post(
        f"/v1/sessions/{SESSION_ID}/commands",
        headers=AUTHORIZATION,
        json={
            "type": "steer",
            "message": f"{private_message}\x00",
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert private_message not in response.text
    assert service.command_calls == []


async def test_invalid_credential_command_returns_fixed_error_without_values(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    username = "private-user@example.test"
    password = "private-password"

    response = await client.post(
        f"/v1/sessions/{SESSION_ID}/commands",
        headers=AUTHORIZATION,
        json={
            "type": "sign_in",
            "username": username,
            "password": password,
            "extra": True,
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert username not in response.text
    assert password not in response.text
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
    "command",
    [
        "goto",
        "snapshot",
        "eval",
        "click",
        "dblclick",
        "type",
        "press",
        "fill",
        "drag",
        "drop",
        "hover",
        "select",
        "upload",
        "check",
        "uncheck",
        "dialog-accept",
        "dialog-dismiss",
        "resize",
        "go-back",
        "go-forward",
        "reload",
        "keydown",
        "keyup",
        "mousemove",
        "mousedown",
        "mouseup",
        "mousewheel",
        "screenshot",
        "pdf",
        "tab-list",
        "tab-new",
        "tab-close",
        "tab-select",
        "generate-locator",
        "highlight",
        "video-chapter",
        "video-show-actions",
        "video-hide-actions",
    ],
)
def test_playwright_cli_runtime_action_accepts_approved_commands(
    command: str,
) -> None:
    action = RUNTIME_ACTION_ADAPTER.validate_python(
        {"type": "playwright_cli", "command": command}
    )

    assert isinstance(action, PlaywrightCliRuntimeAction)
    assert action.command == command
    assert action.args == []


def test_playwright_cli_runtime_action_enforces_argument_boundaries() -> None:
    sixty_four = PlaywrightCliRuntimeAction.model_validate(
        {
            "type": "playwright_cli",
            "command": "eval",
            "args": [""] * 64,
        }
    )
    exact_utf8_limit = PlaywrightCliRuntimeAction.model_validate(
        {
            "type": "playwright_cli",
            "command": "eval",
            "args": ["é" * 4_096],
        }
    )
    exact_invocation_limit = PlaywrightCliRuntimeAction.model_validate(
        {
            "type": "playwright_cli",
            "command": "eval",
            "args": [*["x" * 8_192] * 7, "x" * 8_188],
        }
    )

    assert len(sixty_four.args) == 64
    assert len(exact_utf8_limit.args[0].encode("utf-8")) == 8_192
    assert (
        len(exact_invocation_limit.command.encode("utf-8"))
        + sum(len(argument.encode("utf-8")) for argument in exact_invocation_limit.args)
        == 65_536
    )

    for invalid_args in (
        [""] * 65,
        ["é" * 4_096 + "a"],
        [*["x" * 8_192] * 7, "x" * 8_189],
    ):
        with pytest.raises(ValidationError):
            PlaywrightCliRuntimeAction.model_validate(
                {
                    "type": "playwright_cli",
                    "command": "eval",
                    "args": invalid_args,
                }
            )


@pytest.mark.parametrize(
    "command",
    [
        "open",
        "attach",
        "detach",
        "close",
        "delete-data",
        "close-all",
        "kill-all",
        "show",
        "install",
        "dashboard",
        "video-start",
        "video-stop",
        "session-list",
        "session-new",
        "session-close",
        "session-select",
        "run-code",
        "cookie-list",
        "cookie-get",
        "cookie-set",
        "cookie-delete",
        "cookie-clear",
        "localstorage-list",
        "localstorage-get",
        "localstorage-set",
        "localstorage-delete",
        "localstorage-clear",
        "sessionstorage-list",
        "sessionstorage-get",
        "sessionstorage-set",
        "sessionstorage-delete",
        "sessionstorage-clear",
        "requests",
        "request",
        "request-headers",
        "request-body",
        "response-headers",
        "response-body",
        "route",
        "route-list",
        "unroute",
        "network-state-set",
        "console",
        "tracing-start",
        "tracing-stop",
    ],
)
def test_playwright_cli_runtime_action_rejects_prohibited_commands(
    command: str,
) -> None:
    with pytest.raises(ValidationError):
        RUNTIME_ACTION_ADAPTER.validate_python(
            {"type": "playwright_cli", "command": command}
        )


@pytest.mark.parametrize(
    ("payload", "action_type"),
    [
        (
            {
                "type": "playwright_cli",
                "command": "eval",
                "args": ["() => document.title"],
            },
            PlaywrightCliRuntimeAction,
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
                "type": "request_sign_in",
                "account_action": "create_account",
                "username_ref": "e1",
                "password_ref": "e22",
                "password_confirmation_ref": None,
                "submit_ref": "e333",
            },
            RequestSignInRuntimeAction,
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
async def test_runtime_action_endpoint_dispatches_strict_typed_actions_without_extra_headers(
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


async def test_runtime_model_action_endpoint_dispatches_private_model_action(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    payload = {
        "type": "playwright_cli",
        "command": "snapshot",
        "args": [],
    }

    response = await client.post(
        f"/v1/sessions/{SESSION_ID}/runtime/model-actions",
        headers=AUTHORIZATION,
        json=payload,
    )

    assert response.status_code == 200
    assert response.json() == {"type": "continue"}
    assert response.headers["cache-control"] == "no-store"
    assert len(service.runtime_model_action_calls) == 1
    dispatched_id, dispatched = service.runtime_model_action_calls[0]
    assert dispatched_id == SESSION_ID
    assert isinstance(dispatched, PlaywrightCliRuntimeAction)


async def test_request_sign_in_endpoint_returns_only_attempt_status(
    api_client: tuple[httpx.AsyncClient, FakeSessionService],
) -> None:
    client, service = api_client
    service.runtime_action_response = SignInRuntimeActionResponse(
        type="sign_in",
        status="attempted",
    )

    response = await client.post(
        f"/v1/sessions/{SESSION_ID}/runtime/actions",
        headers=AUTHORIZATION,
        json={
            "type": "request_sign_in",
            "username_ref": "f2e248",
            "password_ref": "f2e255",
            "submit_ref": "f2e261",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "type": "sign_in",
        "status": "attempted",
    }
    assert set(response.json()) == {"type", "status"}


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "unknown"},
        {
            "type": "playwright_cli",
            "command": "eval",
            "args": ["() => document.title"],
            "token": "secret",
        },
        {"type": "request_human_navigation", "instruction": " "},
        {
            "type": "request_sign_in",
            "username_ref": "e0",
            "password_ref": "e2",
            "submit_ref": "e3",
        },
        {
            "type": "request_sign_in",
            "username_ref": "e1\n",
            "password_ref": "e2",
            "submit_ref": "e3",
        },
        {
            "type": "request_sign_in",
            "username_ref": "e1",
            "password_ref": "e0002",
            "submit_ref": "e3",
        },
        {
            "type": "request_sign_in",
            "username_ref": "e1",
            "password_ref": "e2",
            "submit_ref": "e1234567890",
        },
        {
            "type": "request_sign_in",
            "username_ref": "f0e1",
            "password_ref": "e2",
            "submit_ref": "e3",
        },
        {
            "type": "request_sign_in",
            "username_ref": "f1e0",
            "password_ref": "e2",
            "submit_ref": "e3",
        },
        {
            "type": "request_sign_in",
            "username_ref": "e1",
            "password_ref": "e2",
            "submit_ref": "e3",
            "username": "must not be accepted",
        },
        {"type": "request_origin_approval", "origin": "https://ats.example"},
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

def test_sign_in_runtime_response_projects_only_status() -> None:
    response = RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(
        {"type": "sign_in", "status": "attempted"}
    )

    assert isinstance(response, SignInRuntimeActionResponse)
    assert response.model_dump(mode="json") == {
        "type": "sign_in",
        "status": "attempted",
    }
    with pytest.raises(ValidationError):
        RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(
            {
                "type": "sign_in",
                "status": "saved",
                "username": "ada@example.test",
            }
        )


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
        PlaywrightCliExecutionResult.model_validate(
            {
                "exit_code": 0,
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
            "type": "playwright_cli_result",
            "exit_code": 0,
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
        {"type": "interrupted"},
        {"type": "continue_without_additional_info"},
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
    if payload["type"] == "playwright_cli_result":
        assert isinstance(parsed, PlaywrightCliResultRuntimeActionResponse)

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
    with pytest.raises(ValidationError):
        RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(
            {"type": "interrupted", "unexpected": True}
        )
    with pytest.raises(ValidationError):
        RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(
            {
                "type": "continue_without_additional_info",
                "unexpected": True,
            }
        )
    with pytest.raises(ValidationError):
        RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(
            {
                "type": "approve",
                "origin": "https://ats.example",
                "approved_origins": ["https://ats.example"],
            }
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
@pytest.mark.parametrize("status", ["completed", "human_required"])
def test_email_verification_runtime_action_contract(status: str) -> None:
    action = RUNTIME_ACTION_ADAPTER.validate_python(
        {
            "type": "request_email_verification",
            "code_ref": "e41",
            "submit_ref": "e42",
        }
    )
    assert isinstance(action, RequestEmailVerificationRuntimeAction)
    assert action.code_ref == "e41"
    assert action.submit_ref == "e42"
    without_code_input = RUNTIME_ACTION_ADAPTER.validate_python(
        {"type": "request_email_verification"}
    )
    assert isinstance(without_code_input, RequestEmailVerificationRuntimeAction)
    with pytest.raises(ValidationError):
        RUNTIME_ACTION_ADAPTER.validate_python(
            {
                "type": "request_email_verification",
                "submit_ref": "e42",
            }
        )

    response = RUNTIME_ACTION_RESPONSE_ADAPTER.validate_python(
        {"type": "email_verification", "status": status}
    )
    assert isinstance(response, EmailVerificationRuntimeActionResponse)
