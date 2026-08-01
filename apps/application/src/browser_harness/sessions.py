from __future__ import annotations

import asyncio
import json
import logging
import os
import stat
import subprocess
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from browser_use.browser import BrowserSession
from fastapi import UploadFile
from pydantic import ValidationError

from .agent import ApplicationRunRequest, build_application_task
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
from .context import CandidateContext, CandidateContextProcess
from .models import (
    AdditionalInfoRequiredDetail,
    AdditionalInfoRuntimeActionResponse,
    AdditionalInfoSavedDetail,
    AgentStepDetail,
    BrowserUseDiagnostic,
    BrowserUseExecutionResult,
    ApplicationRunResult,
    CancelledApplicationResult,
    ReviewApplicationResult,
    SubmittedApplicationResult,
    SubmissionUncertainApplicationResult,
    ApplicationMismatchRuntimeActionResponse,
    ApproveRuntimeActionResponse,
    ApproveOriginCommand,
    CancelCommand,
    BrowserUseResultRuntimeActionResponse,
    BrowserUseRuntimeAction,
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
    RequestHumanNavigationRuntimeAction,
    RequestHumanReviewRuntimeAction,
    SubmitApplicationRuntimeAction,
    SubmitApplicationResultRuntimeActionResponse,
    RequestOriginApprovalRuntimeAction,
    ReviseRuntimeActionResponse,
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
from .skill_runtime import (
    BrowserSkillRuntime,
    BrowserSkillRuntimeError,
)
from .tools import (
    HumanGate,
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
_BROWSER_USE_DIAGNOSTIC_LIMIT = 100
_BROWSER_USE_TIMEOUT_MESSAGE = (
    "Browser Use execution timed out after 120 seconds."
)
_BROWSER_RUNTIME_ERROR_MESSAGE = "Browser runtime failed."
_SESSION_TIMEOUT_DIAGNOSTIC_MESSAGE = "Application session expired."
_REDACTED_STDERR_EXCERPT = "[redacted]"

def _submit_application_source(selector: str) -> str:
    selector_json = json.dumps(selector, ensure_ascii=False)
    javascript = f"""(() => {{
  const selector = {selector_json};
  const activatableSelector = [
    "button",
    "input[type='submit']",
    "input[type='button']",
    "input[type='image']",
    "a[href]",
    "[role='button']",
  ].join(", ");
  const normalizedLabel = (value) => (value || "").replace(/\\s+/g, " ").trim();
  const finalActionPattern = /\\b(?:apply|send|submit)\\b/i;
  const unsafeActionPattern = /\\b(?:back|cancel|close|delete|discard|draft|remove|save|withdraw)\\b/i;
  const labelledByText = (element) => normalizedLabel(
    (element.getAttribute("aria-labelledby") || "")
      .split(/\\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ")
  );
  const controlLabels = (element) => {{
    const inputLabel = element instanceof HTMLInputElement
      ? element.value || element.getAttribute("alt") || ""
      : "";
    const visibleLabel = normalizedLabel(inputLabel || element.innerText || "");
    const accessibleLabel = labelledByText(element)
      || normalizedLabel(element.getAttribute("aria-label"))
      || visibleLabel
      || normalizedLabel(element.getAttribute("title"))
      || (
        element instanceof HTMLInputElement
        && element.type.toLowerCase() === "submit"
        ? "submit"
        : ""
      );
    return {{accessibleLabel, visibleLabel}};
  }};
  const isFinalSubmissionControl = (element) => {{
    const {{accessibleLabel, visibleLabel}} = controlLabels(element);
    return finalActionPattern.test(accessibleLabel)
      && !unsafeActionPattern.test(accessibleLabel)
      && (
        !visibleLabel
        || (
          finalActionPattern.test(visibleLabel)
          && !unsafeActionPattern.test(visibleLabel)
        )
      );
  }};
  const pointFor = (element) => {{
    if (
      !element.isConnected
      || !element.matches(activatableSelector)
      || element.closest("[inert]")
      || element.matches(":disabled")
    ) return null;
    if (!isFinalSubmissionControl(element)) return null;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {{
      if (
        (ancestor.getAttribute("aria-disabled") || "").trim().toLowerCase()
        === "true"
      ) return null;
    }}
    const style = getComputedStyle(element);
    if (
      style.display === "none"
      || style.visibility === "hidden"
      || style.opacity === "0"
      || style.pointerEvents === "none"
    ) return null;
    if (
      typeof element.checkVisibility === "function"
      && !element.checkVisibility({{checkOpacity: true, checkVisibilityCSS: true}})
    ) return null;
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    const x = left + (right - left) / 2;
    const y = top + (bottom - top) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit.closest(activatableSelector) !== element) return null;
    return {{x, y}};
  }};
  const points = Array.from(document.querySelectorAll(selector))
    .map(pointFor)
    .filter((point) => point !== null);
  return points.length === 1 ? points[0] : null;
}})()"""
    return (
        f"_submission_point = js({javascript!r})\n"
        "if not isinstance(_submission_point, dict):\n"
        "    raise RuntimeError('Final submission control is not uniquely actionable')\n"
        "_submission_x = _submission_point.get('x')\n"
        "_submission_y = _submission_point.get('y')\n"
        "if (\n"
        "    type(_submission_x) not in (int, float)\n"
        "    or type(_submission_y) not in (int, float)\n"
        "    or not (-float('inf') < float(_submission_x) < float('inf'))\n"
        "    or not (-float('inf') < float(_submission_y) < float('inf'))\n"
        "):\n"
        "    raise RuntimeError('Final submission control position is invalid')\n"
        "click_at_xy(float(_submission_x), float(_submission_y))\n"
        "wait(0.5)\n"
        "wait_for_load(timeout=15.0)\n"
        "wait_for_network_idle(timeout=10.0, idle_ms=500)\n"
        "page_info()"
    )


ModelFactory = Callable[[UUID, str, str], PipelineApplicationAgentClient]
BrowserFactory = Callable[
    [ResolvedBrowserLaunch, tuple[str, ...] | list[str], Path], BrowserSession
]
ApplicationRunner = Callable[
    [
        ApplicationRunRequest,
        Any,
        BrowserSession,
        HumanGate,
        Callable[[int, str], Awaitable[None]],
    ],
    Awaitable[ApplicationRunResult],
]
ContextProcessFactory = Callable[[StoredCandidateArtifacts], CandidateContextProcess]
SkillRuntimeFactory = Callable[..., BrowserSkillRuntime]


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
    browser_action_count: int = 0
    additional_info_question_count: int = 0
    submission_action_started: bool = False
    setup_task: asyncio.Task[Any] | None = None
    context_process: CandidateContextProcess | None = None
    resume_path_task: asyncio.Task[str] | None = None
    resume_upload_path: str | None = None
    request: SessionCreateRequest | None = None
    user_info: UserInfoSnapshot | None = None
    application_task: str | None = None
    stored: StoredCandidateArtifacts | None = None
    candidate: CandidateContext | None = None
    model: PipelineApplicationAgentClient | None = None
    browser: BrowserSession | None = None
    human_gate: HumanGate | None = None
    skill_runtime: BrowserSkillRuntime | None = None
    agent_task: asyncio.Task[None] | None = None
    ttl_task: asyncio.Task[None] | None = None
    finalizer_task: asyncio.Task[None] | None = None
    browser_kill_task: asyncio.Task[None] | None = None
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
    detail: dict[str, object] | Any,
) -> dict[str, object] | None:
    if state == "awaiting_human_navigation":
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



def _require_private_directory(path: Path, *, description: str) -> Path:
    try:
        details = path.lstat()
    except OSError:
        raise BrowserConfigurationError(f"The {description} is unavailable") from None
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or details.st_uid != os.getuid()
        or stat.S_IMODE(details.st_mode) != 0o700
    ):
        raise BrowserConfigurationError(f"The {description} must be a private directory")
    return path.resolve(strict=True)


