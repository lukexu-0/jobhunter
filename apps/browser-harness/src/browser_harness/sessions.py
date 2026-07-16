from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit
from uuid import UUID, uuid4

from browser_use.browser import BrowserSession
from fastapi import UploadFile
from pydantic import ValidationError

from .agent import ApplicationAgentFailure, ApplicationRunRequest, run_application
from .artifacts import (
    StoredCandidateArtifacts,
    cleanup_session_artifacts,
    retry_pending_cleanup,
    store_uploads,
)
from .browser import (
    BrowserConfigurationError,
    ResolvedBrowserLaunch,
    create_browser,
    resolve_browser_launch,
    resolve_resume_upload_path,
)
from .context import CandidateContext, CandidateContextProcess, build_sensitive_data
from .models import (
    AgentStepDetail,
    ApplicationRunResult,
    ApproveOriginCommand,
    CancelCommand,
    ContinueCommand,
    EmptyEventDetail,
    HarnessConfig,
    HarnessEvent,
    HarnessServiceError,
    HumanNavigationDetail,
    OriginApprovalDetail,
    ReadyCommand,
    ReviseCommand,
    RevisionAppliedDetail,
    SessionCommand,
    SessionCreateRequest,
    SessionCreateResponse,
    SessionSnapshot,
    SessionState,
    UploadedArtifacts,
    session_error,
    validate_approved_origin,
    validate_job_url,
)
from .pipeline_model import PipelineModelError, PipelineOAuthChatModel
from .tools import HumanGate, redact_public_text, sanitize_application_result


logger = logging.getLogger(__name__)
_EVENT_LIMIT = 256
_TOMBSTONE_LIMIT = 32
_HEARTBEAT_SECONDS = 15.0
_CLEANUP_RETRY_MAX_SECONDS = 5.0

ModelFactory = Callable[[UUID, str, str], PipelineOAuthChatModel]
BrowserFactory = Callable[
    [ResolvedBrowserLaunch, tuple[str, ...] | list[str], Path], BrowserSession
]
ApplicationRunner = Callable[
    [
        ApplicationRunRequest,
        PipelineOAuthChatModel,
        BrowserSession,
        HumanGate,
        Callable[[int, str], Awaitable[None]],
    ],
    Awaitable[ApplicationRunResult],
]
ContextProcessFactory = Callable[[StoredCandidateArtifacts], CandidateContextProcess]


@dataclass(frozen=True, slots=True)
class _TerminalRequest:
    state: str
    event: str
    error_code: str | None = None


@dataclass(slots=True)
class _ApplicationSession:
    session_id: UUID
    snapshot: SessionSnapshot
    created_monotonic: float
    events: deque[HarnessEvent] = field(
        default_factory=lambda: deque(maxlen=_EVENT_LIMIT)
    )
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    closed_event: asyncio.Event = field(default_factory=asyncio.Event)
    request_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    setup_task: asyncio.Task[Any] | None = None
    context_process: CandidateContextProcess | None = None
    resume_path_task: asyncio.Task[str] | None = None
    resume_upload_path: str | None = None
    request: SessionCreateRequest | None = None
    stored: StoredCandidateArtifacts | None = None
    candidate: CandidateContext | None = None
    model: PipelineOAuthChatModel | None = None
    browser: BrowserSession | None = None
    human_gate: HumanGate | None = None
    agent_task: asyncio.Task[None] | None = None
    ttl_task: asyncio.Task[None] | None = None
    finalizer_task: asyncio.Task[None] | None = None
    browser_kill_task: asyncio.Task[None] | None = None
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


def _redact_known_values(value: str, candidate: CandidateContext | None) -> str:
    if candidate is None:
        return value
    parsed = urlsplit(value)
    redacted_path = redact_public_text(parsed.path, candidate.direct_fields) or ""
    safe_path = quote(redacted_path, safe="/:@-._~!$&'()*+,;=[]")
    return urlunsplit(
        (parsed.scheme, parsed.netloc, safe_path, parsed.query, parsed.fragment)
    )


