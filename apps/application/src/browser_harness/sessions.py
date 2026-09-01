from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date as Date, datetime, time as Time, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from fastapi import UploadFile
from pydantic import Field, TypeAdapter, ValidationError

from .application_account import (
    DEFAULT_APPLICATION_EMAIL,
    DEFAULT_APPLICATION_PASSWORD,
)
from .credentials import CredentialStore
from .gmail_verification import (
    GmailVerificationError,
    GmailVerificationInbox,
    InboxReader,
)
from .agent import ApplicationRunRequest, build_application_task
from .artifacts import (
    StoredCandidateArtifacts,
    create_session_artifact_directory,
    cleanup_orphaned_session_artifacts,
    cleanup_session_artifacts,
    retry_pending_cleanup,
    store_uploads,
)
from .playwright_cli import (
    BrowserConfigurationError,
    PlaywrightCliRuntime,
    PlaywrightCliRuntimeError,
    ResolvedBrowserLaunch,
    browser_launch_for_slot,
    recover_stale_playwright_cli_sessions,
    resolve_browser_launch,
)
from .context import CandidateContext, CandidateContextProcess
from .models import (
    BROWSER_DOM_MAX_CHARACTERS,
    BROWSER_TITLE_MAX_CHARACTERS,
    BROWSER_URL_MAX_CHARACTERS,
    PLAYWRIGHT_OUTPUT_MAX_CHARACTERS,
    AdditionalInfoRequiredDetail,
    ApplicationAnswerSuggestionsResponse,
    AdditionalInfoRuntimeActionResponse,
    ContinueWithoutAdditionalInfoRuntimeActionResponse,
    AdditionalInfoSavedDetail,
    AgentStepDetail,
    PlaywrightCliDiagnostic,
    PlaywrightCliExecutionResult,
    ApplicationRunResult,
    CancelledApplicationResult,
    ReviewApplicationResult,
    SubmittedApplicationResult,
    SubmissionUncertainApplicationResult,
    ApplicationMismatchRuntimeActionResponse,
    ApproveOriginCommand,
    CancelCommand,
    SaveCredentialsCommand,
    SignInCommand,
    PlaywrightCliResultRuntimeActionResponse,
    PlaywrightCliRuntimeAction,
    CancelRuntimeActionResponse,
    ContinueRuntimeActionResponse,
    InterruptedRuntimeActionResponse,
    ContinueCommand,
    ContinueWithoutAdditionalInfoCommand,
    EmptyEventDetail,
    HarnessConfig,
    ProvideAdditionalInfoCommand,
    HarnessEvent,
    HarnessServiceError,
    HumanNavigationDetail,
    OriginApprovalDetail,
    OpportunityKind,
    SubmitCommand,
    ReviseCommand,
    SubmitRuntimeActionResponse,
    InboxMessageSummary,
    ReadEmailRuntimeAction,
    ReadEmailRuntimeActionResponse,
    ReadInboxRuntimeAction,
    ReadInboxRuntimeActionResponse,
    ReportApplicationMismatchRuntimeAction,
    RequestAdditionalInfoRuntimeAction,
    RequestSignInRuntimeAction,
    RequestHumanNavigationRuntimeAction,
    RequestHumanReviewRuntimeAction,
    ReviseRuntimeActionResponse,
    SignInRuntimeActionResponse,
    RuntimeActionRequest,
    RuntimeActionResponse,
    RevisionAppliedDetail,
    SessionCommand,
    SteerCommand,
    SessionCreateRequest,
    SessionCreateResponse,
    SessionSnapshot,
    SourceCaptureCreateRequest,
    SourceCaptureCreateResponse,
    SourceCaptureResult,
    SessionState,
    SESSION_ERROR_MESSAGES,
    UploadedArtifacts,
    session_error,
    validate_approved_origin,
    validate_job_url,
    sanitize_public_url,
    https_job_origin,
)
from .pipeline_agent import (
    PipelineApplicationAgentClient,
    PipelineApplicationAgentError,
)
from .tools import (
    HumanGate,
    redact_public_text,
    redact_public_text_with_truncation,
    redact_public_url,
)
from .user_info import UserInfoSnapshot, UserInfoStore


logger = logging.getLogger(__name__)
_ADDITIONAL_INFO_GATE_RESPONSE_ADAPTER = TypeAdapter(
    Annotated[
        AdditionalInfoRuntimeActionResponse
        | ContinueWithoutAdditionalInfoRuntimeActionResponse,
        Field(discriminator="type"),
    ]
)
_APPLICATION_SESSION_CAPACITY = 3
_APPLICATION_SESSION_CAPACITY_MESSAGE = "Browser application session capacity is full"
_EVENT_LIMIT = 256
_TOMBSTONE_LIMIT = 32
_HEARTBEAT_SECONDS = 15.0
_CLEANUP_RETRY_MAX_SECONDS = 5.0
_SUBMISSION_UNCERTAIN_WARNING = (
    "The application submission could not be verified. Check the headed browser "
    "if it is still available, then close this session."
)
_MAX_APPLICATION_TASK_BYTES = 5_242_880
_PLAYWRIGHT_CLI_DIAGNOSTIC_LIMIT = 100
_BROWSER_RUNTIME_ERROR_MESSAGE = "Browser runtime failed."
_SOURCE_CAPTURE_ACTIVE_MESSAGE = "A source capture is already active"
_SOURCE_CAPTURE_NOT_FOUND_MESSAGE = "Source capture was not found"
_SOURCE_CAPTURE_NOT_READY_MESSAGE = "Source capture is not ready"
_SOURCE_CAPTURE_UNAVAILABLE_MESSAGE = "Source capture is unavailable"
_COMMAND_CONFLICT_MESSAGE = (
    "The application state changed; review the latest session state"
)
_STEERABLE_SESSION_STATES = frozenset(
    {
        "running",
        "awaiting_human_navigation",
        "awaiting_additional_info",
        "awaiting_human_review",
    }
)
_REDACTED_STDERR_EXCERPT = "[redacted]"
_READ_ONLY_PLAYWRIGHT_CLI_COMMANDS = frozenset(
    {
        "snapshot",
        "screenshot",
        "pdf",
        "tab-list",
        "generate-locator",
        "highlight",
        "video-chapter",
        "video-show-actions",
        "video-hide-actions",
    }
)


def _redact_playwright_cli_url(
    value: str,
    private_values: Sequence[str],
) -> str:
    if value == "about:blank":
        return value
    try:
        redacted = redact_public_url(value, private_values)
    except ValueError:
        return "[redacted]"
    return redacted if len(redacted) <= BROWSER_URL_MAX_CHARACTERS else "[redacted]"


def _public_runtime_action_response(
    response: RuntimeActionResponse,
) -> RuntimeActionResponse:
    if isinstance(
        response,
        (
            AdditionalInfoRuntimeActionResponse,
            ReviseRuntimeActionResponse,
        ),
    ):
        return ContinueRuntimeActionResponse(type="continue")
    return response


def _private_model_step_url(value: str, fallback: str) -> str:
    try:
        sanitized = sanitize_public_url(value)
        parsed = urlsplit(sanitized)
        return f"{parsed.scheme}://{parsed.netloc}"
    except ValueError:
        return fallback


ModelFactory = Callable[[UUID, str, str], PipelineApplicationAgentClient]
ApplicationRunner = Callable[
    [
        ApplicationRunRequest,
        Any,
        PlaywrightCliRuntime,
        HumanGate,
        Callable[[int, str], Awaitable[None]],
    ],
    Awaitable[ApplicationRunResult],
]
ContextProcessFactory = Callable[[StoredCandidateArtifacts], CandidateContextProcess]
RuntimeFactory = Callable[..., PlaywrightCliRuntime]


@dataclass(frozen=True, slots=True)
class _TerminalRequest:
    state: str
    event: str
    error_code: str | None = None


@dataclass(slots=True)
class _ApplicationSession:
    session_id: UUID
    snapshot: SessionSnapshot
    deadline_monotonic: float | None
    browser_slot: int | None = None
    events: deque[HarnessEvent] = field(
        default_factory=lambda: deque(maxlen=_EVENT_LIMIT)
    )
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    closed_event: asyncio.Event = field(default_factory=asyncio.Event)
    request_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    runtime_action_task: asyncio.Task[RuntimeActionResponse] | None = None
    playwright_cli_action_count: int = 0
    last_successful_inspection_step: int = 0
    sign_in_inspection_step: int = 0
    additional_info_question_count: int = 0
    submission_action_started: bool = False
    steering_epoch: int = 0
    steering_command_pending_epochs: set[int] = field(default_factory=set)
    auto_submission_approval_pending: bool = False
    setup_task: asyncio.Task[Any] | None = None
    context_process: CandidateContextProcess | None = None
    resume_upload_path: str | None = None
    request: SessionCreateRequest | None = None
    user_info: UserInfoSnapshot | None = None
    application_task: str | None = None
    stored: StoredCandidateArtifacts | None = None
    candidate: CandidateContext | None = None
    model: PipelineApplicationAgentClient | None = None
    human_gate: HumanGate | None = None
    playwright_runtime: PlaywrightCliRuntime | None = None
    agent_task: asyncio.Task[None] | None = None
    ttl_task: asyncio.Task[None] | None = None
    finalizer_task: asyncio.Task[None] | None = None
    runtime_close_task: asyncio.Task[None] | None = None
    model_close_task: asyncio.Task[None] | None = None
    final_request: _TerminalRequest | None = None
    next_event_id: int = 1
    finalized: bool = False


@dataclass(frozen=True, slots=True)
class _Tombstone:
    snapshot: SessionSnapshot
    events: tuple[HarnessEvent, ...]


@dataclass(slots=True)
class _SourceCapture:
    request: SourceCaptureCreateRequest
    response: SourceCaptureCreateResponse
    setup_task: asyncio.Task[Any] | None
    session_directory: Path | None = None
    runtime: PlaywrightCliRuntime | None = None
    completion_task: asyncio.Task[SourceCaptureResult] | None = None
    cleanup_task: asyncio.Task[None] | None = None
    terminal_state: Literal[
        "completed",
        "cancelled",
        "failed",
        "shutdown",
    ] | None = None
    closed_event: asyncio.Event = field(default_factory=asyncio.Event)
    completed_result: SourceCaptureResult | None = None


@dataclass(slots=True)
class _SourceCaptureReplay:
    capture_id: UUID
    result: SourceCaptureResult


@dataclass(frozen=True, slots=True)
class _SourceCaptureTombstone:
    state: Literal[
        "completed",
        "cancelled",
        "failed",
        "shutdown",
    ]


def _now() -> datetime:
    return datetime.now(UTC)


def _job_origin(job_url: str) -> str:
    parsed = urlsplit(job_url)
    if parsed.hostname is None:
        raise ValueError("job URL has no origin")
    host = parsed.hostname.lower().rstrip(".")
    if ":" in host:
        host = f"[{host}]"
    port = parsed.port
    if (parsed.scheme.lower() == "https" and port == 443) or (
        parsed.scheme.lower() == "http" and port == 80
    ):
        port = None
    netloc = f"{host}:{port}" if port is not None else host
    return validate_approved_origin(f"{parsed.scheme.lower()}://{netloc}")


