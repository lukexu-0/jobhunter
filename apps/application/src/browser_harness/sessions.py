from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from fastapi import UploadFile
from pydantic import ValidationError

from .credentials import CredentialStore
from .agent import ApplicationRunRequest, build_application_task
from .artifacts import (
    StoredCandidateArtifacts,
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
    recover_stale_playwright_cli_sessions,
    resolve_browser_launch,
)
from .context import CandidateContext, CandidateContextProcess
from .models import (
    AdditionalInfoRequiredDetail,
    AdditionalInfoRuntimeActionResponse,
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
    ContinueCommand,
    EmptyEventDetail,
    HarnessConfig,
    ProvideAdditionalInfoCommand,
    HarnessEvent,
    HarnessServiceError,
    HumanNavigationDetail,
    OriginApprovalDetail,
    SubmitCommand,
    ReviseCommand,
    SubmitRuntimeActionResponse,
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
    SessionCreateRequest,
    SessionCreateResponse,
    SessionSnapshot,
    SessionState,
    SESSION_ERROR_MESSAGES,
    UploadedArtifacts,
    session_error,
    validate_approved_origin,
    validate_job_url,
    sanitize_public_url,
)
from .pipeline_agent import (
    PipelineApplicationAgentClient,
    PipelineApplicationAgentError,
)
from .tools import (
    HumanGate,
    redact_public_text,
    redact_public_url,
)
from .user_info import UserInfoSnapshot, UserInfoStore