class ApplicationSessionManager:
    """Own exactly one application session and a bounded terminal history."""

    def __init__(
        self,
        config: HarnessConfig,
        *,
        artifacts_root: Path | None = None,
        browser_launch: ResolvedBrowserLaunch | None = None,
        model_factory: ModelFactory = PipelineOAuthChatModel,
        context_process_factory: ContextProcessFactory = CandidateContextProcess,
        browser_factory: BrowserFactory = create_browser,
        application_runner: ApplicationRunner = run_application,
    ) -> None:
        self._config = config
        self._artifacts_root = (
            artifacts_root or Path("~/.jobhunter/browser-harness/sessions")
        ).expanduser()
        self._browser_launch = browser_launch or resolve_browser_launch(config.browser)
        self._model_factory = model_factory
        self._context_process_factory = context_process_factory
        self._browser_factory = browser_factory
        self._application_runner = application_runner
        self._lock = asyncio.Lock()
        self._active: _ApplicationSession | None = None
        self._tombstones: OrderedDict[UUID, _Tombstone] = OrderedDict()
        self._shutting_down = False

    async def create_session(
        self,
        *,
        job_url: str,
        allow_domains: Sequence[str],
        max_steps: int,
        personal_information: UploadFile,
        resume: UploadFile,
        context: Sequence[UploadFile],
        anecdotes: Sequence[UploadFile],
    ) -> SessionCreateResponse:
        try:
            validated_job_url = validate_job_url(job_url)
            origins = [_job_origin(validated_job_url)]
            origins.extend(validate_approved_origin(value) for value in allow_domains)
            if len(origins) > 20 or len(set(origins)) != len(origins):
                raise ValueError("approved origins are invalid")
            if not 1 <= max_steps <= 500:
                raise ValueError("max_steps is invalid")
        except (TypeError, ValueError):
            raise HarnessServiceError(
                422, "invalid_request", "Request is invalid"
            ) from None

        session_id = uuid4()
        created_at = _now()
        record = _ApplicationSession(
            session_id=session_id,
            snapshot=SessionSnapshot(
                session_id=session_id,
                state="starting",
                created_at=created_at,
                updated_at=created_at,
                job_url=f"{origins[0]}/",
                approved_origins=list(origins),
            ),
            created_monotonic=asyncio.get_running_loop().time(),
            setup_task=asyncio.current_task(),
        )

        async with self._lock:
            if self._shutting_down:
                raise HarnessServiceError(
                    503, "service_unavailable", "The browser harness is shutting down"
                )
            if self._active is not None:
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
            record.snapshot = self._updated_snapshot(
                record.snapshot,
                job_url=_redact_known_values(validated_job_url, candidate),
            )

            model = self._model_factory(
                session_id,
                self._config.pipeline_url,
                self._config.bearer_token,
            )
            record.model = model
            await model.check_ready()

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
                max_steps=max_steps,
                artifacts=uploaded,
                direct_fields=tuple(candidate.direct_fields.items()),
            )
            record.request = request

            browser = self._browser_factory(
                self._browser_launch,
                origins,
                stored.session_directory / "downloads",
            )
            record.browser = browser
            record.resume_path_task = asyncio.create_task(
                asyncio.to_thread(
                    resolve_resume_upload_path,
                    request.artifacts.resume,
                    self._browser_launch,
                ),
                name=f"browser-harness-resume-path-{session_id}",
            )
            record.resume_upload_path = await asyncio.shield(
                record.resume_path_task
            )
            record.resume_path_task = None
            sensitive_data = build_sensitive_data(candidate, origins)

            async def publish_gate(
                state: SessionState,
                event: str | None,
                detail: dict[str, object] | Any,
            ) -> None:
                await self._publish_gate(record, state, event, detail)

            async def review_snapshot(result: ApplicationRunResult) -> None:
                self._apply_result(record, result)

            record.human_gate = HumanGate(
                job_url=validated_job_url,
                candidate=candidate,
                approved_origins=origins,
                sensitive_data=sensitive_data,
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
        except PipelineModelError as error:
            record.setup_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", error.code),
                duplicate_ok=True,
            )
            await self._join_finalizer(record)
            status_code = {
                "oauth_required": 409,
                "pipeline_unavailable": 503,
                "model_timeout": 504,
                "invalid_model_output": 502,
                "model_failed": 502,
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
        except (BrowserConfigurationError, OSError, ValidationError):
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

        if isinstance(command, CancelCommand):
            await self._request_terminal(
                record,
                _TerminalRequest("cancelled", "cancelled"),
                wait=False,
                duplicate_ok=False,
            )
            return

        async with record.request_lock:
            if record.finalized or record.final_request is not None:
                raise HarnessServiceError(
                    409, "command_conflict", "A terminal command is already pending"
                )
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
            elif isinstance(command, ReadyCommand):
                await gate.ready()
            else:
                raise HarnessServiceError(
                    422, "invalid_request", "Command is invalid"
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
        browser = record.browser
        gate = record.human_gate
        if (
            request is None
            or candidate is None
            or model is None
            or browser is None
            or gate is None
            or record.stored is None
            or record.resume_upload_path is None
        ):
            record.agent_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", "browser_failed"),
                duplicate_ok=True,
            )
            return

        await self._set_state_and_event(record, "running", "session_started", {})
        try:
            result = await self._application_runner(
                ApplicationRunRequest(
                    session=request,
                    candidate=candidate,
                    resume_display_name=record.stored.resume.display_name,
                    resume_upload_path=record.resume_upload_path,
                ),
                model,
                browser,
                gate,
                lambda step, url: self._agent_step(record, step, url),
            )
            if record.final_request is not None:
                return
            if result.status == "cancelled":
                record.agent_task = None
                await self._begin_finalization(
                    record,
                    _TerminalRequest("cancelled", "cancelled"),
                    duplicate_ok=True,
                )
                return
            sanitized = sanitize_application_result(
                result,
                candidate.direct_fields,
                gate.revision_count,
            )
            self._apply_result(record, sanitized)
            await self._set_state_and_event(
                record,
                "ready_for_human_submit",
                "ready_for_human_submit",
                {},
            )
        except asyncio.CancelledError:
            if record.final_request is None:
                record.agent_task = None
                await self._begin_finalization(
                    record,
                    _TerminalRequest("cancelled", "cancelled"),
                    duplicate_ok=True,
                )
        except PipelineModelError as error:
            record.agent_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", error.code),
                duplicate_ok=True,
            )
        except ApplicationAgentFailure as error:
            record.agent_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", error.code),
                duplicate_ok=True,
            )
        except Exception:
            record.agent_task = None
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", "browser_failed"),
                duplicate_ok=True,
            )

    async def _expire_session(self, record: _ApplicationSession) -> None:
        deadline = record.created_monotonic + self._config.session_timeout
        delay = max(0.0, deadline - asyncio.get_running_loop().time())
        try:
            await asyncio.sleep(delay)
            await self._request_terminal(
                record,
                _TerminalRequest("failed", "failed", "session_timeout"),
                wait=False,
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
        await self._begin_finalization(record, request, duplicate_ok=duplicate_ok)
        if wait:
            await self._join_finalizer(record)

    async def _begin_finalization(
        self,
        record: _ApplicationSession,
        request: _TerminalRequest,
        *,
        duplicate_ok: bool,
    ) -> None:
        async with record.request_lock:
            if record.finalized:
                if not duplicate_ok:
                    raise HarnessServiceError(
                        409, "command_conflict", "The session is terminal"
                    )
                return
            if record.final_request is None:
                record.final_request = request
            elif request.state == "closed":
                record.final_request = request
            elif not duplicate_ok:
                raise HarnessServiceError(
                    409, "command_conflict", "A terminal command is already pending"
                )
            if record.finalizer_task is None:
                record.finalizer_task = asyncio.create_task(
                    self._finalize_record(record),
                    name=f"browser-harness-finalizer-{record.session_id}",
                )

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

        resume_path_task = record.resume_path_task
        if resume_path_task is not None:
            try:
                await asyncio.shield(resume_path_task)
            except Exception:
                pass
            record.resume_path_task = None

        agent_task = record.agent_task
        if agent_task is not None and agent_task is not asyncio.current_task() and not agent_task.done():
            agent_task.cancel()
            try:
                await asyncio.shield(agent_task)
            except (asyncio.CancelledError, Exception):
                pass

        while record.browser is not None:
            if record.browser_kill_task is None:
                record.browser_kill_task = asyncio.create_task(record.browser.kill())
            try:
                await self._await_owned_cleanup(
                    record.browser_kill_task,
                    "Browser",
                )
            except Exception:
                logger.warning(
                    "Browser cleanup failed; retaining ownership and retrying"
                )
                record.browser_kill_task = None
                await asyncio.sleep(retry_delay)
                retry_delay = min(
                    retry_delay * 2, _CLEANUP_RETRY_MAX_SECONDS
                )
            else:
                record.browser = None

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
            await self._set_state_and_event(
                record,
                terminal.state,
                terminal.event,
                {},
                error=error,
            )
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
        approved = (
            list(record.human_gate.approved_origins)
            if record.human_gate is not None
            else record.snapshot.approved_origins
        )
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            state=state,
            approved_origins=approved,
            revision_count=(
                record.human_gate.revision_count
                if record.human_gate is not None
                else record.snapshot.revision_count
            ),
            error=None,
        )
        if event is not None:
            await self._publish_event(record, event, detail)

    async def _agent_step(
        self, record: _ApplicationSession, step_number: int, current_url: str
    ) -> None:
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            state="running",
            error=None,
        )
        await self._publish_event(
            record,
            "agent_step",
            {
                "step_number": step_number,
                "current_url": _redact_known_values(current_url, record.candidate),
            },
        )

    def _apply_result(
        self, record: _ApplicationSession, result: ApplicationRunResult
    ) -> None:
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            company=result.company,
            role=result.role,
            job_url=_redact_known_values(result.job_url, record.candidate),
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
        values["updated_at"] = _now()
        return SessionSnapshot.model_validate(values)

    def _not_found(self) -> HarnessServiceError:
        return HarnessServiceError(
            404, "session_not_found", "Session was not found"
        )


__all__ = ["ApplicationSessionManager"]