def _sse_frame(event: HarnessEvent) -> str:
    return (
        f"id: {event.id}\n"
        f"event: {event.event}\n"
        f"data: {event.model_dump_json()}\n\n"
    )


def _pending_action_for_state(
    state: SessionState,
    event: str | None,
    detail: dict[str, object] | Any,
) -> dict[str, object] | None:
    if state == "awaiting_human_navigation":
        if event == "credentials_required":
            EmptyEventDetail.model_validate(detail)
            return {"type": "credentials"}
        public_detail = HumanNavigationDetail.model_validate(detail)
        return {
            "type": "human_navigation",
            **public_detail.model_dump(),
        }
    if state == "awaiting_origin_approval":
        public_detail = OriginApprovalDetail.model_validate(detail)
        return {
            "type": "origin_approval",
            **public_detail.model_dump(),
        }
    if state == "awaiting_additional_info":
        public_detail = AdditionalInfoRequiredDetail.model_validate(detail)
        return {
            "type": "additional_info",
            **public_detail.model_dump(),
        }
    if state == "awaiting_human_review":
        EmptyEventDetail.model_validate(detail)
        return {"type": "human_review"}
    return None


def _saved_private_values(snapshot: UserInfoSnapshot) -> frozenset[str]:
    values: set[str] = set(snapshot.raw_text_values)
    for facts in (snapshot.saved_global, snapshot.saved_application):
        for fact in facts.values():
            if fact.status != "answered" or fact.answer_type == "boolean":
                continue
            if isinstance(fact.value, str):
                values.add(fact.value)
            elif isinstance(fact.value, tuple):
                values.update(fact.value)
    return frozenset(values)