logger = logging.getLogger(__name__)
_EVENT_LIMIT = 256
_TOMBSTONE_LIMIT = 32
_HEARTBEAT_SECONDS = 15.0
_CLEANUP_RETRY_MAX_SECONDS = 5.0
_SUBMISSION_UNCERTAIN_WARNING = (
    "The application submission could not be verified. Check the headed browser "
    "if it is still available, then close this session."
)
_MAX_APPLICATION_TASK_BYTES = 1024 * 1024
_PLAYWRIGHT_CLI_DIAGNOSTIC_LIMIT = 100
_PLAYWRIGHT_CLI_TIMEOUT_MESSAGE = (
    "Playwright CLI execution timed out after 120 seconds."
)
_BROWSER_RUNTIME_ERROR_MESSAGE = "Browser runtime failed."
_SESSION_TIMEOUT_DIAGNOSTIC_MESSAGE = "Application session expired."
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
        return redact_public_url(value, private_values)
    except ValueError:
        return "[redacted]"


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
    deadline_monotonic: float
    events: deque[HarnessEvent] = field(
        default_factory=lambda: deque(maxlen=_EVENT_LIMIT)
    )
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    closed_event: asyncio.Event = field(default_factory=asyncio.Event)
    request_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    runtime_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    runtime_action_pending: bool = False
    runtime_action_task: asyncio.Task[Any] | None = None
    playwright_cli_action_count: int = 0
    last_successful_inspection_step: int = 0
    sign_in_inspection_step: int = 0
    additional_info_question_count: int = 0
    submission_action_started: bool = False
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
    values: set[str] = set()
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
    """Own exactly one application session and a bounded terminal history."""

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
        self._lock = asyncio.Lock()
        self._startup_lock = asyncio.Lock()
        self._startup_complete = False
        self._active: _ApplicationSession | None = None
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
        allow_domains: Sequence[str],
        auto_submit: bool = False,
        max_steps: int,
        personal_information: UploadFile,
        resume: UploadFile,
        context: Sequence[UploadFile],
        anecdotes: Sequence[UploadFile],
    ) -> SessionCreateResponse:
        await self.startup()
        try:
            validated_job_url = validate_job_url(job_url)
            origins = [_job_origin(validated_job_url)]
            origins.extend(validate_approved_origin(value) for value in allow_domains)
            if len(origins) > 20 or len(set(origins)) != len(origins):
                raise ValueError("approved origins are invalid")
            if type(auto_submit) is not bool:
                raise ValueError("auto_submit is invalid")
            if not 1 <= max_steps <= 500:
                raise ValueError("max_steps is invalid")
        except (TypeError, ValueError):
            raise HarnessServiceError(
                422, "invalid_request", "Request is invalid"
            ) from None

        requested_session_id = session_id
        session_id = session_id if session_id is not None else uuid4()
        created_at = _now()
        accepted_monotonic = asyncio.get_running_loop().time()
        record = _ApplicationSession(
            session_id=session_id,
            snapshot=SessionSnapshot(
                session_id=session_id,
                state="starting",
                created_at=created_at,
                updated_at=created_at,
                expires_at=created_at + timedelta(seconds=self._config.session_timeout),
                job_url=f"{origins[0]}/",
                approved_origins=list(origins),
            ),
            deadline_monotonic=(
                accepted_monotonic + self._config.session_timeout
            ),
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
            if self._active is not None:
                if (
                    requested_session_id is not None
                    and self._active.session_id == requested_session_id
                ):
                    if self._active.snapshot.state in {
                        "cancelled",
                        "failed",
                        "closed",
                    }:
                        raise HarnessServiceError(
                            409,
                            "session_terminal",
                            "The application session has already ended",
                        )
                    return self._create_response(requested_session_id)
                raise HarnessServiceError(
                    409,
                    "session_active",
                    "An application session is already active",
                    session_id=self._active.session_id,
                )
            self._active = record
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
                context=tuple(item.path for item in stored.contexts),
                anecdotes=tuple(item.path for item in stored.anecdotes),
            )
            request = SessionCreateRequest(
                session_id=session_id,
                job_url=validated_job_url,
                approved_origins=tuple(origins),
                auto_submit=auto_submit,
                max_steps=max_steps,
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
                launch=self._browser_launch,
                session_directory=stored.session_directory,
                deadline=record.deadline_monotonic,
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
                action_timeout=float(self._config.session_timeout),
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
                "step_limit": 409,
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

    def get_snapshot(self, session_id: UUID) -> SessionSnapshot:
        record = self._active
        if record is not None and record.session_id == session_id:
            return SessionSnapshot.model_validate(record.snapshot.model_dump())
        tombstone = self._tombstones.get(session_id)
        if tombstone is not None:
            return SessionSnapshot.model_validate(tombstone.snapshot.model_dump())
        raise self._not_found()

    async def stream_events(
        self, session_id: UUID, last_event_id: int | None
    ) -> AsyncIterator[str]:
        record = self._active
        if record is not None and record.session_id == session_id:
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
        record = self._active
        if record is None or record.session_id != session_id:
            if session_id in self._tombstones:
                raise HarnessServiceError(
                    409, "command_conflict", "The session is terminal"
                )
            raise self._not_found()

        expired = False
        credential_gate: HumanGate | None = None
        credential_command: SignInCommand | SaveCredentialsCommand | None = None
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
            if asyncio.get_running_loop().time() >= record.deadline_monotonic:
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
                if isinstance(command, ContinueCommand):
                    await gate.continue_navigation()
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
        record = self._active
        if record is None or record.session_id != session_id:
            if session_id in self._tombstones:
                raise HarnessServiceError(
                    409, "command_conflict", "The session is terminal"
                )
            raise self._not_found()

        owns_pending = False
        current_task = asyncio.current_task()
        submission_attempt_active = False
        try:
            async with record.request_lock:
                if record.finalized or record.final_request is not None:
                    raise HarnessServiceError(
                        409, "command_conflict", "The session is terminal"
                    )
                if record.snapshot.state in {"submitted", "submission_uncertain"}:
                    raise HarnessServiceError(
                        409,
                        "command_conflict",
                        "Only closing the browser is allowed after a submission outcome",
                    )
                if (
                    asyncio.get_running_loop().time()
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
                        RequestHumanNavigationRuntimeAction,
                    ),
                ):
                    raise HarnessServiceError(
                        409,
                        "command_conflict",
                        "Only browser execution and human navigation may run "
                        "after submission approval",
                    )
                if record.runtime_action_pending:
                    raise HarnessServiceError(
                        409,
                        "command_conflict",
                        "A runtime action is already pending",
                    )
                record.runtime_action_pending = True
                record.runtime_action_task = current_task
                owns_pending = True
                starts_submission = isinstance(
                    action,
                    RequestHumanNavigationRuntimeAction,
                ) or (
                    isinstance(action, PlaywrightCliRuntimeAction)
                    and action.command not in _READ_ONLY_PLAYWRIGHT_CLI_COMMANDS
                )
                if (
                    gate.submission_approved
                    and starts_submission
                    and not record.submission_action_started
                ):
                    record.submission_action_started = True
                    await self._set_state_and_event(
                        record,
                        "submitting",
                        "submission_started",
                        {},
                    )
                submission_attempt_active = record.submission_action_started

            async with record.runtime_lock:
                response = await self._dispatch_runtime_action(record, action)
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
                    and (response.exit_code != 0 or response.timed_out)
                ):
                    await self._park_submission_uncertain(record)
                return response
        except asyncio.CancelledError:
            if submission_attempt_active:
                await self._park_submission_uncertain(record)
            raise
        except Exception:
            if submission_attempt_active:
                await self._park_submission_uncertain(record)
            raise
        finally:
            if owns_pending:
                async with record.request_lock:
                    if record.runtime_action_task is current_task:
                        record.runtime_action_task = None
                        record.runtime_action_pending = False

    async def _dispatch_runtime_action(
        self,
        record: _ApplicationSession,
        action: RuntimeActionRequest,
    ) -> RuntimeActionResponse:
        runtime = record.playwright_runtime
        gate = record.human_gate
        request = record.request
        if runtime is None or gate is None or request is None:
            raise HarnessServiceError(
                409, "command_conflict", "The session is still starting"
            )

        if isinstance(action, PlaywrightCliRuntimeAction):
            async with record.request_lock:
                if record.playwright_cli_action_count >= request.max_steps:
                    error = session_error("step_limit")
                    raise HarnessServiceError(
                        409,
                        error.code,
                        error.message,
                    )
                record.playwright_cli_action_count += 1
                step = record.playwright_cli_action_count
            try:
                result = await runtime.execute(action.command, action.args)
            except PlaywrightCliRuntimeError as error:
                async with record.request_lock:
                    self._append_playwright_cli_diagnostic(
                        record,
                        step,
                        error,
                    )
                public = session_error(error.code)
                raise HarnessServiceError(
                    504 if error.code == "session_timeout" else 502,
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
                    await self._agent_step(
                        record,
                        step,
                        result.observation.url,
                        state=(
                            "submitting" if gate.submission_approved else "running"
                        ),
                    )
                if result.exit_code == 0 and not result.timed_out:
                    record.last_successful_inspection_step = step
                private_values = gate.redaction_values
                public_tabs = [
                    tab.model_copy(
                        update={
                            "url": _redact_playwright_cli_url(
                                tab.url,
                                private_values,
                            ),
                            "title": (
                                redact_public_text(tab.title, private_values)
                                or ""
                            ),
                        }
                    )
                    for tab in result.observation.tabs
                ]
                if gate.submission_approved:
                    public_tabs = []
                public_result = result.model_copy(
                    update={
                        "stdout": redact_public_text(
                            result.stdout,
                            private_values,
                        )
                        or "",
                        "stderr": redact_public_text(
                            result.stderr,
                            private_values,
                        )
                        or "",
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
                                    )
                                    or ""
                                ),
                                "tabs": public_tabs,
                                "dom": (
                                    redact_public_text(
                                        result.observation.dom,
                                        private_values,
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
            return ContinueRuntimeActionResponse(type="continue")

        if isinstance(action, RequestSignInRuntimeAction):
            async with record.request_lock:
                if record.playwright_cli_action_count >= request.max_steps:
                    error = session_error("step_limit")
                    raise HarnessServiceError(
                        409,
                        error.code,
                        error.message,
                    )
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
                username_ref=action.username_ref,
                password_ref=action.password_ref,
                submit_ref=action.submit_ref,
                runtime=runtime,
                credential_store=self._credential_store_for_use(),
            )
            terminal = self._runtime_gate_terminal_response(gate_result)
            if terminal is not None:
                return terminal
            status = (
                gate_result.metadata.get("sign_in_status")
                if gate_result.metadata is not None
                else None
            )
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
            try:
                return AdditionalInfoRuntimeActionResponse.model_validate_json(
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
        record = self._active
        if record is not None and record.session_id == session_id:
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
            record = self._active
        if record is not None:
            await self._request_terminal(
                record,
                _TerminalRequest("closed", "closed"),
                wait=True,
                duplicate_ok=True,
            )
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
            if asyncio.get_running_loop().time() >= record.deadline_monotonic:
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
                result = await model.run(
                    runtime_url=f"http://127.0.0.1:{self._config.port}",
                    auto_submit=request.auto_submit,
                    task=record.application_task,
                    max_turns=request.max_steps,
                    deadline_ms=min(remaining_ms, 86_400_000),
                )
            else:
                result = await self._application_runner(
                    ApplicationRunRequest(
                        session=request,
                        candidate=candidate,
                        resume_display_name=record.stored.resume.display_name,
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
                if asyncio.get_running_loop().time() >= record.deadline_monotonic:
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
            if asyncio.get_running_loop().time() >= record.deadline_monotonic:
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
        delay = max(
            0.0,
            record.deadline_monotonic - asyncio.get_running_loop().time(),
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
                    record.runtime_action_pending = False

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
                if self._active is record:
                    self._active = None
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
            session_timed_out = outcome.code == "session_timeout"
            diagnostic = PlaywrightCliDiagnostic(
                step=step,
                status="timed_out" if session_timed_out else "failed",
                exit_code=-1,
                timed_out=session_timed_out,
                error_category=(
                    "session_timeout" if session_timed_out else "browser_runtime"
                ),
                stderr_excerpt=(
                    _SESSION_TIMEOUT_DIAGNOSTIC_MESSAGE
                    if session_timed_out
                    else _BROWSER_RUNTIME_ERROR_MESSAGE
                ),
                stderr_truncated=False,
            )
        else:
            if outcome.timed_out:
                status = "timed_out"
                error_category = "execution_timeout"
                stderr_excerpt = _PLAYWRIGHT_CLI_TIMEOUT_MESSAGE
            elif outcome.exit_code != 0:
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
                timed_out=outcome.timed_out,
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