def _prepare_skill_workspace(configured: Path) -> Path:
    workspace = configured.expanduser().absolute()
    parent = workspace.parent
    try:
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        workspace.mkdir(mode=0o700, exist_ok=True)
    except OSError:
        raise BrowserConfigurationError(
            "The Browser Use skill workspace is unavailable"
        ) from None

    _require_private_directory(parent, description="Browser Use skill workspace parent")
    resolved = _require_private_directory(
        workspace, description="Browser Use skill workspace"
    )
    try:
        entries = tuple(resolved.iterdir())
        for entry in entries:
            details = entry.lstat()
            if details.st_uid != os.getuid() or stat.S_ISLNK(details.st_mode):
                raise BrowserConfigurationError(
                    "The Browser Use skill workspace contains an unsafe entry"
                )
            if entry.name == "agent_helpers.py" and stat.S_ISREG(details.st_mode):
                continue
            if entry.name == "domain-skills" and stat.S_ISDIR(details.st_mode):
                continue
            raise BrowserConfigurationError(
                "The Browser Use skill workspace contains an unexpected entry"
            )
    except BrowserConfigurationError:
        raise
    except OSError:
        raise BrowserConfigurationError(
            "The Browser Use skill workspace is unavailable"
        ) from None
    return resolved


def _probe_bubblewrap(executable: Path) -> None:
    command = (
        str(executable),
        "--die-with-parent",
        "--new-session",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup",
        "--share-net",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--",
        "/usr/bin/true",
    )
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        raise BrowserConfigurationError(
            "Bubblewrap namespace isolation is unavailable"
        ) from None
    if completed.returncode != 0:
        raise BrowserConfigurationError(
            "Bubblewrap namespace isolation is unavailable"
        )



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
        browser_factory: BrowserFactory = create_browser,
        application_runner: ApplicationRunner | None = None,
        skill_runtime_factory: SkillRuntimeFactory = BrowserSkillRuntime,
        user_info_store: UserInfoStore | None = None,
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
        self._skill_runtime_factory = skill_runtime_factory
        self._user_info_store = user_info_store or UserInfoStore(config.user_info_json)
        self._browser_skill_workspace = _prepare_skill_workspace(
            config.browser_skill_workspace
        )
        _probe_bubblewrap(config.bubblewrap_executable)
        self._lock = asyncio.Lock()
        self._active: _ApplicationSession | None = None
        self._tombstones: OrderedDict[UUID, _Tombstone] = OrderedDict()
        self._shutting_down = False

    async def create_session(
        self,
        *,
        session_id: UUID | None = None,
        job_url: str,
        allow_domains: Sequence[str],
        auto_apply: bool = False,
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
            if type(auto_apply) is not bool:
                raise ValueError("auto_apply is invalid")
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
                auto_apply=auto_apply,
                max_steps=max_steps,
                artifacts=uploaded,
                direct_fields=tuple(candidate.direct_fields.items()),
            )
            record.request = request
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

            browser = self._browser_factory(
                self._browser_launch,
                origins,
                stored.session_directory / "downloads",
            )
            record.browser = browser
            runtime = self._skill_runtime_factory(
                browser=browser,
                session_directory=stored.session_directory,
                workspace=self._browser_skill_workspace,
                bubblewrap_executable=self._config.bubblewrap_executable,
                deadline=record.deadline_monotonic,
            )
            record.skill_runtime = runtime
            await runtime.start()

            async def publish_gate(
                state: SessionState,
                event: str | None,
                detail: dict[str, object] | Any,
            ) -> None:
                await self._publish_gate(record, state, event, detail)

            async def review_snapshot(result: ReviewApplicationResult) -> None:
                self._apply_result(record, result)

            record.human_gate = HumanGate(
                auto_apply=request.auto_apply,
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
        except (
            BrowserConfigurationError,
            BrowserSkillRuntimeError,
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

        if record.snapshot.state in {"submitted", "submission_uncertain"}:
            raise HarnessServiceError(
                409,
                "command_conflict",
                "Only closing the browser is allowed after a submission outcome",
            )
        if isinstance(command, CancelCommand):
            if record.submission_action_started:
                await self._park_submission_uncertain(record)
                return
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
            elif isinstance(command, SubmitCommand):
                await gate.submit()
            elif isinstance(command, ProvideAdditionalInfoCommand):
                await gate.provide_additional_info(command.answers)
            else:
                raise HarnessServiceError(
                    422, "invalid_request", "Command is invalid"
                )
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
        submission_action_accepted = False
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
                    record.snapshot.state == "starting"
                    or record.skill_runtime is None
                    or record.human_gate is None
                    or record.browser is None
                    or record.request is None
                ):
                    raise HarnessServiceError(
                        409, "command_conflict", "The session is still starting"
                    )
                gate = record.human_gate
                if gate.submission_approved:
                    if not isinstance(action, SubmitApplicationRuntimeAction):
                        raise HarnessServiceError(
                            409,
                            "command_conflict",
                            "Only the approved submission action may run",
                        )
                    if record.submission_action_started:
                        raise HarnessServiceError(
                            409,
                            "command_conflict",
                            "The submission action was already started",
                        )
                elif isinstance(action, SubmitApplicationRuntimeAction):
                    raise HarnessServiceError(
                        409,
                        "command_conflict",
                        "Final submission has not been approved",
                    )
                if record.runtime_action_pending:
                    raise HarnessServiceError(
                        409,
                        "command_conflict",
                        "A runtime action is already pending",
                    )
                record.runtime_action_pending = True
                owns_pending = True
                if isinstance(action, SubmitApplicationRuntimeAction):
                    record.submission_action_started = True
                    submission_action_accepted = True
                    await self._set_state_and_event(
                        record,
                        "submitting",
                        "submission_started",
                        {},
                    )

            async with record.runtime_lock:
                return await self._dispatch_runtime_action(record, action)
        except asyncio.CancelledError:
            if submission_action_accepted:
                await self._park_submission_uncertain(record)
            raise
        except Exception:
            if submission_action_accepted:
                await self._park_submission_uncertain(record)
            raise
        finally:
            if owns_pending:
                async with record.request_lock:
                    record.runtime_action_pending = False

    async def _dispatch_runtime_action(
        self,
        record: _ApplicationSession,
        action: RuntimeActionRequest,
    ) -> RuntimeActionResponse:
        runtime = record.skill_runtime
        gate = record.human_gate
        browser = record.browser
        request = record.request
        if runtime is None or gate is None or browser is None or request is None:
            raise HarnessServiceError(
                409, "command_conflict", "The session is still starting"
            )

        if isinstance(action, BrowserUseRuntimeAction):
            if record.browser_action_count >= request.max_steps:
                error = session_error("step_limit")
                raise HarnessServiceError(
                    409,
                    error.code,
                    error.message,
                )
            try:
                result = await runtime.execute(action.code)
            except BrowserSkillRuntimeError as error:
                async with record.request_lock:
                    self._append_browser_use_diagnostic(
                        record,
                        record.browser_action_count + 1,
                        error,
                    )
                public = session_error(error.code)
                raise HarnessServiceError(
                    504 if error.code == "session_timeout" else 502,
                    public.code,
                    public.message,
                ) from None
            async with record.request_lock:
                if record.finalized or record.final_request is not None:
                    raise asyncio.CancelledError
                record.browser_action_count += 1
                self._append_browser_use_diagnostic(
                    record,
                    record.browser_action_count,
                    result,
                )
                await self._agent_step(
                    record,
                    record.browser_action_count,
                    result.observation.url,
                )
                return BrowserUseResultRuntimeActionResponse(
                    type="browser_use_result",
                    **result.model_dump(),
                )

        if isinstance(action, SubmitApplicationRuntimeAction):
            source = _submit_application_source(action.selector)
            try:
                pre_click = await runtime.execute("page_info()")
                result = await runtime.execute(source)
            except BrowserSkillRuntimeError as error:
                public = session_error(error.code)
                raise HarnessServiceError(
                    504 if error.code == "session_timeout" else 502,
                    public.code,
                    public.message,
                ) from None
            public_result = result.model_copy(
                update={
                    "observation": result.observation.model_copy(
                        update={
                            "url": redact_public_url(
                                result.observation.url,
                                gate.redaction_values,
                            ),
                            "tabs": [],
                            "page_info": None,
                        }
                    )
                }
            )
            return SubmitApplicationResultRuntimeActionResponse(
                type="submit_application_result",
                pre_click_dom=pre_click.observation.dom,
                **public_result.model_dump(),
            )

        if isinstance(action, RequestHumanNavigationRuntimeAction):
            before = gate.approved_origins
            gate_result = await gate.request_human_navigation(
                action.instruction,
                browser,
            )
            terminal = self._runtime_gate_terminal_response(gate_result)
            if terminal is not None:
                return terminal
            approved = gate.approved_origins
            if approved != before:
                return ApproveRuntimeActionResponse(
                    type="approve",
                    origin=approved[-1],
                    approved_origins=list(approved),
                )
            return ContinueRuntimeActionResponse(type="continue")

        if isinstance(action, RequestOriginApprovalRuntimeAction):
            gate_result = await gate.request_origin_approval(
                action.origin,
                browser,
            )
            terminal = self._runtime_gate_terminal_response(gate_result)
            if terminal is not None:
                return terminal
            return ApproveRuntimeActionResponse(
                type="approve",
                origin=action.origin,
                approved_origins=list(gate.approved_origins),
            )

        if isinstance(action, RequestAdditionalInfoRuntimeAction):
            if record.browser_action_count < 1:
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
                browser,
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
                browser,
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

        await self._set_state_and_event(record, "running", "session_started", {})
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
                    auto_apply=request.auto_apply,
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
                    browser,
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
            if record.final_request is not None:
                return
            if isinstance(result, CancelledApplicationResult):
                record.agent_task = None
                if record.submission_action_started:
                    await self._park_submission_uncertain(record)
                else:
                    await self._begin_finalization(
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
            if record.final_request is None:
                record.agent_task = None
                if record.submission_action_started:
                    await self._park_submission_uncertain(record)
                else:
                    await self._begin_finalization(
                        record,
                        _TerminalRequest("cancelled", "cancelled"),
                        duplicate_ok=True,
                    )
        except PipelineApplicationAgentError as error:
            record.agent_task = None
            if record.submission_action_started:
                await self._park_submission_uncertain(record)
                return
            error_code = (
                "invalid_model_output"
                if error.code == "invalid_request"
                else error.code
            )
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", error_code),
                duplicate_ok=True,
            )
        except Exception:
            record.agent_task = None
            if record.submission_action_started:
                await self._park_submission_uncertain(record)
                return
            await self._begin_finalization(
                record,
                _TerminalRequest("failed", "failed", "browser_failed"),
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
            await self._request_terminal(
                record,
                terminal,
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

        while record.skill_runtime is not None:
            if record.runtime_close_task is None:
                record.runtime_close_task = asyncio.create_task(
                    record.skill_runtime.close()
                )
            try:
                await self._await_owned_cleanup(
                    record.runtime_close_task,
                    "Browser skill runtime",
                )
            except Exception:
                logger.warning(
                    "Browser-skill runtime cleanup failed; retaining ownership and retrying"
                )
                record.runtime_close_task = None
                await asyncio.sleep(retry_delay)
                retry_delay = min(
                    retry_delay * 2, _CLEANUP_RETRY_MAX_SECONDS
                )
            else:
                record.skill_runtime = None
                record.runtime_close_task = None

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
        revision_count = (
            record.human_gate.revision_count
            if record.human_gate is not None
            else record.snapshot.revision_count
        )
        pending_action = _pending_action_for_state(state, detail)
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

    def _append_browser_use_diagnostic(
        self,
        record: _ApplicationSession,
        step: int,
        outcome: BrowserUseExecutionResult | BrowserSkillRuntimeError,
    ) -> None:
        if isinstance(outcome, BrowserSkillRuntimeError):
            session_timed_out = outcome.code == "session_timeout"
            diagnostic = BrowserUseDiagnostic(
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
                stderr_excerpt = _BROWSER_USE_TIMEOUT_MESSAGE
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
            diagnostic = BrowserUseDiagnostic(
                step=step,
                status=status,
                exit_code=outcome.exit_code,
                timed_out=outcome.timed_out,
                error_category=error_category,
                stderr_excerpt=stderr_excerpt,
                stderr_truncated=outcome.stderr_truncated,
            )

        diagnostics = list(record.snapshot.browser_use_diagnostics)
        diagnostics.append(diagnostic)
        if len(diagnostics) > _BROWSER_USE_DIAGNOSTIC_LIMIT:
            del diagnostics[:-_BROWSER_USE_DIAGNOSTIC_LIMIT]
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            browser_use_diagnostics=diagnostics,
        )

    async def _agent_step(
        self, record: _ApplicationSession, step_number: int, current_url: str
    ) -> None:
        record.snapshot = self._updated_snapshot(
            record.snapshot,
            state="running",
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