class ApplicationSessionManager:
    """Own three application browser slots or one exclusive source capture."""

    def __init__(
        self,
        config: HarnessConfig,
        *,
        artifacts_root: Path | None = None,
        browser_launch: ResolvedBrowserLaunch | None = None,
        model_factory: ModelFactory = PipelineApplicationAgentClient,
        context_process_factory: ContextProcessFactory = CandidateContextProcess,
        application_runner: ApplicationRunner | None = None,
        runtime_factory: RuntimeFactory = PlaywrightCliRuntime,
        user_info_store: UserInfoStore | None = None,
        credential_store: CredentialStore | None = None,
        gmail_inbox: InboxReader | None = None,
        default_credentials: tuple[str, str] | None = (
            DEFAULT_APPLICATION_EMAIL,
            DEFAULT_APPLICATION_PASSWORD,
        ),
    ) -> None:
        self._config = config
        self._artifacts_root = (
            artifacts_root or Path("~/.jobhunter/browser-harness/sessions")
        ).expanduser()
        self._browser_launch = browser_launch or resolve_browser_launch(config.browser)
        self._model_factory = model_factory
        self._context_process_factory = context_process_factory
        self._application_runner = application_runner
        self._runtime_factory = runtime_factory
        self._user_info_store = user_info_store or UserInfoStore(config.user_info_json)
        self._credential_store = credential_store
        self._gmail_inbox = gmail_inbox
        self._default_credentials = default_credentials
        self._lock = asyncio.Lock()
        self._startup_lock = asyncio.Lock()
        self._startup_complete = False
        self._sessions: dict[UUID, _ApplicationSession] = {}
        self._source_capture: _SourceCapture | None = None
        self._source_capture_replay: _SourceCaptureReplay | None = None
        self._source_capture_tombstones: OrderedDict[
            UUID,
            _SourceCaptureTombstone,
        ] = OrderedDict()
        self._tombstones: OrderedDict[UUID, _Tombstone] = OrderedDict()
        self._shutting_down = False

    async def startup(self) -> None:
        async with self._startup_lock:
            if self._startup_complete:
                return
            await recover_stale_playwright_cli_sessions(
                artifacts_root=self._artifacts_root,
                node_executable=self._config.node_executable,
                cli_script=self._config.playwright_cli_script,
            )
            retry_delay = 0.05
            while not await asyncio.to_thread(
                cleanup_orphaned_session_artifacts,
                self._artifacts_root,
            ):
                logger.warning(
                    "Orphaned artifact cleanup failed; retrying before startup"
                )
                await asyncio.sleep(retry_delay)
                retry_delay = min(
                    retry_delay * 2,
                    _CLEANUP_RETRY_MAX_SECONDS,
                )
            self._startup_complete = True

    async def create_session(
        self,
        *,
        session_id: UUID | None = None,
        job_url: str,
        opportunity_kind: OpportunityKind,
        allow_domains: Sequence[str],
        auto_submit: bool = False,
        personal_information: UploadFile,
        resume: UploadFile,
        resume_source: UploadFile,
        context: Sequence[UploadFile],
        anecdotes: Sequence[UploadFile],
    ) -> SessionCreateResponse:
        await self.startup()
        try:
            validated_job_url = validate_job_url(job_url)
            if opportunity_kind not in (
                "job",
                "hackathon",
                "competition",
                "event",
                "networking_event",
            ):
                raise ValueError("opportunity_kind is invalid")
            origins = [_job_origin(validated_job_url)]
            origins.extend(validate_approved_origin(value) for value in allow_domains)
            if len(origins) > 20 or len(set(origins)) != len(origins):
                raise ValueError("approved origins are invalid")
            if type(auto_submit) is not bool:
                raise ValueError("auto_submit is invalid")
        except (TypeError, ValueError):
            raise HarnessServiceError(
                422, "invalid_request", "Request is invalid"
            ) from None

        requested_session_id = session_id
        session_id = session_id if session_id is not None else uuid4()
        created_at = _now()
        accepted_monotonic = asyncio.get_running_loop().time()
        session_timeout = self._config.session_timeout
        expires_at = (
            None
            if session_timeout is None
            else created_at + timedelta(seconds=session_timeout)
        )
        deadline_monotonic = (
            None
            if session_timeout is None
            else accepted_monotonic + session_timeout
        )
        record = _ApplicationSession(
            session_id=session_id,
            snapshot=SessionSnapshot(
                session_id=session_id,
                state="starting",
                created_at=created_at,
                updated_at=created_at,
                expires_at=expires_at,
                job_url=f"{origins[0]}/",
                approved_origins=list(origins),
            ),
            deadline_monotonic=deadline_monotonic,
            setup_task=asyncio.current_task(),
        )

        async with self._lock:
            if self._shutting_down:
                raise HarnessServiceError(
                    503, "service_unavailable", "The browser harness is shutting down"
                )
            if (
                requested_session_id is not None
                and requested_session_id in self._tombstones
            ):
                raise HarnessServiceError(
                    409,
                    "session_terminal",
                    "The application session has already ended",
                )
            if self._source_capture is not None:
                raise HarnessServiceError(
                    409,
                    "session_active",
                    "An application session is already active",
                    session_id=self._source_capture.request.capture_id,
                )
            active = self._sessions.get(session_id)
            if active is not None:
                if active.snapshot.state in {
                    "cancelled",
                    "failed",
                    "closed",
                }:
                    raise HarnessServiceError(
                        409,
                        "session_terminal",
                        "The application session has already ended",
                    )
                return self._create_response(session_id)
            if len(self._sessions) >= _APPLICATION_SESSION_CAPACITY:
                raise HarnessServiceError(
                    409,
                    "session_capacity",
                    _APPLICATION_SESSION_CAPACITY_MESSAGE,
                )
            occupied_slots = {
                active_record.browser_slot
                for active_record in self._sessions.values()
            }
            record.browser_slot = next(
                slot
                for slot in range(_APPLICATION_SESSION_CAPACITY)
                if slot not in occupied_slots
            )
            self._sessions[session_id] = record
            if deadline_monotonic is not None:
                record.ttl_task = asyncio.create_task(
                    self._expire_session(record),
                    name=f"browser-harness-ttl-{session_id}",
                )

        try:
            stored = await store_uploads(
                self._artifacts_root,
                session_id,
                personal_information,
                resume,
                resume_source,
                context,
                anecdotes,
            )
            record.stored = stored
            record.context_process = self._context_process_factory(stored)
            candidate = await record.context_process.result()
            record.context_process = None
            record.candidate = candidate
            user_info = self._user_info_store.snapshot(validated_job_url)
            record.user_info = user_info
            redaction_values = (
                *candidate.direct_fields.values(),
                *_saved_private_values(user_info),
            )
            record.snapshot = self._updated_snapshot(
                record.snapshot,
                job_url=redact_public_url(
                    validated_job_url,
                    redaction_values,
                ),
            )

            uploaded = UploadedArtifacts(
                session_directory=stored.session_directory,
                personal_information=stored.personal_upload.path,
                resume=stored.resume.path,
                resume_source=stored.resume_source.path,
                context=tuple(item.path for item in stored.contexts),
                anecdotes=tuple(item.path for item in stored.anecdotes),
            )
            request = SessionCreateRequest(
                session_id=session_id,
                job_url=validated_job_url,
                opportunity_kind=opportunity_kind,
                approved_origins=tuple(origins),
                auto_submit=auto_submit,
                artifacts=uploaded,
                direct_fields=tuple(candidate.direct_fields.items()),
            )
            record.request = request
            if not request.artifacts.resume.is_absolute():
                raise BrowserConfigurationError(
                    "The stored resume path is unavailable"
                )
            record.resume_upload_path = str(request.artifacts.resume)
            run_request = ApplicationRunRequest(
                session=request,
                candidate=candidate,
                resume_display_name=stored.resume.display_name,
                resume_source_display_name=stored.resume_source.display_name,
                user_info=user_info,
                resume_upload_path=record.resume_upload_path,
            )
            application_task = build_application_task(run_request)
            if len(application_task.encode("utf-8")) > _MAX_APPLICATION_TASK_BYTES:
                raise HarnessServiceError(
                    422, "invalid_request", "Request is invalid"
                )
            record.application_task = application_task

            model = self._model_factory(
                session_id,
                self._config.pipeline_url,
                self._config.bearer_token,
            )
            record.model = model
            await model.check_ready()

            runtime = self._runtime_factory(
                session_id=session_id,
                launch=browser_launch_for_slot(
                    self._browser_launch,
                    record.browser_slot,
                ),
                session_directory=stored.session_directory,
                node_executable=self._config.node_executable,
                cli_script=self._config.playwright_cli_script,
            )
            record.playwright_runtime = runtime
            await runtime.start(validated_job_url)
            await runtime.set_approved_origins(origins)

            async def publish_gate(
                state: SessionState,
                event: str | None,
                detail: dict[str, object] | Any,
            ) -> None:
                await self._publish_gate(record, state, event, detail)

            async def review_snapshot(result: ReviewApplicationResult) -> None:
                self._apply_result(record, result)

            record.human_gate = HumanGate(
                auto_submit=request.auto_submit,
                job_url=validated_job_url,
                private_values=(
                    *candidate.direct_fields.values(),
                    *_saved_private_values(user_info),
                ),
                user_info_store=self._user_info_store,
                approved_origins=origins,
                publish=publish_gate,
                review_snapshot=review_snapshot,
                default_credentials=self._default_credentials,
            )
            if record.final_request is not None:
                raise asyncio.CancelledError
            record.setup_task = None
            record.agent_task = asyncio.create_task(
                self._run_session(record),
                name=f"browser-harness-agent-{session_id}",
            )
        except asyncio.CancelledError:
            record.setup_task = None
            await self._begin_finalization(
                record,
                record.final_request or _TerminalRequest("closed", "closed"),
                duplicate_ok=True,
            )
            if (
                record.final_request is not None
                and record.final_request.error_code == "session_timeout"
            ):
                raise HarnessServiceError(
                    504,
                    "session_timeout",
                    "The application session expired",
                ) from None
            raise
        except PipelineApplicationAgentError as error:
            record.setup_task = None
            terminal = (
                _TerminalRequest("closed", "closed")
                if error.code == "invalid_request"
                else _TerminalRequest("failed", "failed", error.code)
            )
            await self._begin_finalization(
                record,
                terminal,
                duplicate_ok=True,
            )
            await self._join_finalizer(record)
            status_code = {
                "invalid_request": 422,
                "oauth_required": 409,
                "pipeline_unavailable": 503,
                "model_timeout": 504,
                "invalid_model_output": 502,
                "model_failed": 502,
                "application_mismatch": 409,
                "browser_failed": 502,
            }.get(error.code, 502)
            raise HarnessServiceError(
                status_code, error.code, error.public_message
            ) from None
        except HarnessServiceError:
            record.setup_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("closed", "closed"),
                duplicate_ok=True,
            )
            await self._join_finalizer(record)
            raise
        except PlaywrightCliRuntimeError as error:
            record.setup_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", error.code),
                duplicate_ok=True,
            )
            await self._join_finalizer(record)
            public = session_error(error.code)
            raise HarnessServiceError(
                504 if error.code == "session_timeout" else 503,
                public.code,
                public.message,
            ) from None
        except (
            BrowserConfigurationError,
            OSError,
            ValidationError,
        ):
            record.setup_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", "browser_failed"),
                duplicate_ok=True,
            )
            await self._join_finalizer(record)
            raise HarnessServiceError(
                503, "browser_failed", "The browser session failed"
            ) from None
        except Exception:
            record.setup_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("closed", "closed"),
                duplicate_ok=True,
            )
            await self._join_finalizer(record)
            raise HarnessServiceError(
                500, "internal_error", "Request failed"
            ) from None

        return self._create_response(session_id)

    def _create_response(self, session_id: UUID) -> SessionCreateResponse:
        base = f"http://127.0.0.1:{self._config.port}/v1/sessions/{session_id}"
        return SessionCreateResponse(
            session_id=session_id,
            events_url=f"{base}/events",
            commands_url=f"{base}/commands",
        )

    def _clear_source_capture_replay_locked(self) -> None:
        self._source_capture_replay = None

    def _source_capture_replay_result_locked(
        self,
        capture_id: UUID,
    ) -> SourceCaptureResult | None:
        replay = self._source_capture_replay
        if replay is None:
            return None
        return replay.result if replay.capture_id == capture_id else None

    def _clear_source_capture_completed_result_locked(
        self,
        record: _SourceCapture,
    ) -> None:
        record.completed_result = None

    def _install_source_capture_replay_locked(
        self,
        record: _SourceCapture,
    ) -> None:
        self._clear_source_capture_replay_locked()
        result = record.completed_result
        self._clear_source_capture_completed_result_locked(record)
        if result is None or self._shutting_down:
            return
        self._source_capture_replay = _SourceCaptureReplay(
            capture_id=record.request.capture_id,
            result=result,
        )

    async def create_source_capture(
        self,
        *,
        capture_id: UUID,
        job_url: str,
        approved_origins: Sequence[str],
    ) -> SourceCaptureCreateResponse:
        await self.startup()
        try:
            request = SourceCaptureCreateRequest(
                capture_id=capture_id,
                job_url=job_url,
                approved_origins=list(approved_origins),
            )
        except (TypeError, ValueError, ValidationError):
            raise HarnessServiceError(
                422,
                "invalid_request",
                "Request is invalid",
            ) from None

        response = SourceCaptureCreateResponse(
            capture_id=request.capture_id,
            state="awaiting_human_verification",
        )
        record = _SourceCapture(
            request=request,
            response=response,
            setup_task=None,
        )
        setup: asyncio.Task[Any] | None

        async with self._lock:
            if self._shutting_down:
                raise HarnessServiceError(
                    503,
                    "unavailable",
                    _SOURCE_CAPTURE_UNAVAILABLE_MESSAGE,
                )
            if self._sessions:
                raise HarnessServiceError(
                    409,
                    "source_capture_active",
                    _SOURCE_CAPTURE_ACTIVE_MESSAGE,
                )
            active_capture = self._source_capture
            if active_capture is not None:
                if (
                    active_capture.request.capture_id == request.capture_id
                    and active_capture.request == request
                    and active_capture.terminal_state is None
                ):
                    record = active_capture
                    response = active_capture.response
                    setup = active_capture.setup_task
                else:
                    raise HarnessServiceError(
                        409,
                        "source_capture_active",
                        _SOURCE_CAPTURE_ACTIVE_MESSAGE,
                    )
            else:
                if request.capture_id in self._source_capture_tombstones:
                    raise HarnessServiceError(
                        409,
                        "source_capture_not_ready",
                        _SOURCE_CAPTURE_NOT_READY_MESSAGE,
                    )
                self._clear_source_capture_replay_locked()
                self._source_capture = record
                record.setup_task = asyncio.create_task(
                    self._setup_source_capture_record(record),
                    name=(
                        "browser-harness-source-capture-setup-"
                        f"{request.capture_id}"
                    ),
                )
                setup = record.setup_task

        if setup is not None:
            try:
                await asyncio.shield(setup)
            except asyncio.CancelledError:
                current = asyncio.current_task()
                if current is not None and current.cancelling():
                    raise
                if record.terminal_state == "cancelled":
                    raise HarnessServiceError(
                        409,
                        "source_capture_not_ready",
                        _SOURCE_CAPTURE_NOT_READY_MESSAGE,
                    ) from None
                raise HarnessServiceError(
                    503,
                    "unavailable",
                    _SOURCE_CAPTURE_UNAVAILABLE_MESSAGE,
                ) from None
        return response

    async def _setup_source_capture_record(
        self,
        record: _SourceCapture,
    ) -> None:
        current_task = asyncio.current_task()
        try:
            record.session_directory = create_session_artifact_directory(
                self._artifacts_root,
                record.request.capture_id,
            )
            runtime = self._runtime_factory(
                session_id=record.request.capture_id,
                launch=self._browser_launch,
                session_directory=record.session_directory,
                node_executable=self._config.node_executable,
                cli_script=self._config.playwright_cli_script,
            )
            record.runtime = runtime
            await runtime.start(record.request.job_url)
            await runtime.set_approved_origins(
                record.request.approved_origins
            )
            await runtime.suppress_private_capture()
            async with self._lock:
                if record.terminal_state is not None:
                    raise asyncio.CancelledError
                if record.setup_task is current_task:
                    record.setup_task = None
            return
        except asyncio.CancelledError:
            async with self._lock:
                cleanup_was_started = record.cleanup_task is not None
                terminal_state = record.terminal_state
                cleanup = self._schedule_source_capture_cleanup_locked(
                    record,
                    terminal_state or "failed",
                )
                if record.setup_task is current_task:
                    record.setup_task = None
            if not cleanup_was_started:
                await asyncio.shield(cleanup)
            if terminal_state == "cancelled":
                raise HarnessServiceError(
                    409,
                    "source_capture_not_ready",
                    _SOURCE_CAPTURE_NOT_READY_MESSAGE,
                ) from None
            raise HarnessServiceError(
                503,
                "unavailable",
                _SOURCE_CAPTURE_UNAVAILABLE_MESSAGE,
            ) from None
        except Exception:
            async with self._lock:
                cleanup_was_started = record.cleanup_task is not None
                cleanup = self._schedule_source_capture_cleanup_locked(
                    record,
                    record.terminal_state or "failed",
                )
                if record.setup_task is current_task:
                    record.setup_task = None
            if not cleanup_was_started:
                await asyncio.shield(cleanup)
            raise HarnessServiceError(
                503,
                "unavailable",
                _SOURCE_CAPTURE_UNAVAILABLE_MESSAGE,
            ) from None

    async def complete_source_capture(
        self,
        capture_id: UUID,
    ) -> SourceCaptureResult:
        completion: asyncio.Task[SourceCaptureResult] | None = None
        replay_available = False
        replay_cleanup: asyncio.Task[None] | None = None
        async with self._lock:
            record = self._source_capture
            if record is None or record.request.capture_id != capture_id:
                replay_available = (
                    self._source_capture_replay_result_locked(capture_id)
                    is not None
                )
                if not replay_available:
                    if capture_id in self._source_capture_tombstones:
                        raise HarnessServiceError(
                            409,
                            "source_capture_not_ready",
                            _SOURCE_CAPTURE_NOT_READY_MESSAGE,
                        )
                    raise HarnessServiceError(
                        404,
                        "source_capture_not_found",
                        _SOURCE_CAPTURE_NOT_FOUND_MESSAGE,
                    )
            elif (
                record.terminal_state == "completed"
                and record.completed_result is not None
            ):
                replay_available = True
                replay_cleanup = record.cleanup_task
            elif (
                record.cleanup_task is not None
                or record.terminal_state is not None
                or record.setup_task is not None
            ):
                raise HarnessServiceError(
                    409,
                    "source_capture_not_ready",
                    _SOURCE_CAPTURE_NOT_READY_MESSAGE,
                )
            else:
                if record.completion_task is None:
                    record.completion_task = asyncio.create_task(
                        self._complete_source_capture_record(record),
                        name=(
                            "browser-harness-source-capture-complete-"
                            f"{capture_id}"
                        ),
                    )
                completion = record.completion_task
        if replay_available:
            if replay_cleanup is not None:
                await asyncio.shield(replay_cleanup)
            async with self._lock:
                replay_result = self._source_capture_replay_result_locked(
                    capture_id
                )
            if replay_result is None:
                raise HarnessServiceError(
                    409,
                    "source_capture_not_ready",
                    _SOURCE_CAPTURE_NOT_READY_MESSAGE,
                )
            return replay_result
        assert completion is not None
        try:
            return await asyncio.shield(completion)
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise
            raise HarnessServiceError(
                409,
                "source_capture_not_ready",
                _SOURCE_CAPTURE_NOT_READY_MESSAGE,
            ) from None

    async def _complete_source_capture_record(
        self,
        record: _SourceCapture,
    ) -> SourceCaptureResult:
        current_task = asyncio.current_task()
        runtime = record.runtime
        if runtime is None:
            cleanup, failure_won = (
                await self._fail_source_capture_completion(
                    record,
                    current_task,
                )
            )
            await asyncio.shield(cleanup)
            if not failure_won:
                raise HarnessServiceError(
                    409,
                    "source_capture_not_ready",
                    _SOURCE_CAPTURE_NOT_READY_MESSAGE,
                )
            raise HarnessServiceError(
                503,
                "unavailable",
                _SOURCE_CAPTURE_UNAVAILABLE_MESSAGE,
            )
        try:
            captured = await runtime.capture_source_snapshot(
                record.request.approved_origins[0]
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            cleanup, failure_won = (
                await self._fail_source_capture_completion(
                    record,
                    current_task,
                )
            )
            await asyncio.shield(cleanup)
            if not failure_won:
                raise HarnessServiceError(
                    409,
                    "source_capture_not_ready",
                    _SOURCE_CAPTURE_NOT_READY_MESSAGE,
                )
            raise HarnessServiceError(
                503,
                "unavailable",
                _SOURCE_CAPTURE_UNAVAILABLE_MESSAGE,
            ) from None

        if captured is None:
            cleanup = await self._release_source_capture_completion(
                record,
                current_task,
            )
            if cleanup is not None:
                await asyncio.shield(cleanup)
            raise HarnessServiceError(
                409,
                "source_capture_not_ready",
                _SOURCE_CAPTURE_NOT_READY_MESSAGE,
            )

        try:
            if (
                not isinstance(captured, tuple)
                or len(captured) != 2
                or not all(isinstance(value, str) for value in captured)
            ):
                raise TypeError("invalid source capture result")
            final_url, source = captured
            if (
                https_job_origin(final_url)
                != record.request.approved_origins[0]
            ):
                raise ValueError("source capture left its approved origin")
            result = SourceCaptureResult(
                capture_id=record.request.capture_id,
                final_url=final_url,
                source=source,
            )
        except (TypeError, ValueError, ValidationError):
            cleanup, failure_won = (
                await self._fail_source_capture_completion(
                    record,
                    current_task,
                )
            )
            await asyncio.shield(cleanup)
            if not failure_won:
                raise HarnessServiceError(
                    409,
                    "source_capture_not_ready",
                    _SOURCE_CAPTURE_NOT_READY_MESSAGE,
                )
            raise HarnessServiceError(
                503,
                "unavailable",
                _SOURCE_CAPTURE_UNAVAILABLE_MESSAGE,
            ) from None

        del captured, final_url, source
        cleanup, completion_won = (
            await self._finish_source_capture_completion(
                record,
                current_task,
                result,
            )
        )
        del result
        await asyncio.shield(cleanup)
        if not completion_won:
            raise HarnessServiceError(
                409,
                "source_capture_not_ready",
                _SOURCE_CAPTURE_NOT_READY_MESSAGE,
            )
        async with self._lock:
            replay_result = self._source_capture_replay_result_locked(
                record.request.capture_id
            )
        if replay_result is None:
            raise HarnessServiceError(
                409,
                "source_capture_not_ready",
                _SOURCE_CAPTURE_NOT_READY_MESSAGE,
            )
        return replay_result

    async def _finish_source_capture_completion(
        self,
        record: _SourceCapture,
        task: asyncio.Task[Any] | None,
        result: SourceCaptureResult,
    ) -> tuple[asyncio.Task[None], bool]:
        async with self._lock:
            cleanup = self._schedule_source_capture_cleanup_locked(
                record,
                "completed",
            )
            completion_won = record.terminal_state == "completed"
            if completion_won:
                self._clear_source_capture_completed_result_locked(record)
                record.completed_result = result
            if record.completion_task is task:
                record.completion_task = None
            return cleanup, completion_won

    async def _fail_source_capture_completion(
        self,
        record: _SourceCapture,
        task: asyncio.Task[Any] | None,
    ) -> tuple[asyncio.Task[None], bool]:
        async with self._lock:
            cleanup = self._schedule_source_capture_cleanup_locked(
                record,
                "failed",
            )
            if record.completion_task is task:
                record.completion_task = None
            return cleanup, record.terminal_state == "failed"

    async def _release_source_capture_completion(
        self,
        record: _SourceCapture,
        task: asyncio.Task[Any] | None,
    ) -> asyncio.Task[None] | None:
        async with self._lock:
            cleanup = record.cleanup_task
            if record.completion_task is task:
                record.completion_task = None
            return cleanup

    async def delete_source_capture(self, capture_id: UUID) -> None:
        async with self._lock:
            record = self._source_capture
            if record is None or record.request.capture_id != capture_id:
                replay = self._source_capture_replay
                if replay is not None and replay.capture_id == capture_id:
                    self._clear_source_capture_replay_locked()
                if capture_id in self._source_capture_tombstones:
                    return
                raise HarnessServiceError(
                    404,
                    "source_capture_not_found",
                    _SOURCE_CAPTURE_NOT_FOUND_MESSAGE,
                )
            self._clear_source_capture_completed_result_locked(record)
            cleanup = self._schedule_source_capture_cleanup_locked(
                record,
                "cancelled",
            )
        await asyncio.shield(cleanup)
        async with self._lock:
            replay = self._source_capture_replay
            if replay is not None and replay.capture_id == capture_id:
                self._clear_source_capture_replay_locked()


    async def _begin_source_capture_cleanup(
        self,
        record: _SourceCapture,
        state: Literal[
            "completed",
            "cancelled",
            "failed",
            "shutdown",
        ],
    ) -> asyncio.Task[None]:
        async with self._lock:
            return self._schedule_source_capture_cleanup_locked(record, state)

    def _schedule_source_capture_cleanup_locked(
        self,
        record: _SourceCapture,
        state: Literal[
            "completed",
            "cancelled",
            "failed",
            "shutdown",
        ],
    ) -> asyncio.Task[None]:
        if record.cleanup_task is None:
            record.terminal_state = state
            record.cleanup_task = asyncio.create_task(
                self._cleanup_source_capture(record),
                name=(
                    "browser-harness-source-capture-cleanup-"
                    f"{record.request.capture_id}"
                ),
            )
        return record.cleanup_task

    async def _cleanup_source_capture(
        self,
        record: _SourceCapture,
    ) -> None:

        setup_task = record.setup_task
        if (
            setup_task is not None
            and setup_task is not asyncio.current_task()
            and not setup_task.done()
        ):
            setup_task.cancel()
            try:
                await asyncio.shield(setup_task)
            except (asyncio.CancelledError, Exception):
                pass

        completion_task = record.completion_task
        if (
            completion_task is not None
            and completion_task is not asyncio.current_task()
        ):
            if not completion_task.done():
                completion_task.cancel()
            try:
                await asyncio.shield(completion_task)
            except (asyncio.CancelledError, Exception):
                pass
        if record.completion_task is completion_task:
            record.completion_task = None

        retry_delay = 0.05
        while record.runtime is not None:
            try:
                await record.runtime.close()
            except Exception:
                logger.warning(
                    "Source-capture runtime cleanup failed; retaining ownership "
                    "and retrying"
                )
                await asyncio.sleep(retry_delay)
                retry_delay = min(
                    retry_delay * 2,
                    _CLEANUP_RETRY_MAX_SECONDS,
                )
            else:
                record.runtime = None

        if record.session_directory is not None:
            cleaned = False
            while not cleaned:
                cleanup_result = await asyncio.to_thread(
                    cleanup_session_artifacts,
                    record.session_directory,
                )
                cleaned = cleanup_result is not False
                if not cleaned:
                    logger.warning(
                        "Source-capture artifact cleanup failed; retaining "
                        "ownership and retrying"
                    )
                    await asyncio.sleep(retry_delay)
                    retry_delay = min(
                        retry_delay * 2,
                        _CLEANUP_RETRY_MAX_SECONDS,
                    )
            record.session_directory = None
        await self._drain_pending_cleanup()

        async with self._lock:
            if self._source_capture is record:
                self._source_capture = None
            state = record.terminal_state or "failed"
            if state == "completed":
                self._install_source_capture_replay_locked(record)
            else:
                self._clear_source_capture_completed_result_locked(record)
            self._source_capture_tombstones[
                record.request.capture_id
            ] = _SourceCaptureTombstone(state=state)
            self._source_capture_tombstones.move_to_end(
                record.request.capture_id
            )
            while len(self._source_capture_tombstones) > _TOMBSTONE_LIMIT:
                self._source_capture_tombstones.popitem(last=False)
        record.closed_event.set()

    def get_snapshot(self, session_id: UUID) -> SessionSnapshot:
        record = self._sessions.get(session_id)
        if record is not None:
            return SessionSnapshot.model_validate(record.snapshot.model_dump())
        tombstone = self._tombstones.get(session_id)
        if tombstone is not None:
            return SessionSnapshot.model_validate(tombstone.snapshot.model_dump())
        raise self._not_found()

    async def get_additional_info_suggestions(
        self,
        session_id: UUID,
        question_id: str,
    ) -> ApplicationAnswerSuggestionsResponse:
        record = self._sessions.get(session_id)
        if record is None:
            if session_id in self._tombstones:
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "The session is terminal",
                )
            raise self._not_found()
        async with record.request_lock:
            if record.finalized or record.final_request is not None:
                if (
                    record.final_request is not None
                    and record.final_request.error_code == "session_timeout"
                ):
                    raise HarnessServiceError(
                        409,
                        "session_terminal",
                        "The application session has already ended",
                    )
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "A terminal command is already pending",
                )
            gate = record.human_gate
            request = record.request
            if gate is None or request is None:
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "No matching text question is pending",
                )
            question = gate.get_pending_text_question(question_id)
            return ApplicationAnswerSuggestionsResponse(
                suggestions=list(
                    self._user_info_store.suggestions(
                        request.job_url,
                        question,
                    )
                )
            )

    async def stream_events(
        self, session_id: UUID, last_event_id: int | None
    ) -> AsyncIterator[str]:
        record = self._sessions.get(session_id)
        if record is not None:
            async for frame in self._stream_active(record, last_event_id):
                yield frame
            return
        tombstone = self._tombstones.get(session_id)
        if tombstone is None:
            raise self._not_found()
        for event in self._replay_events(
            tombstone.snapshot,
            tombstone.events,
            last_event_id,
        ):
            yield _sse_frame(event)

    async def command(self, session_id: UUID, command: SessionCommand) -> None:
        record = self._sessions.get(session_id)
        if record is None:
            if session_id in self._tombstones:
                raise HarnessServiceError(
                    409, "command_conflict", "The session is terminal"
                )
            raise self._not_found()

        expired = False
        credential_gate: HumanGate | None = None
        credential_command: SignInCommand | SaveCredentialsCommand | None = None
        steer_model: PipelineApplicationAgentClient | None = None
        steer_message: str | None = None
        steer_epoch: int | None = None
        async with record.request_lock:
            if record.finalized or record.final_request is not None:
                if (
                    record.final_request is not None
                    and record.final_request.error_code == "session_timeout"
                ):
                    raise HarnessServiceError(
                        409,
                        "session_terminal",
                        "The application session has already ended",
                    )
                raise HarnessServiceError(
                    409, "command_conflict", "A terminal command is already pending"
                )
            if (
                record.deadline_monotonic is not None
                and asyncio.get_running_loop().time() >= record.deadline_monotonic
            ):
                terminal = (
                    _TerminalRequest("closed", "closed")
                    if record.snapshot.state
                    in {"submitted", "submission_uncertain"}
                    else _TerminalRequest("failed", "failed", "session_timeout")
                )
                await self._begin_finalization_locked(
                    record,
                    terminal,
                    duplicate_ok=True,
                )
                expired = True
            elif record.snapshot.state in {"submitted", "submission_uncertain"}:
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "Only closing the browser is allowed after a submission outcome",
                )
            elif isinstance(command, SteerCommand):
                agent_task = record.agent_task
                gate = record.human_gate
                model = record.model
                steer_epoch = record.steering_epoch
                if (
                    record.snapshot.state not in _STEERABLE_SESSION_STATES
                    or agent_task is None
                    or agent_task.done()
                    or gate is None
                    or model is None
                    or record.submission_action_started
                    or steer_epoch in record.steering_command_pending_epochs
                    or record.auto_submission_approval_pending
                    or gate.submission_approved
                ):
                    raise HarnessServiceError(
                        409,
                        "command_conflict",
                        _COMMAND_CONFLICT_MESSAGE,
                    )
                record.steering_command_pending_epochs.add(steer_epoch)
                steer_model = model
                steer_message = command.message
            elif isinstance(command, CancelCommand):
                if record.submission_action_started:
                    await self._park_submission_uncertain(record)
                else:
                    if record.human_gate is not None:
                        await record.human_gate.cancel()
                    await self._begin_finalization_locked(
                        record,
                        _TerminalRequest("cancelled", "cancelled"),
                        duplicate_ok=False,
                    )
                return
            else:
                gate = record.human_gate
                if gate is None:
                    raise HarnessServiceError(
                        409, "command_conflict", "The session is still starting"
                    )
                if (
                    record.steering_epoch in record.steering_command_pending_epochs
                    or (
                        isinstance(command, SubmitCommand)
                        and record.steering_command_pending_epochs
                    )
                ):
                    raise HarnessServiceError(
                        409,
                        "command_conflict",
                        _COMMAND_CONFLICT_MESSAGE,
                    )
                if isinstance(command, ContinueCommand):
                    await gate.continue_navigation()
                elif isinstance(command, ContinueWithoutAdditionalInfoCommand):
                    await gate.continue_without_additional_info()
                elif isinstance(command, ApproveOriginCommand):
                    await gate.approve_origin(command.origin)
                elif isinstance(command, ReviseCommand):
                    await gate.revise(command.context)
                elif isinstance(command, SubmitCommand):
                    await gate.submit()
                elif isinstance(command, ProvideAdditionalInfoCommand):
                    await gate.provide_additional_info(command.answers)
                elif isinstance(command, (SignInCommand, SaveCredentialsCommand)):
                    credential_gate = gate
                    credential_command = command
                else:
                    raise HarnessServiceError(
                        422, "invalid_request", "Command is invalid"
                    )

        if expired:
            raise HarnessServiceError(
                409,
                "session_terminal",
                "The application session has already ended",
            )
        if (
            steer_model is not None
            and steer_message is not None
            and steer_epoch is not None
        ):
            steering_error: PipelineApplicationAgentError | None = None
            try:
                await steer_model.steer(steer_message)
            except PipelineApplicationAgentError as error:
                steering_error = error
            finally:
                async with record.request_lock:
                    record.steering_command_pending_epochs.discard(steer_epoch)
                    gate = record.human_gate
                    agent_task = record.agent_task
                    steering_still_current = (
                        not record.finalized
                        and record.final_request is None
                        and record.steering_epoch == steer_epoch
                        and record.snapshot.state in _STEERABLE_SESSION_STATES
                        and gate is not None
                        and not gate.submission_approved
                        and agent_task is not None
                        and not agent_task.done()
                        and record.model is steer_model
                        and not record.submission_action_started
                    )
                    if steering_error is None and steering_still_current:
                        await gate.interrupt()
            if not steering_still_current:
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    _COMMAND_CONFLICT_MESSAGE,
                )
            if steering_error is not None:
                if steering_error.code == "command_conflict":
                    raise HarnessServiceError(
                        409,
                        "command_conflict",
                        _COMMAND_CONFLICT_MESSAGE,
                    ) from None
                raise HarnessServiceError(
                    503,
                    "pipeline_unavailable",
                    "The local pipeline model service is unavailable",
                ) from None
            return



        if credential_gate is not None and credential_command is not None:
            username, password = credential_command.credentials()
            if isinstance(credential_command, SignInCommand):
                await credential_gate.sign_in(username, password)
            else:
                await credential_gate.save_credentials(username, password)
    async def runtime_action(
        self,
        session_id: UUID,
        action: RuntimeActionRequest,
    ) -> RuntimeActionResponse:
        return await self._runtime_action(
            session_id,
            action,
            expose_applicant_values=False,
        )

    async def runtime_model_action(
        self,
        session_id: UUID,
        action: RuntimeActionRequest,
    ) -> RuntimeActionResponse:
        return await self._runtime_action(
            session_id,
            action,
            expose_applicant_values=True,
        )

    async def _runtime_action(
        self,
        session_id: UUID,
        action: RuntimeActionRequest,
        *,
        expose_applicant_values: bool,
    ) -> RuntimeActionResponse:
        record = self._sessions.get(session_id)
        if record is None:
            if session_id in self._tombstones:
                raise HarnessServiceError(
                    409, "command_conflict", "The session is terminal"
                )
            raise self._not_found()

        async with record.request_lock:
            if record.finalized or record.final_request is not None:
                raise HarnessServiceError(
                    409, "command_conflict", "The session is terminal"
                )

            if record.runtime_action_task is not None:
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "A runtime action is already pending",
                )
            if record.snapshot.state in {"submitted", "submission_uncertain"}:
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "Only closing the browser is allowed after a submission outcome",
                )
            if (
                record.deadline_monotonic is not None
                and asyncio.get_running_loop().time()
                >= record.deadline_monotonic
            ):
                await self._begin_finalization_locked(
                    record,
                    _TerminalRequest("failed", "failed", "session_timeout"),
                    duplicate_ok=True,
                )
                raise HarnessServiceError(
                    504,
                    "session_timeout",
                    "The application session expired",
                )
            if (
                record.snapshot.state == "starting"
                or record.playwright_runtime is None
                or record.human_gate is None
                or record.request is None
            ):
                raise HarnessServiceError(
                    409, "command_conflict", "The session is still starting"
                )
            gate = record.human_gate
            if gate.submission_approved and not isinstance(
                action,
                (
                    PlaywrightCliRuntimeAction,
                    ReadEmailRuntimeAction,
                    ReadInboxRuntimeAction,
                    RequestHumanNavigationRuntimeAction,
                ),
            ):
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "Only browser execution and human navigation may run "
                    "after submission approval",
                )
            auto_submission_approval = (
                isinstance(action, RequestHumanReviewRuntimeAction)
                and record.request.auto_submit
            )
            if (
                auto_submission_approval
                and record.steering_command_pending_epochs
            ):
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    _COMMAND_CONFLICT_MESSAGE,
                )
            starts_submission = isinstance(
                action,
                RequestHumanNavigationRuntimeAction,
            ) or (
                isinstance(action, PlaywrightCliRuntimeAction)
                and action.command not in _READ_ONLY_PLAYWRIGHT_CLI_COMMANDS
            )
            publish_submission_started = (
                gate.submission_approved
                and starts_submission
                and not record.submission_action_started
            )
            if publish_submission_started:
                record.submission_action_started = True
            submission_attempt_active = record.submission_action_started
            record.auto_submission_approval_pending = auto_submission_approval
            task = asyncio.create_task(
                self._run_runtime_action(
                    record,
                    action,
                    submission_attempt_active,
                    publish_submission_started,
                    expose_applicant_values,
                ),
                name=f"browser-harness-runtime-action-{record.session_id}",
            )
            task.add_done_callback(self._consume_runtime_action_result)
            record.runtime_action_task = task

        return await asyncio.shield(task)

    @staticmethod
    def _consume_runtime_action_result(
        task: asyncio.Task[RuntimeActionResponse],
    ) -> None:
        if not task.cancelled():
            task.exception()

    async def _run_runtime_action(
        self,
        record: _ApplicationSession,
        action: RuntimeActionRequest,
        submission_attempt_active: bool,
        publish_submission_started: bool,
        expose_applicant_values: bool,
    ) -> RuntimeActionResponse:
        current_task = asyncio.current_task()
        try:
            if publish_submission_started:
                await self._set_state_and_event(
                    record,
                    "submitting",
                    "submission_started",
                    {},
                )
            response = await self._dispatch_runtime_action(
                record,
                action,
                expose_applicant_values,
            )
            if not expose_applicant_values:
                response = _public_runtime_action_response(response)
            if (
                submission_attempt_active
                and isinstance(action, RequestHumanNavigationRuntimeAction)
                and record.snapshot.state
                not in {"submitted", "submission_uncertain", "closed"}
            ):
                await self._publish_gate(record, "submitting", None, {})
            if (
                submission_attempt_active
                and isinstance(response, PlaywrightCliResultRuntimeActionResponse)
                and response.exit_code != 0
            ):
                await self._park_submission_uncertain(record)
            return response
        except PlaywrightCliRuntimeError as error:
            if submission_attempt_active:
                await self._park_submission_uncertain(record)
            public = session_error(error.code)
            raise HarnessServiceError(
                504 if error.code == "session_timeout" else 502,
                public.code,
                public.message,
            ) from None
        except asyncio.CancelledError:
            if submission_attempt_active:
                await self._park_submission_uncertain(record)
            raise
        except Exception:
            if submission_attempt_active:
                await self._park_submission_uncertain(record)
            raise
        finally:
            async with record.request_lock:
                if record.runtime_action_task is current_task:
                    record.runtime_action_task = None
                    record.auto_submission_approval_pending = False

    async def _dispatch_runtime_action(
        self,
        record: _ApplicationSession,
        action: RuntimeActionRequest,
        expose_applicant_values: bool,
    ) -> RuntimeActionResponse:
        runtime = record.playwright_runtime
        gate = record.human_gate
        if runtime is None or gate is None or record.request is None:
            raise HarnessServiceError(
                409, "command_conflict", "The session is still starting"
            )
        request = record.request
        if isinstance(action, (ReadInboxRuntimeAction, ReadEmailRuntimeAction)):
            if not expose_applicant_values:
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "Inbox actions are model-only",
                )
            inbox = self._gmail_inbox_for_use()
            try:
                if isinstance(action, ReadInboxRuntimeAction):
                    result = await inbox.search_inbox(
                        query=action.query,
                        date=Date.fromisoformat(action.date) if action.date else None,
                        time=Time.fromisoformat(action.time) if action.time else None,
                        received_within_minutes=action.received_within_minutes,
                        received_before_minutes_ago=action.received_before_minutes_ago,
                    )
                    return ReadInboxRuntimeActionResponse(
                        type="read_inbox_result",
                        messages=[
                            InboxMessageSummary(
                                email_id=message.message_id,
                                subject=message.subject,
                                sent_at=message.sent_at.astimezone(UTC)
                                .isoformat()
                                .replace("+00:00", "Z"),
                            )
                            for message in result.messages
                        ],
                        truncated=result.truncated,
                    )
                email = await inbox.read_email(
                    action.email_id,
                    offset=action.offset,
                )
                return ReadEmailRuntimeActionResponse(
                    type="read_email_result",
                    content=email.content,
                )
            except GmailVerificationError:
                public = session_error("browser_failed")
                raise HarnessServiceError(
                    502,
                    public.code,
                    public.message,
                ) from None


        if isinstance(action, PlaywrightCliRuntimeAction):
            async with record.request_lock:
                record.playwright_cli_action_count += 1
                step = record.playwright_cli_action_count
            try:
                result = await runtime.execute(
                    action.command,
                    action.args,
                    expose_applicant_values=expose_applicant_values,
                )
            except PlaywrightCliRuntimeError as error:
                async with record.request_lock:
                    self._append_playwright_cli_diagnostic(
                        record,
                        step,
                        error,
                    )
                public = session_error(error.code)
                raise HarnessServiceError(
                    502,
                    public.code,
                    public.message,
                ) from None
            async with record.request_lock:
                approved_submission_action = (
                    gate.submission_approved and record.submission_action_started
                )
                if (
                    record.finalized or record.final_request is not None
                ) and not approved_submission_action:
                    raise asyncio.CancelledError
                self._append_playwright_cli_diagnostic(
                    record,
                    step,
                    result,
                )
                if record.snapshot.state not in {
                    "submitted",
                    "submission_uncertain",
                    "closed",
                }:
                    current_url = (
                        _private_model_step_url(
                            result.observation.url,
                            record.snapshot.job_url,
                        )
                        if expose_applicant_values
                        else result.observation.url
                    )
                    await self._agent_step(
                        record,
                        step,
                        current_url,
                        state=(
                            "submitting" if gate.submission_approved else "running"
                        ),
                    )
                if result.exit_code == 0:
                    record.last_successful_inspection_step = step
                if expose_applicant_values:
                    model_observation = result.observation.model_copy(
                        update={
                            "screenshot": (
                                None
                                if gate.screenshots_suppressed
                                else result.observation.screenshot
                            ),
                        }
                    )
                    return PlaywrightCliResultRuntimeActionResponse(
                        type="playwright_cli_result",
                        **result.model_copy(
                            update={"observation": model_observation}
                        ).model_dump(),
                    )
                private_values = gate.redaction_values
                public_tabs = [
                    tab.model_copy(
                        update={
                            "url": _redact_playwright_cli_url(
                                tab.url,
                                private_values,
                            ),
                            "title": (
                                redact_public_text(
                                    tab.title,
                                    private_values,
                                    max_length=BROWSER_TITLE_MAX_CHARACTERS,
                                )
                                or ""
                            ),
                        }
                    )
                    for tab in result.observation.tabs
                ]
                if gate.submission_approved:
                    public_tabs = []
                public_stdout, stdout_redaction_truncated = (
                    redact_public_text_with_truncation(
                        result.stdout,
                        private_values,
                        max_length=PLAYWRIGHT_OUTPUT_MAX_CHARACTERS,
                        keep_tail=True,
                    )
                )
                public_stderr, stderr_redaction_truncated = (
                    redact_public_text_with_truncation(
                        result.stderr,
                        private_values,
                        max_length=PLAYWRIGHT_OUTPUT_MAX_CHARACTERS,
                        keep_tail=True,
                    )
                )
                public_result = result.model_copy(
                    update={
                        "stdout": public_stdout or "",
                        "stderr": public_stderr or "",
                        "stdout_truncated": (
                            result.stdout_truncated or stdout_redaction_truncated
                        ),
                        "stderr_truncated": (
                            result.stderr_truncated or stderr_redaction_truncated
                        ),
                        "observation": result.observation.model_copy(
                            update={
                                "url": _redact_playwright_cli_url(
                                    result.observation.url,
                                    private_values,
                                ),
                                "title": (
                                    redact_public_text(
                                        result.observation.title,
                                        private_values,
                                        max_length=BROWSER_TITLE_MAX_CHARACTERS,
                                    )
                                    or ""
                                ),
                                "tabs": public_tabs,
                                "dom": (
                                    redact_public_text(
                                        result.observation.dom,
                                        private_values,
                                        max_length=BROWSER_DOM_MAX_CHARACTERS,
                                    )
                                    or ""
                                ),
                                "page_info": None,
                                "screenshot": (
                                    None
                                    if gate.screenshots_suppressed
                                    else result.observation.screenshot
                                ),
                            }
                        ),
                    }
                )
                return PlaywrightCliResultRuntimeActionResponse(
                    type="playwright_cli_result",
                    **public_result.model_dump(),
                )

        if isinstance(action, RequestHumanNavigationRuntimeAction):
            gate_result = await gate.request_human_navigation(
                action.instruction,
                runtime,
            )
            terminal = self._runtime_gate_terminal_response(gate_result)
            if terminal is not None:
                return terminal
            if gate_result.interrupted:
                return InterruptedRuntimeActionResponse(type="interrupted")
            return ContinueRuntimeActionResponse(type="continue")

        if isinstance(action, RequestSignInRuntimeAction):
            async with record.request_lock:
                record.playwright_cli_action_count += 1
                if (
                    record.last_successful_inspection_step
                    <= record.sign_in_inspection_step
                ):
                    raise HarnessServiceError(
                        409,
                        "command_conflict",
                        "Inspect the application before requesting sign-in",
                    )
                record.sign_in_inspection_step = (
                    record.last_successful_inspection_step
                )
            gate_result = await gate.request_sign_in(
                account_action=action.account_action,
                username_ref=action.username_ref,
                password_ref=action.password_ref,
                password_confirmation_ref=action.password_confirmation_ref,
                submit_ref=action.submit_ref,
                runtime=runtime,
                credential_store=self._credential_store_for_use(),
            )
            terminal = self._runtime_gate_terminal_response(gate_result)
            if terminal is not None:
                return terminal
            if gate_result.interrupted:
                return InterruptedRuntimeActionResponse(type="interrupted")
            metadata = gate_result.metadata or {}
            status = metadata.get("sign_in_status")
            if status not in {"attempted", "saved"}:
                public = session_error("browser_failed")
                raise HarnessServiceError(
                    502,
                    public.code,
                    public.message,
                )
            return SignInRuntimeActionResponse(
                type="sign_in",
                status=status,
            )

        if isinstance(action, RequestAdditionalInfoRuntimeAction):
            if record.playwright_cli_action_count < 1:
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "Inspect the application before requesting additional information",
                )
            if (
                record.additional_info_question_count + len(action.questions)
                > 100
            ):
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "The additional-information question limit was reached",
                )
            record.additional_info_question_count += len(action.questions)
            gate_result = await gate.request_additional_info(
                action.questions,
                runtime,
            )
            terminal = self._runtime_gate_terminal_response(gate_result)
            if terminal is not None:
                return terminal
            if gate_result.interrupted:
                return InterruptedRuntimeActionResponse(type="interrupted")
            try:
                return _ADDITIONAL_INFO_GATE_RESPONSE_ADAPTER.validate_json(
                    gate_result.extracted_content
                )
            except (TypeError, ValidationError):
                public = session_error("browser_failed")
                raise HarnessServiceError(
                    502,
                    public.code,
                    public.message,
                ) from None
        if isinstance(action, RequestHumanReviewRuntimeAction):
            if action.result.job_url != sanitize_public_url(request.job_url):
                return ApplicationMismatchRuntimeActionResponse(
                    type="application_mismatch"
                )
            gate_result = await gate.request_human_review(
                action.result,
                runtime,
            )
            terminal = self._runtime_gate_terminal_response(gate_result)
            if terminal is not None:
                return terminal
            if gate_result.interrupted:
                return InterruptedRuntimeActionResponse(type="interrupted")
            if gate.submission_approved:
                try:
                    approved_result = ReviewApplicationResult.model_validate_json(
                        gate_result.extracted_content
                    )
                except (TypeError, ValidationError):
                    public = session_error("browser_failed")
                    raise HarnessServiceError(
                        502,
                        public.code,
                        public.message,
                    ) from None
                return SubmitRuntimeActionResponse(
                    type="submit",
                    instruction="You're good to submit.",
                    result=approved_result,
                )
            return ReviseRuntimeActionResponse(
                type="revise",
                context=gate_result.long_term_memory,
                revision_count=gate.revision_count,
            )

        if isinstance(action, ReportApplicationMismatchRuntimeAction):
            return ApplicationMismatchRuntimeActionResponse(
                type="application_mismatch"
            )

        raise HarnessServiceError(422, "invalid_request", "Request is invalid")

    def _credential_store_for_use(self) -> CredentialStore:
        credential_store = self._credential_store
        if credential_store is None:
            credential_store = CredentialStore(self._config.credentials_json)
            self._credential_store = credential_store
        return credential_store

    def _gmail_inbox_for_use(self) -> InboxReader:
        gmail_inbox = self._gmail_inbox
        if gmail_inbox is None:
            gmail_inbox = GmailVerificationInbox(self._config.gmail_token_json)
            self._gmail_inbox = gmail_inbox
        return gmail_inbox


    @staticmethod
    def _runtime_gate_terminal_response(
        gate_result: Any,
    ) -> CancelRuntimeActionResponse | None:
        if not gate_result.is_done:
            return None
        try:
            result = CancelledApplicationResult.model_validate_json(
                gate_result.extracted_content
            )
        except (TypeError, ValidationError):
            public = session_error("browser_failed")
            raise HarnessServiceError(
                502,
                public.code,
                public.message,
            ) from None
        if not gate_result.success:
            return CancelRuntimeActionResponse(type="cancel", result=result)
        public = session_error("browser_failed")
        raise HarnessServiceError(
            502,
            public.code,
            public.message,
        )

    async def delete(self, session_id: UUID) -> None:
        record = self._sessions.get(session_id)
        if record is not None:
            await self._request_terminal(
                record,
                _TerminalRequest("closed", "closed"),
                wait=True,
                duplicate_ok=True,
            )
        await self._close_terminal_tombstone(session_id)
    async def _close_terminal_tombstone(self, session_id: UUID) -> None:
        async with self._lock:
            tombstone = self._tombstones.get(session_id)
            if tombstone is None:
                raise self._not_found()
            if tombstone.snapshot.state == "closed":
                return
            snapshot = self._updated_snapshot(
                tombstone.snapshot,
                state="closed",
                error=None,
            )
            next_id = max((event.id for event in tombstone.events), default=0) + 1
            closed = HarnessEvent(
                id=next_id,
                event="closed",
                session=snapshot,
                detail=EmptyEventDetail(),
            )
            events = (*tombstone.events, closed)[-_EVENT_LIMIT:]
            self._tombstones[session_id] = _Tombstone(snapshot, events)
            self._tombstones.move_to_end(session_id)


    async def shutdown(self) -> None:
        async with self._lock:
            self._shutting_down = True
            self._clear_source_capture_replay_locked()
            records = tuple(self._sessions.values())
            source_capture = self._source_capture
            if source_capture is not None:
                self._clear_source_capture_completed_result_locked(
                    source_capture
                )
            source_cleanup = (
                self._schedule_source_capture_cleanup_locked(
                    source_capture,
                    "shutdown",
                )
                if source_capture is not None
                else None
            )
        if source_cleanup is not None:
            await asyncio.shield(source_cleanup)
        if records:
            await asyncio.gather(
                *(
                    self._request_terminal(
                        record,
                        _TerminalRequest("closed", "closed"),
                        wait=True,
                        duplicate_ok=True,
                    )
                    for record in records
                )
            )
            for record in records:
                await self._close_terminal_tombstone(record.session_id)
        await self._drain_pending_cleanup()
    async def _drain_pending_cleanup(self) -> None:
        retry_delay = 0.05
        while True:
            cleanup_result = await asyncio.to_thread(retry_pending_cleanup)
            if cleanup_result is not False:
                return
            logger.warning(
                "Pending artifact cleanup failed; retaining cleanup ownership and retrying"
            )
            await asyncio.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, _CLEANUP_RETRY_MAX_SECONDS)


    async def _run_session(self, record: _ApplicationSession) -> None:
        request = record.request
        candidate = record.candidate
        model = record.model
        runtime = record.playwright_runtime
        gate = record.human_gate
        if (
            request is None
            or candidate is None
            or model is None
            or runtime is None
            or gate is None
            or record.stored is None
            or record.resume_upload_path is None
            or record.application_task is None
            or record.user_info is None
        ):
            record.agent_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", "browser_failed"),
                duplicate_ok=True,
            )
            return

        async with record.request_lock:
            if record.finalized or record.final_request is not None:
                record.agent_task = None
                return
            if (
                record.deadline_monotonic is not None
                and asyncio.get_running_loop().time() >= record.deadline_monotonic
            ):
                record.agent_task = None
                await self._begin_finalization_locked(
                    record,
                    _TerminalRequest("failed", "failed", "session_timeout"),
                    duplicate_ok=True,
                )
                return
            await self._set_state_and_event(
                record,
                "running",
                "session_started",
                {},
            )
        try:
            if self._application_runner is None:
                deadline_ms: int | None = None
                if record.deadline_monotonic is not None:
                    remaining_ms = int(
                        (
                            record.deadline_monotonic
                            - asyncio.get_running_loop().time()
                        )
                        * 1_000
                    )
                    if remaining_ms < 1_000:
                        record.agent_task = None
                        return
                    deadline_ms = min(remaining_ms, 86_400_000)
                result = await model.run(
                    runtime_url=f"http://127.0.0.1:{self._config.port}",
                    opportunity_kind=request.opportunity_kind,
                    auto_submit=request.auto_submit,
                    task=record.application_task,
                    deadline_ms=deadline_ms,
                )
            else:
                result = await self._application_runner(
                    ApplicationRunRequest(
                        session=request,
                        candidate=candidate,
                        resume_display_name=record.stored.resume.display_name,
                        resume_source_display_name=record.stored.resume_source.display_name,
                        user_info=record.user_info,
                        resume_upload_path=record.resume_upload_path,
                    ),
                    model,
                    runtime,
                    gate,
                    lambda step, url: self._agent_step(record, step, url),
                )

            if result.job_url != sanitize_public_url(request.job_url):
                raise PipelineApplicationAgentError(
                    "application_mismatch",
                    SESSION_ERROR_MESSAGES["application_mismatch"],
                )
            if isinstance(
                result,
                (SubmittedApplicationResult, SubmissionUncertainApplicationResult),
            ):
                if not gate.submission_approved or not record.submission_action_started:
                    raise PipelineApplicationAgentError(
                        "invalid_model_output",
                        SESSION_ERROR_MESSAGES["invalid_model_output"],
                    )
            async with record.request_lock:
                if record.finalized or record.final_request is not None:
                    return
                if (
                    record.deadline_monotonic is not None
                    and asyncio.get_running_loop().time() >= record.deadline_monotonic
                ):
                    record.agent_task = None
                    await self._begin_finalization_locked(
                        record,
                        _TerminalRequest("failed", "failed", "session_timeout"),
                        duplicate_ok=True,
                    )
                    return
                if isinstance(result, CancelledApplicationResult):
                    record.agent_task = None
                    if record.submission_action_started:
                        await self._park_submission_uncertain(record)
                    else:
                        await self._begin_finalization_locked(
                            record,
                            _TerminalRequest("cancelled", "cancelled"),
                            duplicate_ok=True,
                        )
                    return
                if isinstance(result, SubmissionUncertainApplicationResult):
                    record.agent_task = None
                    await self._park_submission_uncertain(record)
                    return
                if isinstance(result, SubmittedApplicationResult):
                    record.agent_task = None
                    if record.snapshot.state == "submission_uncertain":
                        return
                    await self._set_state_and_event(
                        record,
                        "submitted",
                        "application_submitted",
                        {},
                    )
                    return
                raise PipelineApplicationAgentError(
                    "invalid_model_output",
                    SESSION_ERROR_MESSAGES["invalid_model_output"],
                )
        except asyncio.CancelledError:
            await self._finalize_agent_exit(
                record,
                _TerminalRequest("cancelled", "cancelled"),
            )
        except PipelineApplicationAgentError as error:
            error_code = (
                "invalid_model_output"
                if error.code == "invalid_request"
                else error.code
            )
            await self._finalize_agent_exit(
                record,
                _TerminalRequest("failed", "failed", error_code),
            )
        except Exception:
            await self._finalize_agent_exit(
                record,
                _TerminalRequest("failed", "failed", "browser_failed"),
            )

    async def _finalize_agent_exit(
        self,
        record: _ApplicationSession,
        request: _TerminalRequest,
    ) -> None:
        async with record.request_lock:
            record.agent_task = None
            if record.finalized or record.final_request is not None:
                return
            if (
                record.deadline_monotonic is not None
                and asyncio.get_running_loop().time() >= record.deadline_monotonic
            ):
                request = _TerminalRequest(
                    "failed",
                    "failed",
                    "session_timeout",
                )
            if record.submission_action_started and request.error_code != "session_timeout":
                await self._park_submission_uncertain(record)
                return
            await self._begin_finalization_locked(
                record,
                request,
                duplicate_ok=True,
            )

    async def _park_submission_uncertain(
        self,
        record: _ApplicationSession,
    ) -> None:
        warnings = [
            warning
            for warning in record.snapshot.warnings
            if warning != _SUBMISSION_UNCERTAIN_WARNING
        ][:99]
        warnings.append(_SUBMISSION_UNCERTAIN_WARNING)
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            warnings=warnings,
            pending_action=None,
            error=None,
        )
        if record.snapshot.state == "submission_uncertain":
            return
        await self._set_state_and_event(
            record,
            "submission_uncertain",
            "submission_uncertain",
            {},
        )

    async def _expire_session(self, record: _ApplicationSession) -> None:
        deadline_monotonic = record.deadline_monotonic
        if deadline_monotonic is None:
            return
        delay = max(
            0.0,
            deadline_monotonic - asyncio.get_running_loop().time(),
        )
        try:
            await asyncio.sleep(delay)
            async with record.request_lock:
                if record.finalized or record.final_request is not None:
                    return
                if record.submission_action_started and record.snapshot.state not in {
                    "submitted",
                    "submission_uncertain",
                }:
                    await self._park_submission_uncertain(record)
                terminal = (
                    _TerminalRequest("closed", "closed")
                    if record.snapshot.state in {"submitted", "submission_uncertain"}
                    else _TerminalRequest("failed", "failed", "session_timeout")
                )
                await self._begin_finalization_locked(
                    record,
                    terminal,
                    duplicate_ok=True,
                )
        except asyncio.CancelledError:
            return

    async def _request_terminal(
        self,
        record: _ApplicationSession,
        request: _TerminalRequest,
        *,
        wait: bool,
        duplicate_ok: bool,
    ) -> None:
        finalizing = await self._begin_finalization(
            record,
            request,
            duplicate_ok=duplicate_ok,
        )
        if wait and finalizing:
            await self._join_finalizer(record)

    async def _begin_finalization(
        self,
        record: _ApplicationSession,
        request: _TerminalRequest,
        *,
        duplicate_ok: bool,
    ) -> bool:
        async with record.request_lock:
            return await self._begin_finalization_locked(
                record,
                request,
                duplicate_ok=duplicate_ok,
            )

    async def _begin_finalization_locked(
        self,
        record: _ApplicationSession,
        request: _TerminalRequest,
        *,
        duplicate_ok: bool,
    ) -> bool:
        if record.submission_action_started and request.state != "closed":
            await self._park_submission_uncertain(record)
            if request.error_code == "session_timeout":
                request = _TerminalRequest("closed", "closed")
            else:
                return False
        if record.finalized:
            if not duplicate_ok:
                raise HarnessServiceError(
                    409, "command_conflict", "The session is terminal"
                )
            return False
        if record.final_request is None:
            record.final_request = request
        elif request.state == "closed":
            record.final_request = request
        elif not duplicate_ok:
            raise HarnessServiceError(
                409, "command_conflict", "A terminal command is already pending"
            )
        terminal = record.final_request
        if (
            terminal is not None
            and terminal.state == "failed"
            and terminal.error_code == "session_timeout"
            and (
                record.snapshot.state != "failed"
                or record.snapshot.error != session_error("session_timeout")
            )
        ):
            await self._set_state_and_event(
                record,
                terminal.state,
                terminal.event,
                {},
                error=session_error("session_timeout"),
            )
        if record.finalizer_task is None:
            record.finalizer_task = asyncio.create_task(
                self._finalize_record(record),
                name=f"browser-harness-finalizer-{record.session_id}",
            )
        return True

    async def _join_finalizer(self, record: _ApplicationSession) -> None:
        task = record.finalizer_task
        if task is not None and task is not asyncio.current_task():
            await asyncio.shield(task)
        await record.closed_event.wait()
    async def _await_owned_cleanup(
        self,
        task: asyncio.Task[None],
        resource: str,
    ) -> None:
        while True:
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=30)
                return
            except TimeoutError:
                logger.warning(
                    "%s cleanup is still running; retaining the active session",
                    resource,
                )



    async def _finalize_record(self, record: _ApplicationSession) -> None:
        if record.human_gate is not None:
            try:
                await record.human_gate.cancel()
            except Exception:
                pass

        ttl_task = record.ttl_task
        if ttl_task is not None and ttl_task is not asyncio.current_task() and not ttl_task.done():
            ttl_task.cancel()

        setup_task = record.setup_task
        if setup_task is not None and setup_task is not asyncio.current_task() and not setup_task.done():
            setup_task.cancel()
            try:
                await asyncio.shield(setup_task)
            except (asyncio.CancelledError, Exception):
                pass

        retry_delay = 0.05
        while record.context_process is not None:
            try:
                await record.context_process.terminate()
            except Exception:
                logger.warning(
                    "Context worker cleanup failed; retaining ownership and retrying"
                )
                await asyncio.sleep(retry_delay)
                retry_delay = min(
                    retry_delay * 2, _CLEANUP_RETRY_MAX_SECONDS
                )
            else:
                record.context_process = None


        agent_task = record.agent_task
        if agent_task is not None and agent_task is not asyncio.current_task() and not agent_task.done():
            agent_task.cancel()
            try:
                await asyncio.shield(agent_task)
            except (asyncio.CancelledError, Exception):
                pass

        async with record.request_lock:
            runtime_action_task = record.runtime_action_task
        if (
            runtime_action_task is not None
            and runtime_action_task is not asyncio.current_task()
        ):
            if not runtime_action_task.done():
                runtime_action_task.cancel()
            try:
                await asyncio.shield(runtime_action_task)
            except (asyncio.CancelledError, Exception):
                pass
        async with record.request_lock:
            if record.runtime_action_task is runtime_action_task:
                record.runtime_action_task = None
                record.auto_submission_approval_pending = False

        while record.playwright_runtime is not None:
            if record.runtime_close_task is None:
                record.runtime_close_task = asyncio.create_task(
                    record.playwright_runtime.close()
                )
            try:
                await self._await_owned_cleanup(
                    record.runtime_close_task,
                    "Playwright CLI runtime",
                )
            except Exception:
                logger.warning(
                    "Playwright CLI runtime cleanup failed; retaining ownership "
                    "and retrying"
                )
                record.runtime_close_task = None
                await asyncio.sleep(retry_delay)
                retry_delay = min(
                    retry_delay * 2, _CLEANUP_RETRY_MAX_SECONDS
                )
            else:
                record.playwright_runtime = None
                record.runtime_close_task = None

        while record.model is not None:
            if record.model_close_task is None:
                record.model_close_task = asyncio.create_task(record.model.aclose())
            try:
                await self._await_owned_cleanup(
                    record.model_close_task,
                    "Model client",
                )
            except Exception:
                logger.warning(
                    "Model-client cleanup failed; retaining ownership and retrying"
                )
                record.model_close_task = None
                await asyncio.sleep(retry_delay)
                retry_delay = min(
                    retry_delay * 2, _CLEANUP_RETRY_MAX_SECONDS
                )
            else:
                record.model = None

        if record.stored is not None:
            cleaned = False
            while not cleaned:
                cleanup_result = await asyncio.to_thread(
                    cleanup_session_artifacts,
                    record.stored.session_directory,
                )
                cleaned = cleanup_result is not False
                if not cleaned:
                    logger.warning("Artifact cleanup failed; retaining the active session and retrying")
                    await asyncio.sleep(retry_delay)
                    retry_delay = min(retry_delay * 2, _CLEANUP_RETRY_MAX_SECONDS)
            record.stored = None
        await self._drain_pending_cleanup()

        async with record.request_lock:
            terminal = record.final_request or _TerminalRequest("closed", "closed")
            error = (
                session_error(terminal.error_code)
                if terminal.state == "failed" and terminal.error_code is not None
                else None
            )
            event = (
                "snapshot"
                if (
                    record.snapshot.state == terminal.state
                    and record.snapshot.error == error
                )
                else terminal.event
            )
            record.snapshot = self._updated_snapshot(
                record.snapshot,
                state=terminal.state,
                pending_action=None,
                error=error,
                slot_released=True,
                approved_origins=(
                    list(record.human_gate.approved_origins)
                    if record.human_gate is not None
                    else record.snapshot.approved_origins
                ),
                revision_count=(
                    record.human_gate.revision_count
                    if record.human_gate is not None
                    else record.snapshot.revision_count
                ),
            )
            await self._publish_event(record, event, {})
            record.finalized = True
            async with self._lock:
                if self._sessions.get(record.session_id) is record:
                    del self._sessions[record.session_id]
                self._tombstones[record.session_id] = _Tombstone(
                    SessionSnapshot.model_validate(record.snapshot.model_dump()),
                    tuple(record.events),
                )
                self._tombstones.move_to_end(record.session_id)
                while len(self._tombstones) > _TOMBSTONE_LIMIT:
                    self._tombstones.popitem(last=False)
        record.closed_event.set()
        async with record.condition:
            record.condition.notify_all()

    async def _publish_gate(
        self,
        record: _ApplicationSession,
        state: SessionState,
        event: str | None,
        detail: dict[str, object] | Any,
    ) -> None:
        if record.finalized or record.final_request is not None:
            return
        record.steering_epoch += 1
        approved = (
            list(record.human_gate.approved_origins)
            if record.human_gate is not None
            else record.snapshot.approved_origins
        )
        revision_count = (
            record.human_gate.revision_count
            if record.human_gate is not None
            else record.snapshot.revision_count
        )
        pending_action = _pending_action_for_state(state, event, detail)
        snapshot_changed = (
            record.snapshot.state != state
            or record.snapshot.pending_action != pending_action
            or record.snapshot.approved_origins != approved
            or record.snapshot.revision_count != revision_count
            or record.snapshot.error is not None
        )
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            state=state,
            pending_action=pending_action,
            approved_origins=approved,
            revision_count=revision_count,
            error=None,
        )
        if event is not None:
            await self._publish_event(record, event, detail)
        elif snapshot_changed:
            await self._publish_event(record, "snapshot", {})

    def _append_playwright_cli_diagnostic(
        self,
        record: _ApplicationSession,
        step: int,
        outcome: PlaywrightCliExecutionResult | PlaywrightCliRuntimeError,
    ) -> None:
        if isinstance(outcome, PlaywrightCliRuntimeError):
            diagnostic = PlaywrightCliDiagnostic(
                step=step,
                status="failed",
                exit_code=-1,
                error_category="browser_runtime",
                stderr_excerpt=_BROWSER_RUNTIME_ERROR_MESSAGE,
                stderr_truncated=False,
            )
        else:
            if outcome.exit_code != 0:
                status = "failed"
                error_category = "process_exit"
                stderr_excerpt = (
                    _REDACTED_STDERR_EXCERPT if outcome.stderr else None
                )
            else:
                status = "succeeded"
                error_category = None
                stderr_excerpt = (
                    _REDACTED_STDERR_EXCERPT if outcome.stderr else None
                )
            diagnostic = PlaywrightCliDiagnostic(
                step=step,
                status=status,
                exit_code=outcome.exit_code,
                error_category=error_category,
                stderr_excerpt=stderr_excerpt,
                stderr_truncated=outcome.stderr_truncated,
            )

        diagnostics = list(record.snapshot.playwright_cli_diagnostics)
        diagnostics.append(diagnostic)
        if len(diagnostics) > _PLAYWRIGHT_CLI_DIAGNOSTIC_LIMIT:
            del diagnostics[:-_PLAYWRIGHT_CLI_DIAGNOSTIC_LIMIT]
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            playwright_cli_diagnostics=diagnostics,
        )

    async def _agent_step(
        self,
        record: _ApplicationSession,
        step_number: int,
        current_url: str,
        *,
        state: SessionState = "running",
    ) -> None:
        if record.finalized or record.final_request is not None:
            return
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            state=state,
            pending_action=None,
            error=None,
        )
        private_values = (
            record.human_gate.redaction_values
            if record.human_gate is not None
            else ()
        )
        try:
            public_current_url = redact_public_url(current_url, private_values)
        except ValueError:
            public_current_url = record.snapshot.job_url
        await self._publish_event(
            record,
            "agent_step",
            {
                "step_number": step_number,
                "current_url": public_current_url,
            },
        )

    def _apply_result(
        self, record: _ApplicationSession, result: ReviewApplicationResult
    ) -> None:
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            company=result.company,
            role=result.role,
            job_url=redact_public_url(
                result.job_url,
                (
                    record.human_gate.redaction_values
                    if record.human_gate is not None
                    else ()
                ),
            ),
            fields_filled=result.fields_filled,
            fields_needing_human=result.fields_needing_human,
            files_attached=result.files_attached,
            warnings=result.warnings,
            revision_count=result.revision_count,
            approved_origins=(
                list(record.human_gate.approved_origins)
                if record.human_gate is not None
                else record.snapshot.approved_origins
            ),
        )

    async def _set_state_and_event(
        self,
        record: _ApplicationSession,
        state: str,
        event: str,
        detail: dict[str, object],
        *,
        error=None,
    ) -> None:
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            state=state,
            pending_action=None,
            error=error,
            approved_origins=(
                list(record.human_gate.approved_origins)
                if record.human_gate is not None
                else record.snapshot.approved_origins
            ),
            revision_count=(
                record.human_gate.revision_count
                if record.human_gate is not None
                else record.snapshot.revision_count
            ),
        )
        await self._publish_event(record, event, detail)

    async def _publish_event(
        self,
        record: _ApplicationSession,
        event: str,
        detail: dict[str, object],
    ) -> None:
        detail_model: Any
        if event == "agent_step":
            detail_model = AgentStepDetail.model_validate(detail)
        elif event == "human_navigation_required":
            detail_model = HumanNavigationDetail.model_validate(detail)
        elif event == "origin_approval_required":
            detail_model = OriginApprovalDetail.model_validate(detail)
        elif event == "revision_applied":
            detail_model = RevisionAppliedDetail.model_validate(detail)
        elif event == "additional_info_required":
            detail_model = AdditionalInfoRequiredDetail.model_validate(detail)
        elif event == "additional_info_saved":
            detail_model = AdditionalInfoSavedDetail.model_validate(detail)
        else:
            detail_model = EmptyEventDetail()
        public_event = HarnessEvent(
            id=record.next_event_id,
            event=event,
            session=SessionSnapshot.model_validate(record.snapshot.model_dump()),
            detail=detail_model,
        )
        record.next_event_id += 1
        async with record.condition:
            if public_event.session.state != "awaiting_additional_info" and any(
                retained.event == "additional_info_required"
                for retained in record.events
            ):
                record.events = deque(
                    (
                        retained
                        for retained in record.events
                        if retained.event != "additional_info_required"
                    ),
                    maxlen=record.events.maxlen,
                )
            record.events.append(public_event)
            record.condition.notify_all()

    async def _stream_active(
        self,
        record: _ApplicationSession,
        last_event_id: int | None,
    ) -> AsyncIterator[str]:
        cursor = last_event_id or 0
        first_pass = True
        while True:
            replay: list[HarnessEvent] = []
            terminal = False
            async with record.condition:
                events = tuple(record.events)
                if first_pass:
                    replay = self._replay_events(
                        record.snapshot,
                        events,
                        last_event_id,
                    )
                    first_pass = False
                else:
                    replay = [event for event in events if event.id > cursor]
                if replay:
                    cursor = replay[-1].id
                terminal = record.finalized
                if not replay and not terminal:
                    try:
                        await asyncio.wait_for(
                            record.condition.wait(),
                            timeout=_HEARTBEAT_SECONDS,
                        )
                    except TimeoutError:
                        pass
                    else:
                        continue
            for event in replay:
                yield _sse_frame(event)
            if terminal:
                return
            if not replay:
                yield ": heartbeat\n\n"

    def _replay_events(
        self,
        snapshot: SessionSnapshot,
        events: tuple[HarnessEvent, ...],
        last_event_id: int | None,
    ) -> list[HarnessEvent]:
        if last_event_id is None:
            return list(events)
        latest_id = events[-1].id if events else 0
        oldest_id = events[0].id if events else latest_id
        if last_event_id > latest_id or (
            events and last_event_id < oldest_id - 1
        ):
            return [
                HarnessEvent(
                    id=latest_id,
                    event="snapshot",
                    session=SessionSnapshot.model_validate(snapshot.model_dump()),
                    detail=EmptyEventDetail(),
                )
            ]
        return [event for event in events if event.id > last_event_id]

    def _updated_snapshot(
        self, snapshot: SessionSnapshot, **updates: Any
    ) -> SessionSnapshot:
        values = snapshot.model_dump()
        values.update(updates)
        values["updated_at"] = max(
            _now(),
            snapshot.updated_at + timedelta(milliseconds=1),
        )
        return SessionSnapshot.model_validate(values)

    def _not_found(self) -> HarnessServiceError:
        return HarnessServiceError(
            404, "session_not_found", "Session was not found"
        )


__all__ = ["ApplicationSessionManager"]
