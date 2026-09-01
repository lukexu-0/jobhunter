from __future__ import annotations

import asyncio
import json
import stat
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Literal
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import UploadFile
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

import jobhunter_browser_harness.sessions as sessions_module
from jobhunter_browser_harness.application_account import (
    DEFAULT_APPLICATION_EMAIL,
    DEFAULT_APPLICATION_PASSWORD,
)
from jobhunter_browser_harness.credentials import CredentialStore
from jobhunter_browser_harness.artifacts import cleanup_session_artifacts, store_uploads
from jobhunter_browser_harness.agent import ApplicationRunRequest
from jobhunter_browser_harness.api import HarnessDependencies, create_app
from jobhunter_browser_harness.context import (
    CandidateContext,
    CandidateContextProcess,
    load_candidate_context,
)
from jobhunter_browser_harness.gmail_verification import (
    InboxEmail,
    InboxMessageSummary,
    InboxSearchResult,
)
from jobhunter_browser_harness.playwright_cli import (
    BrowserConfigurationError,
    PlaywrightCliRuntimeError,
    ResolvedBrowserLaunch,
)
from jobhunter_browser_harness.models import (
    APPLICATION_RESUME_SOURCE_MAX_BYTES,
    AdditionalInfoBooleanCommandAnswer,
    AdditionalInfoBooleanQuestion,
    AdditionalInfoOption,
    AdditionalInfoDeclinedCommandAnswer,
    AdditionalInfoRuntimeActionResponse,
    AdditionalInfoMultiSelectCommandAnswer,
    AdditionalInfoMultiSelectQuestion,
    AdditionalInfoSingleSelectCommandAnswer,
    AdditionalInfoSingleSelectQuestion,
    AdditionalInfoTextCommandAnswer,
    AdditionalInfoTextQuestion,
    ApplicationRunResult,
    CancelledApplicationResult,
    ReviewApplicationResult,
    SubmittedApplicationResult,
    SubmissionUncertainApplicationResult,
    ApplicationMismatchRuntimeActionResponse,
    ApproveOriginCommand,
    BrowserTab,
    BrowserObservation,
    PlaywrightCliExecutionResult,
    PlaywrightCliResultRuntimeActionResponse,
    PlaywrightCliRuntimeAction,
    ContinueRuntimeActionResponse,
    InterruptedRuntimeActionResponse,
    ContinueWithoutAdditionalInfoRuntimeActionResponse,
    CancelCommand,
    SaveCredentialsCommand,
    SignInCommand,
    SignInRuntimeActionResponse,
    ContinueCommand,
    ContinueWithoutAdditionalInfoCommand,
    OpportunityKind,
    HarnessConfig,
    ProvideAdditionalInfoCommand,
    HarnessServiceError,
    SubmitCommand,
    SubmitRuntimeActionResponse,
    ReadEmailRuntimeAction,
    ReadInboxRuntimeAction,
    ReportApplicationMismatchRuntimeAction,
    RequestAdditionalInfoRuntimeAction,
    RequestSignInRuntimeAction,
    RequestHumanNavigationRuntimeAction,
    RequestHumanReviewRuntimeAction,
    ReviseCommand,
    SteerCommand,
    SESSION_ERROR_MESSAGES,
)
from jobhunter_browser_harness.pipeline_agent import PipelineApplicationAgentError
from jobhunter_browser_harness.sessions import ApplicationSessionManager
from jobhunter_browser_harness.tools import HumanGate


TOKEN = "test-token-0123456789abcdef-0123456789"
AUTHORIZATION = {"Authorization": f"Bearer {TOKEN}"}
JOB_URL = "https://jobs.example/openings/42?candidate=private-secret"
PROFILE_SECRET = "ada.private@example.test"

class _UnusedGmailAuth:
    async def status(self) -> Any:
        raise AssertionError("Gmail auth is outside this test")

    async def start(self) -> Any:
        raise AssertionError("Gmail auth is outside this test")

    async def get_session(self, _session_id: str) -> Any:
        raise AssertionError("Gmail auth is outside this test")

    async def complete_callback(
        self,
        *,
        state: str | None,
        code: str | None,
        error: str | None,
    ) -> bool:
        raise AssertionError("Gmail auth is outside this test")

    async def disconnect(self) -> None:
        raise AssertionError("Gmail auth is outside this test")

    async def shutdown(self) -> None:
        return None


_UNUSED_GMAIL_AUTH = _UnusedGmailAuth()


def upload(filename: str, content: bytes) -> UploadFile:
    return UploadFile(file=BytesIO(content), filename=filename)


def pdf_bytes(text: str = "Deterministic resume evidence") -> bytes:
    """Make the same small, extractable one-page PDF used by artifact tests."""
    destination = BytesIO()
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_reference = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_reference})}
    )
    contents = DecodedStreamObject()
    contents.set_data(f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(contents)
    writer.write(destination)
    return destination.getvalue()


def valid_uploads(
    *,
    full_name: str = "Ada Lovelace",
) -> tuple[UploadFile, UploadFile, UploadFile]:
    personal = (
        "---\n"
        f"full_name: {full_name}\n"
        f"email: {PROFILE_SECRET}\n"
        "---\n"
        "Experienced analytical engineer.\n"
    ).encode()
    return (
        upload("profile.md", personal),
        upload("resume.pdf", pdf_bytes()),
        upload("resume.tex", b"\\documentclass{article}\nResume evidence.\n"),
    )


def multipart_parts() -> list[tuple[str, tuple[None, str] | tuple[str, bytes, str]]]:
    return [
        ("opportunity_kind", (None, "job")),
        ("job_url", (None, JOB_URL)),
        (
            "personal_information",
            (
                "profile.md",
                (
                    "---\n"
                    "full_name: Ada Lovelace\n"
                    f"email: {PROFILE_SECRET}\n"
                    "---\nProfile.\n"
                ).encode(),
                "text/markdown",
            ),
        ),
        ("resume", ("resume.pdf", pdf_bytes(), "application/pdf")),
        (
            "resume_source",
            (
                "resume.tex",
                b"\\documentclass{article}\nResume evidence.\n",
                "text/x-tex",
            ),
        ),
    ]


def review_result(*, revision_count: int = 0) -> ReviewApplicationResult:
    return ReviewApplicationResult(
        status="ready_for_submission",
        company="Example Corp",
        role="Engineer",
        job_url=JOB_URL,
        final_url="https://ats.example/application/42?answer=private#review",
        fields_filled=[
            {
                "label": "Email",
                "field_type": "text",
                "value_present": True,
                "note": "Filled from an explicit profile placeholder",
            }
        ],
        fields_needing_human=[],
        files_attached=["resume.pdf"],
        warnings=[],
        revision_count=revision_count,
        submit_attempted=False,
    )


def submitted_result(*, revision_count: int = 0) -> SubmittedApplicationResult:
    return SubmittedApplicationResult.model_validate(
        {
            **review_result(revision_count=revision_count).model_dump(),
            "status": "submitted",
            "final_url": "https://ats.example/application/42/confirmation",
            "submit_attempted": True,
            "submission_confirmation": {
                "type": "post_submit_confirmation",
                "text": "Application received.",
            },
        }
    )


def uncertain_result(*, revision_count: int = 0) -> SubmissionUncertainApplicationResult:
    return SubmissionUncertainApplicationResult.model_validate(
        {
            **review_result(revision_count=revision_count).model_dump(),
            "status": "submission_uncertain",
            "submit_attempted": True,
            "submission_confirmation": None,
        }
    )


def cancelled_result(*, revision_count: int = 0) -> CancelledApplicationResult:
    return CancelledApplicationResult.model_validate(
        {
            **review_result(revision_count=revision_count).model_dump(),
            "status": "cancelled",
            "submit_attempted": False,
            "submission_confirmation": None,
        }
    )


@dataclass(slots=True)
class FakeModel:
    order: list[str]
    ready_error: PipelineApplicationAgentError | None = None
    check_blocker: asyncio.Event | None = None
    check_started: asyncio.Event = field(default_factory=asyncio.Event)
    active_started: asyncio.Event = field(default_factory=asyncio.Event)
    active_finished: asyncio.Event = field(default_factory=asyncio.Event)
    closed: bool = False
    close_failures: int = 0
    close_started: asyncio.Event = field(default_factory=asyncio.Event)
    close_blocker: asyncio.Event | None = None
    run_result: ApplicationRunResult | None = None
    run_calls: list[dict[str, Any]] = field(default_factory=list)
    run_error: Exception | None = None
    steer_calls: list[str] = field(default_factory=list)
    steer_started: asyncio.Event = field(default_factory=asyncio.Event)
    steer_blocker: asyncio.Event | None = None
    steer_error: PipelineApplicationAgentError | None = None

    async def check_ready(self) -> None:
        self.order.append("model.check_ready")
        self.check_started.set()
        if self.check_blocker is not None:
            await self.check_blocker.wait()
        if self.ready_error is not None:
            raise self.ready_error

    async def active_call(self) -> None:
        self.order.append("model.active")
        self.active_started.set()
        try:
            await asyncio.Future()
        finally:
            self.order.append("model.active_finished")
            self.active_finished.set()

    async def run(self, **kwargs: Any) -> ApplicationRunResult:
        self.order.append("model.run")
        self.run_calls.append(kwargs)
        if self.run_error is not None:
            raise self.run_error
        if self.run_result is None:
            raise AssertionError("No synthetic application-agent result configured")
        return self.run_result

    async def steer(self, message: str) -> None:
        self.steer_calls.append(message)
        self.steer_started.set()
        if self.steer_blocker is not None:
            await self.steer_blocker.wait()
        if self.steer_error is not None:
            raise self.steer_error


    async def aclose(self) -> None:
        self.order.append("model.aclose")
        self.close_started.set()
        if self.close_failures:
            self.close_failures -= 1
            raise RuntimeError("synthetic model cleanup failure")
        if self.close_blocker is not None:
            await self.close_blocker.wait()
        self.closed = True


@dataclass(slots=True)
class FakePlaywrightRuntime:
    order: list[str] = field(default_factory=list)
    result: PlaywrightCliExecutionResult = field(
        default_factory=lambda: playwright_execution_result()
    )
    results: list[PlaywrightCliExecutionResult] | None = None
    blocker: asyncio.Event | None = None
    error: PlaywrightCliRuntimeError | None = None
    suspend_navigation_guard_error: PlaywrightCliRuntimeError | None = None
    start_error: PlaywrightCliRuntimeError | None = None
    start_blocker: asyncio.Event | None = None
    start_started: asyncio.Event = field(default_factory=asyncio.Event)
    private_sign_in_error: PlaywrightCliRuntimeError | None = None
    activate_private_values_error: PlaywrightCliRuntimeError | None = None
    capture_suppression_error: PlaywrightCliRuntimeError | None = None
    started: asyncio.Event = field(default_factory=asyncio.Event)
    private_sign_in_blocker: asyncio.Event | None = None
    private_sign_in_started: asyncio.Event = field(default_factory=asyncio.Event)
    commands: list[tuple[str, list[str]]] = field(default_factory=list)
    close_failures: int = 0
    close_cancels_active: bool = True
    close_blocker: asyncio.Event | None = None
    close_started: asyncio.Event = field(default_factory=asyncio.Event)
    close_observer: Callable[[], None] | None = None
    runtime_started: bool = False
    closed: bool = False
    active_task: asyncio.Task[Any] | None = None
    job_url: str | None = None
    current_url: str = JOB_URL
    approved_origins: tuple[str, ...] = ()
    navigation_guard_suspended: bool = False
    activated_private_values: list[tuple[str, ...]] = field(default_factory=list)
    sign_in_calls: list[dict[str, str]] = field(default_factory=list)
    capture_suppression_calls: int = 0
    source_snapshot_result: Any = (
        "https://jobs.example/openings/42?verified=true",
        "Verified role\nEmployer details",
    )
    source_snapshot_error: Exception | None = None
    source_snapshot_blocker: asyncio.Event | None = None
    source_snapshot_started: asyncio.Event = field(default_factory=asyncio.Event)
    source_snapshot_calls: list[str] = field(default_factory=list)
    video_recording: bool = False

    async def start(self, job_url: str) -> None:
        self.order.append("runtime.start")
        self.job_url = job_url
        self.current_url = job_url
        self.runtime_started = True
        self.video_recording = True
        self.start_started.set()
        if self.start_blocker is not None:
            await self.start_blocker.wait()
        if self.start_error is not None:
            raise self.start_error

    async def execute(
        self,
        command: str,
        args: Sequence[str],
        *,
        expose_applicant_values: bool = False,
    ) -> PlaywrightCliExecutionResult:
        del expose_applicant_values
        self.active_task = asyncio.current_task()
        self.commands.append((command, list(args)))
        self.started.set()
        try:
            if self.blocker is not None:
                await self.blocker.wait()
            if self.error is not None:
                raise self.error
            if self.results is not None:
                if not self.results:
                    raise AssertionError("No synthetic runtime result remains")
                return self.results.pop(0)
            return self.result
        finally:
            self.active_task = None
            self.order.append("runtime.execute_finished")

    async def get_current_page_url(self) -> str:
        return self.current_url

    async def capture_source_snapshot(
        self,
        expected_origin: str,
    ) -> tuple[str, str] | None:
        self.source_snapshot_calls.append(expected_origin)
        self.source_snapshot_started.set()
        if self.source_snapshot_blocker is not None:
            await self.source_snapshot_blocker.wait()
        if self.source_snapshot_error is not None:
            raise self.source_snapshot_error
        return self.source_snapshot_result

    async def set_approved_origins(self, origins: Sequence[str]) -> None:
        self.approved_origins = tuple(origins)
        self.navigation_guard_suspended = False

    async def suspend_navigation_guard(self) -> None:
        if self.suspend_navigation_guard_error is not None:
            raise self.suspend_navigation_guard_error
        self.navigation_guard_suspended = True

    async def suppress_private_capture(self) -> None:
        self.order.append("runtime.suppress_private_capture")
        self.capture_suppression_calls += 1
        if self.capture_suppression_error is not None:
            raise self.capture_suppression_error
        self.video_recording = False

    async def activate_private_values(self, values: Sequence[str]) -> None:
        self.activated_private_values.append(tuple(values))
        if self.activate_private_values_error is not None:
            raise self.activate_private_values_error

    async def verify_origin_and_activate_private_values(
        self,
        expected_origin: str,
        values: Sequence[str],
    ) -> str | None:
        if self.current_url != expected_origin and not self.current_url.startswith(
            f"{expected_origin}/"
        ):
            return None
        await self.activate_private_values(values)
        return expected_origin

    async def sign_in(
        self,
        *,
        expected_origin: str,
        username_ref: str,
        password_ref: str,
        password_confirmation_ref: str | None,
        submit_ref: str,
        username: str,
        password: str,
    ) -> None:
        self.order.append("runtime.private_sign_in_started")
        self.private_sign_in_started.set()
        if self.private_sign_in_blocker is not None:
            await self.private_sign_in_blocker.wait()
        self.order.append("runtime.private_sign_in")
        if self.private_sign_in_error is not None:
            raise self.private_sign_in_error
        self.activated_private_values.append((username, password))
        self.sign_in_calls.append(
            {
                "expected_origin": expected_origin,
                "username_ref": username_ref,
                "password_ref": password_ref,
                "submit_ref": submit_ref,
                "username": username,
                "password": password,
            }
        )
        if password_confirmation_ref is not None:
            self.sign_in_calls[-1]["password_confirmation_ref"] = (
                password_confirmation_ref
            )


    async def close(self) -> None:
        if self.close_observer is not None:
            self.close_observer()
        self.order.append("runtime.close")
        self.close_started.set()
        if self.close_failures:
            self.close_failures -= 1
            raise RuntimeError("synthetic Playwright cleanup failure")
        active = self.active_task
        if active is not None and active is not asyncio.current_task() and not active.done():
            if self.close_cancels_active:
                active.cancel()
            await asyncio.gather(active, return_exceptions=True)
        if self.close_blocker is not None:
            await self.close_blocker.wait()
        self.closed = True


def playwright_execution_result(
    url: str = "https://jobs.example/openings/42?private=value",
) -> PlaywrightCliExecutionResult:
    return PlaywrightCliExecutionResult(exit_code=0, stdout="completed",
    stderr="",
    stdout_truncated=False,
    stderr_truncated=False,
    observation=BrowserObservation(
        url=url,
        title="Application",
        tabs=[],
        dom="Application form",
        page_info={"url": url},
        screenshot=None,
    ),)


class Fakes:
    def __init__(
        self,
        *,
        order: list[str] | None = None,
        ready_error: PipelineApplicationAgentError | None = None,
        check_blocker: asyncio.Event | None = None,
        runtime_start_error: PlaywrightCliRuntimeError | None = None,
        runtime_start_blocker: asyncio.Event | None = None,
        runtime_close_failures: int = 0,
        runtime_close_cancels_active: bool = True,
        runtime_close_blocker: asyncio.Event | None = None,
        model_close_failures: int = 0,
        model_close_blocker: asyncio.Event | None = None,
        agent_result: ApplicationRunResult | None = None,
        agent_error: Exception | None = None,
        steer_blocker: asyncio.Event | None = None,
        steer_error: PipelineApplicationAgentError | None = None,
    ) -> None:
        self.order = order if order is not None else []
        self.ready_error = ready_error
        self.check_blocker = check_blocker
        self.runtime_start_error = runtime_start_error
        self.runtime_start_blocker = runtime_start_blocker
        self.runtime_close_failures = runtime_close_failures
        self.runtime_close_cancels_active = runtime_close_cancels_active
        self.runtime_close_blocker = runtime_close_blocker
        self.model_close_failures = model_close_failures
        self.model_close_blocker = model_close_blocker
        self.agent_result = agent_result
        self.agent_error = agent_error
        self.steer_blocker = steer_blocker
        self.steer_error = steer_error
        self.models: list[FakeModel] = []
        self.runtimes: list[FakePlaywrightRuntime] = []
        self.runtime_factory_calls: list[dict[str, Any]] = []

    def model_factory(
        self, _session_id: UUID, _pipeline_url: str, _token: str
    ) -> FakeModel:
        model = FakeModel(
            order=self.order,
            ready_error=self.ready_error,
            check_blocker=self.check_blocker,
            close_failures=self.model_close_failures,
            close_blocker=self.model_close_blocker,
            run_result=self.agent_result,
            run_error=self.agent_error,
            steer_blocker=self.steer_blocker,
            steer_error=self.steer_error,
        )
        self.models.append(model)
        return model

    def runtime_factory(self, **kwargs: Any) -> FakePlaywrightRuntime:
        self.order.append("runtime.factory")
        self.runtime_factory_calls.append(kwargs)
        runtime = FakePlaywrightRuntime(
            order=self.order,
            start_error=self.runtime_start_error,
            close_cancels_active=self.runtime_close_cancels_active,
            start_blocker=self.runtime_start_blocker,
            close_failures=self.runtime_close_failures,
            close_blocker=self.runtime_close_blocker,
        )
        self.runtimes.append(runtime)
        return runtime


class ImmediateContextProcess:
    def __init__(self, stored: Any) -> None:
        self._candidate = load_candidate_context(stored)
        self.terminated = False

    async def result(self) -> CandidateContext:
        return self._candidate

    async def terminate(self) -> None:
        self.terminated = True


@dataclass(slots=True)
class FakeInbox:
    search_result: InboxSearchResult
    email: InboxEmail
    calls: list[tuple[str, dict[str, object]]] = field(default_factory=list)

    async def search_inbox(self, **filters: object) -> InboxSearchResult:
        self.calls.append(("search", filters))
        return self.search_result

    async def read_email(self, email_id: str, *, offset: int = 0) -> InboxEmail:
        self.calls.append(("read", {"email_id": email_id, "offset": offset}))
        return self.email


Runner = Callable[
    [
        ApplicationRunRequest,
        FakeModel,
        FakePlaywrightRuntime,
        HumanGate,
        Callable[[int, str], Awaitable[None]],
    ],
    Awaitable[ApplicationRunResult],
]


def make_manager(
    tmp_path: Path,
    runner: Runner | None,
    *,
    fakes: Fakes | None = None,
    timeout: int | None = None,
    context_process_factory: Callable[[Any], Any] = ImmediateContextProcess,
    credential_store: CredentialStore | None = None,
    gmail_inbox: FakeInbox | None = None,
    default_credentials: tuple[str, str] | None = None,
) -> tuple[ApplicationSessionManager, Fakes, Path]:
    doubles = fakes or Fakes()
    root = tmp_path / "sessions"
    manager = ApplicationSessionManager(
        HarnessConfig(
            bearer_token=TOKEN,
            session_timeout=timeout,
            node_executable=tmp_path / "node",
            playwright_cli_script=tmp_path / "playwright-cli.js",
            user_info_json=tmp_path / "user-info.json",
            credentials_json=tmp_path / "credentials.json",
        ),
        artifacts_root=root,
        browser_launch=ResolvedBrowserLaunch(
            cdp_url=None,
            executable_path=tmp_path / "fake-chrome",
            user_data_dir=tmp_path / "profile",
        ),
        model_factory=doubles.model_factory,
        context_process_factory=context_process_factory,
        application_runner=runner,
        runtime_factory=doubles.runtime_factory,
        credential_store=credential_store,
        gmail_inbox=gmail_inbox,
        default_credentials=default_credentials,
    )
    return manager, doubles, root


def only_session(manager: ApplicationSessionManager):
    sessions = manager._sessions
    if not sessions:
        return None
    assert len(sessions) == 1
    return next(iter(sessions.values()))


@pytest.mark.asyncio
async def test_startup_reclaims_daemons_and_orphaned_artifacts_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _fakes, root = make_manager(tmp_path, blocked_runner)
    recovery_calls: list[dict[str, object]] = []
    cleanup_calls: list[Path] = []

    async def recover(**kwargs: object) -> None:
        recovery_calls.append(kwargs)

    def cleanup(path: Path) -> bool:
        cleanup_calls.append(path)
        return True

    monkeypatch.setattr(
        sessions_module,
        "recover_stale_playwright_cli_sessions",
        recover,
        raising=False,
    )
    monkeypatch.setattr(
        sessions_module,
        "cleanup_orphaned_session_artifacts",
        cleanup,
        raising=False,
    )

    await manager.startup()
    await manager.startup()

    assert recovery_calls == [
        {
            "artifacts_root": root,
            "node_executable": tmp_path / "node",
            "cli_script": tmp_path / "playwright-cli.js",
        }
    ]
    assert cleanup_calls == [root]


async def test_manager_passes_resolved_cli_config_to_one_runtime(
    tmp_path: Path,
) -> None:
    manager, fakes, root = make_manager(tmp_path, blocked_runner)

    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")

    assert len(fakes.runtimes) == 1
    runtime = fakes.runtimes[0]
    assert runtime.runtime_started is True
    assert runtime.job_url == JOB_URL
    assert runtime.approved_origins == ("https://jobs.example",)
    assert len(fakes.runtime_factory_calls) == 1
    call = fakes.runtime_factory_calls[0]
    assert set(call) == {
        "session_id",
        "launch",
        "session_directory",
        "node_executable",
        "cli_script",
    }
    assert call["session_id"] == created.session_id
    assert call["launch"] == ResolvedBrowserLaunch(
        cdp_url=None,
        executable_path=tmp_path / "fake-chrome",
        user_data_dir=tmp_path / "profile",
    )
    assert call["session_directory"].parent == root
    assert call["node_executable"] == tmp_path / "node"
    assert call["cli_script"] == tmp_path / "playwright-cli.js"
    assert "deadline" not in call
    record = only_session(manager)
    assert record is not None and record.playwright_runtime is runtime

    await manager.delete(created.session_id)


async def create_valid(
    manager: ApplicationSessionManager,
    *,
    session_id: UUID | None = None,
    auto_submit: bool = False,
    opportunity_kind: OpportunityKind = "job",
    allow_domains: Sequence[str] = (),
    full_name: str = "Ada Lovelace",
):
    personal, resume, resume_source = valid_uploads(full_name=full_name)
    return await manager.create_session(
        session_id=session_id,
        job_url=JOB_URL,
        opportunity_kind=opportunity_kind,
        allow_domains=list(allow_domains),
        auto_submit=auto_submit,
        personal_information=personal,
        resume=resume,
        resume_source=resume_source,
        context=[],
        anecdotes=[],
    )


CAPTURE_ID = UUID("c7c4ee5d-c679-4548-b74c-f106227c84c8")


async def create_source_capture(
    manager: ApplicationSessionManager,
    *,
    capture_id: UUID = CAPTURE_ID,
):
    return await manager.create_source_capture(
        capture_id=capture_id,
        job_url=JOB_URL,
        approved_origins=["https://jobs.example"],
    )


async def test_source_capture_and_application_session_share_one_browser_slot(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    capture = await create_source_capture(manager)

    assert capture.capture_id == CAPTURE_ID
    assert capture.state == "awaiting_human_verification"
    assert len(fakes.runtimes) == 1
    runtime = fakes.runtimes[0]
    assert runtime.job_url == JOB_URL
    assert runtime.approved_origins == ("https://jobs.example",)
    assert runtime.capture_suppression_calls == 1
    with pytest.raises(HarnessServiceError) as application_conflict:
        await create_valid(manager)
    assert_service_error(
        application_conflict.value,
        409,
        "session_active",
        "An application session is already active",
    )

    await manager.delete_source_capture(CAPTURE_ID)
    application = await create_valid(manager)
    with pytest.raises(HarnessServiceError) as capture_conflict:
        await create_source_capture(
            manager,
            capture_id=UUID("6439c0eb-a398-49b0-a453-b0fb030203ed"),
        )
    assert_service_error(
        capture_conflict.value,
        409,
        "source_capture_active",
        "A source capture is already active",
    )
    await manager.delete(application.session_id)


async def test_source_capture_completion_returns_only_bounded_snapshot_and_releases_slot(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    runtime = fakes.runtimes[0]

    result = await manager.complete_source_capture(CAPTURE_ID)

    assert result.model_dump() == {
        "capture_id": CAPTURE_ID,
        "final_url": "https://jobs.example/openings/42?verified=true",
        "source": "Verified role\nEmployer details",
    }
    assert runtime.source_snapshot_calls == ["https://jobs.example"]
    assert runtime.commands == []
    assert runtime.closed is True
    assert runtime.capture_suppression_calls == 1
    duplicate_complete = await manager.complete_source_capture(CAPTURE_ID)
    assert duplicate_complete == result
    await manager.delete_source_capture(CAPTURE_ID)
    assert manager._source_capture_replay is None
    await manager.delete_source_capture(CAPTURE_ID)
    with pytest.raises(HarnessServiceError) as unknown_cancel:
        await manager.delete_source_capture(
            UUID("bd9acf9d-2c48-46db-80dd-f1abf594ce81")
        )
    assert_service_error(
        unknown_cancel.value,
        404,
        "source_capture_not_found",
        "Source capture was not found",
    )
    replacement = await create_valid(manager)
    await manager.delete(replacement.session_id)


async def test_source_capture_completion_replays_after_requester_loses_response(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    runtime = fakes.runtimes[0]
    release_snapshot = asyncio.Event()
    runtime.source_snapshot_blocker = release_snapshot

    request = asyncio.create_task(
        manager.complete_source_capture(CAPTURE_ID)
    )
    await runtime.source_snapshot_started.wait()
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request

    release_snapshot.set()
    await wait_until(lambda: manager._source_capture is None)

    replayed = await manager.complete_source_capture(CAPTURE_ID)
    assert replayed.model_dump() == {
        "capture_id": CAPTURE_ID,
        "final_url": "https://jobs.example/openings/42?verified=true",
        "source": "Verified role\nEmployer details",
    }
    await manager.delete_source_capture(CAPTURE_ID)




async def test_source_capture_result_remains_available_while_cleanup_is_blocked(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    runtime = fakes.runtimes[0]
    release_cleanup = asyncio.Event()
    runtime.close_blocker = release_cleanup
    record = manager._source_capture
    assert record is not None

    completion = asyncio.create_task(
        manager.complete_source_capture(CAPTURE_ID)
    )
    await runtime.close_started.wait()

    assert record.completed_result is not None
    await asyncio.sleep(0.01)
    assert record.completed_result is not None

    release_cleanup.set()
    result = await completion
    assert await manager.complete_source_capture(CAPTURE_ID) == result
    await manager.delete_source_capture(CAPTURE_ID)

async def test_concurrent_source_capture_completion_joins_one_snapshot(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    runtime = fakes.runtimes[0]
    release_snapshot = asyncio.Event()
    runtime.source_snapshot_blocker = release_snapshot

    first = asyncio.create_task(manager.complete_source_capture(CAPTURE_ID))
    await runtime.source_snapshot_started.wait()
    second = asyncio.create_task(manager.complete_source_capture(CAPTURE_ID))
    await asyncio.sleep(0)
    release_snapshot.set()
    first_result, second_result = await asyncio.gather(first, second)

    assert first_result == second_result
    assert runtime.source_snapshot_calls == [
        "https://jobs.example",
    ]
    assert runtime.closed is True
    await manager.delete_source_capture(CAPTURE_ID)


async def test_source_capture_completion_rejects_wrong_origin_without_closing_manual_browser(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    runtime = fakes.runtimes[0]
    runtime.source_snapshot_result = None

    with pytest.raises(HarnessServiceError) as not_ready:
        await manager.complete_source_capture(CAPTURE_ID)
    assert_service_error(
        not_ready.value,
        409,
        "source_capture_not_ready",
        "Source capture is not ready",
    )
    assert runtime.closed is False

    runtime.source_snapshot_result = (
        "https://jobs.example/openings/42?verified=true",
        "Verified role\nEmployer details",
    )
    completed = await manager.complete_source_capture(CAPTURE_ID)
    assert completed.capture_id == CAPTURE_ID
    assert runtime.closed is True
    await manager.delete_source_capture(CAPTURE_ID)


async def test_source_capture_create_is_idempotent_only_for_the_same_live_request(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    first = await create_source_capture(manager)
    replay = await create_source_capture(manager)

    assert replay == first
    assert len(fakes.runtimes) == 1
    with pytest.raises(HarnessServiceError) as changed_payload:
        await manager.create_source_capture(
            capture_id=CAPTURE_ID,
            job_url=f"{JOB_URL}&other=true",
            approved_origins=["https://jobs.example"],
        )
    assert_service_error(
        changed_payload.value,
        409,
        "source_capture_active",
        "A source capture is already active",
    )
    with pytest.raises(HarnessServiceError) as other_id:
        await create_source_capture(
            manager,
            capture_id=UUID("4a1fb91d-1dce-4f6a-ac44-62e47d578011"),
        )
    assert_service_error(
        other_id.value,
        409,
        "source_capture_active",
        "A source capture is already active",
    )
    await manager.delete_source_capture(CAPTURE_ID)


async def test_source_capture_start_failure_cleans_and_reclaims_browser_slot(
    tmp_path: Path,
) -> None:
    fakes = Fakes(
        runtime_start_error=PlaywrightCliRuntimeError("browser_failed"),
    )
    manager, _, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=fakes,
    )

    with pytest.raises(HarnessServiceError) as unavailable:
        await create_source_capture(manager)
    assert_service_error(
        unavailable.value,
        503,
        "unavailable",
        "Source capture is unavailable",
    )
    assert fakes.runtimes[0].closed is True

    fakes.runtime_start_error = None
    replacement_id = UUID("08004103-8944-44a5-931b-94251c514f54")
    replacement = await create_source_capture(
        manager,
        capture_id=replacement_id,
    )
    assert replacement.capture_id == replacement_id
    await manager.delete_source_capture(replacement_id)

async def test_source_capture_live_replay_joins_blocked_setup_failure(
    tmp_path: Path,
) -> None:
    release_start = asyncio.Event()
    fakes = Fakes(
        runtime_start_error=PlaywrightCliRuntimeError("browser_failed"),
        runtime_start_blocker=release_start,
    )
    manager, _, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=fakes,
    )
    first = asyncio.create_task(create_source_capture(manager))
    await wait_until(lambda: len(fakes.runtimes) == 1)
    await fakes.runtimes[0].start_started.wait()
    replay = asyncio.create_task(create_source_capture(manager))
    await asyncio.sleep(0)

    assert first.done() is False
    assert replay.done() is False
    assert len(fakes.runtimes) == 1

    release_start.set()
    outcomes = await asyncio.gather(first, replay, return_exceptions=True)
    for outcome in outcomes:
        assert isinstance(outcome, HarnessServiceError)
        assert_service_error(
            outcome,
            503,
            "unavailable",
            "Source capture is unavailable",
        )
    assert fakes.runtimes[0].closed is True


async def test_source_capture_malformed_runtime_result_fails_closed(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    runtime = fakes.runtimes[0]
    runtime.source_snapshot_result = ("https://jobs.example/openings/42",)

    with pytest.raises(HarnessServiceError) as unavailable:
        await manager.complete_source_capture(CAPTURE_ID)

    assert_service_error(
        unavailable.value,
        503,
        "unavailable",
        "Source capture is unavailable",
    )
    assert runtime.closed is True

async def test_source_capture_failure_time_completion_joins_one_snapshot(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    runtime = fakes.runtimes[0]
    runtime.source_snapshot_error = RuntimeError("private snapshot detail")
    original_fail = manager._fail_source_capture_completion
    failure_entered = asyncio.Event()
    allow_failure = asyncio.Event()

    async def blocked_failure(*args: Any, **kwargs: Any) -> Any:
        failure_entered.set()
        await allow_failure.wait()
        return await original_fail(*args, **kwargs)

    manager._fail_source_capture_completion = blocked_failure  # type: ignore[method-assign]
    first = asyncio.create_task(
        manager.complete_source_capture(CAPTURE_ID)
    )
    await failure_entered.wait()
    second = asyncio.create_task(
        manager.complete_source_capture(CAPTURE_ID)
    )
    await asyncio.sleep(0)

    assert runtime.source_snapshot_calls == ["https://jobs.example"]
    allow_failure.set()
    outcomes = await asyncio.gather(first, second, return_exceptions=True)
    for outcome in outcomes:
        assert isinstance(outcome, HarnessServiceError)
        assert_service_error(
            outcome,
            503,
            "unavailable",
            "Source capture is unavailable",
        )
    assert runtime.closed is True


async def test_source_capture_delete_wins_post_snapshot_completion_contention(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    original_finish = manager._finish_source_capture_completion
    finish_entered = asyncio.Event()
    allow_finish = asyncio.Event()

    async def blocked_finish(*args: Any, **kwargs: Any) -> Any:
        finish_entered.set()
        await allow_finish.wait()
        return await original_finish(*args, **kwargs)

    manager._finish_source_capture_completion = blocked_finish  # type: ignore[method-assign]
    completion = asyncio.create_task(
        manager.complete_source_capture(CAPTURE_ID)
    )
    await finish_entered.wait()
    deletion = asyncio.create_task(manager.delete_source_capture(CAPTURE_ID))
    await asyncio.sleep(0)
    allow_finish.set()

    with pytest.raises(HarnessServiceError) as not_ready:
        await completion
    assert_service_error(
        not_ready.value,
        409,
        "source_capture_not_ready",
        "Source capture is not ready",
    )
    await deletion
    assert fakes.runtimes[0].closed is True
    assert manager._source_capture_tombstones[CAPTURE_ID].state == "cancelled"




async def test_source_snapshot_failure_closes_runtime_and_returns_fixed_unavailable(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    runtime = fakes.runtimes[0]
    runtime.source_snapshot_error = RuntimeError("private snapshot detail")

    with pytest.raises(HarnessServiceError) as unavailable:
        await manager.complete_source_capture(CAPTURE_ID)

    assert_service_error(
        unavailable.value,
        503,
        "unavailable",
        "Source capture is unavailable",
    )
    assert runtime.closed is True
    replacement = await create_valid(manager)
    await manager.delete(replacement.session_id)


async def test_source_capture_cleanup_retries_before_releasing_browser_slot(
    tmp_path: Path,
) -> None:
    fakes = Fakes(runtime_close_failures=1)
    manager, _, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=fakes,
    )
    await create_source_capture(manager)

    await manager.delete_source_capture(CAPTURE_ID)

    assert fakes.order.count("runtime.close") == 2
    replacement = await create_valid(manager)
    await manager.delete(replacement.session_id)




async def test_source_capture_has_no_lease_and_shutdown_releases_slot(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_source_capture(manager)
    record = manager._source_capture
    assert record is not None

    await asyncio.sleep(0.01)
    assert manager._source_capture is record
    assert fakes.runtimes[0].closed is False

    await manager.shutdown()
    assert fakes.runtimes[0].closed is True
    with pytest.raises(HarnessServiceError) as shutdown_rejects_create:
        await create_source_capture(
            manager,
            capture_id=UUID("44867e58-64f7-40d1-b897-ac55f5adfb7d"),
        )
    assert_service_error(
        shutdown_rejects_create.value,
        503,
        "unavailable",
        "Source capture is unavailable",
    )


async def wait_until(predicate: Callable[[], bool], *, timeout: float = 1.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0)

    await asyncio.wait_for(poll(), timeout=timeout)


async def wait_state(
    manager: ApplicationSessionManager, session_id: UUID, state: str
) -> None:
    await wait_until(lambda: manager.get_snapshot(session_id).state == state)


def assert_service_error(
    error: HarnessServiceError,
    status: int,
    code: str,
    message: str,
) -> None:
    assert (error.status_code, error.code, error.public_message) == (status, code, message)


async def runtime_action(
    manager: ApplicationSessionManager,
    session_id: UUID,
    action: Any,
) -> Any:
    return await manager.runtime_model_action(session_id, action)


def decode_frame(frame: str) -> dict[str, Any]:
    data_line = next(line for line in frame.splitlines() if line.startswith("data: "))
    return json.loads(data_line.removeprefix("data: "))


async def blocked_runner(
    _request: ApplicationRunRequest,
    _model: FakeModel,
    playwright_runtime: FakePlaywrightRuntime,
    _gate: HumanGate,
    _step: Callable[[int, str], Awaitable[None]],
) -> ApplicationRunResult:
    await asyncio.Future()
    raise AssertionError("unreachable")


async def test_steer_dispatches_only_to_the_live_model_without_durable_projection(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    snapshot_before = record.snapshot
    events_before = tuple(record.events)
    gate = record.human_gate
    assert gate is not None
    redaction_values_before = gate.redaction_values
    user_info_path = tmp_path / "user-info.json"
    user_info_before = user_info_path.read_bytes() if user_info_path.exists() else None
    guidance = "private operator correction"

    await manager.command(
        created.session_id,
        SteerCommand(type="steer", message=f"  {guidance}  "),
    )

    assert fakes.models[0].steer_calls == [guidance]
    assert record.snapshot == snapshot_before
    assert tuple(record.events) == events_before
    user_info_after = user_info_path.read_bytes() if user_info_path.exists() else None
    assert user_info_after == user_info_before
    assert gate.redaction_values == redaction_values_before
    assert guidance not in record.snapshot.model_dump_json()
    assert all(guidance not in event.model_dump_json() for event in record.events)

    await manager.delete(created.session_id)
    tombstone = manager._tombstones[created.session_id]
    assert guidance not in tombstone.snapshot.model_dump_json()
    assert all(guidance not in event.model_dump_json() for event in tombstone.events)


async def test_steer_interrupts_a_pending_gate_but_rejects_inactive_generations(
    tmp_path: Path,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert (
        record is not None
        and record.human_gate is not None
        and record.playwright_runtime is not None
    )
    guidance = "use the corrected sign-in instructions"
    navigation = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanNavigationRuntimeAction(
                type="request_human_navigation",
                instruction="Complete the account sign-in.",
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "navigation")

    await manager.command(
        created.session_id,
        SteerCommand(type="steer", message=guidance),
    )

    assert fakes.models[0].steer_calls == [guidance]
    assert manager.get_snapshot(created.session_id).state == "running"
    assert record.human_gate.pending_kind is None
    assert isinstance(await navigation, InterruptedRuntimeActionResponse)

    async def assert_conflict() -> None:
        with pytest.raises(HarnessServiceError) as raised:
            await manager.command(
                created.session_id,
                SteerCommand(type="steer", message="must not be dispatched"),
            )
        assert_service_error(
            raised.value,
            409,
            "command_conflict",
            "The application state changed; review the latest session state",
        )
        assert fakes.models[0].steer_calls == [guidance]

    live_agent_task = record.agent_task
    assert live_agent_task is not None
    completed_task = asyncio.create_task(asyncio.sleep(0))
    await completed_task
    record.agent_task = completed_task
    await assert_conflict()
    record.agent_task = live_agent_task

    model = record.model
    record.model = None
    await assert_conflict()
    record.model = model

    record.submission_action_started = True
    await assert_conflict()
    record.submission_action_started = False

    await manager.delete(created.session_id)


async def test_steer_deadline_wins_before_private_dispatch(tmp_path: Path) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, timeout=60)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    record.deadline_monotonic = asyncio.get_running_loop().time()

    with pytest.raises(HarnessServiceError) as raised:
        await manager.command(
            created.session_id,
            SteerCommand(type="steer", message="too late"),
        )

    assert_service_error(
        raised.value,
        409,
        "session_terminal",
        "The application session has already ended",
    )
    assert fakes.models[0].steer_calls == []
    await record.closed_event.wait()


@pytest.mark.parametrize(
    ("pipeline_error", "status", "code", "message"),
    [
        (
            PipelineApplicationAgentError(
                "command_conflict",
                "The application state changed; review the latest session state",
            ),
            409,
            "command_conflict",
            "The application state changed; review the latest session state",
        ),
        (
            PipelineApplicationAgentError(
                "pipeline_unavailable",
                "The local pipeline model service is unavailable",
            ),
            503,
            "pipeline_unavailable",
            "The local pipeline model service is unavailable",
        ),
    ],
)
async def test_steer_maps_private_failures_to_fixed_public_errors(
    tmp_path: Path,
    pipeline_error: PipelineApplicationAgentError,
    status: int,
    code: str,
    message: str,
) -> None:
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=Fakes(steer_error=pipeline_error),
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    guidance = "private operator guidance"

    with pytest.raises(HarnessServiceError) as raised:
        await manager.command(
            created.session_id,
            SteerCommand(type="steer", message=guidance),
        )

    assert_service_error(raised.value, status, code, message)
    assert guidance not in str(raised.value)
    assert fakes.models[0].steer_calls == [guidance]
    await manager.delete(created.session_id)


async def test_cancel_is_not_blocked_by_in_flight_steer_and_remains_authoritative(
    tmp_path: Path,
) -> None:
    steer_blocker = asyncio.Event()
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=Fakes(
            steer_blocker=steer_blocker,
            steer_error=PipelineApplicationAgentError(
                "command_conflict",
                "The application state changed; review the latest session state",
            ),
        ),
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    model = fakes.models[0]

    steer_task = asyncio.create_task(
        manager.command(
            created.session_id,
            SteerCommand(type="steer", message="do not retain me"),
        )
    )
    await model.steer_started.wait()
    await asyncio.wait_for(
        manager.command(created.session_id, CancelCommand(type="cancel")),
        timeout=1,
    )
    assert not steer_task.done()

    steer_blocker.set()
    with pytest.raises(HarnessServiceError) as raised:
        await steer_task
    assert_service_error(
        raised.value,
        409,
        "command_conflict",
        "The application state changed; review the latest session state",
    )
    await record.closed_event.wait()
    assert manager.get_snapshot(created.session_id).state == "cancelled"

async def test_gate_commands_conflict_while_steering_dispatch_is_in_flight(
    tmp_path: Path,
) -> None:
    steer_blocker = asyncio.Event()
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=Fakes(steer_blocker=steer_blocker),
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    navigation = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanNavigationRuntimeAction(
                type="request_human_navigation",
                instruction="Complete the public checkpoint.",
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "navigation")
    steering = asyncio.create_task(
        manager.command(
            created.session_id,
            SteerCommand(type="steer", message="retry the current action"),
        )
    )
    await asyncio.wait_for(fakes.models[0].steer_started.wait(), timeout=1)

    with pytest.raises(HarnessServiceError) as raised:
        await manager.command(created.session_id, ContinueCommand(type="continue"))
    assert_service_error(
        raised.value,
        409,
        "command_conflict",
        "The application state changed; review the latest session state",
    )
    assert record.human_gate.pending_kind == "navigation"
    assert not navigation.done()

    steer_blocker.set()
    await steering
    assert record.human_gate.pending_kind is None
    assert isinstance(await navigation, InterruptedRuntimeActionResponse)
    await manager.delete(created.session_id)

async def test_new_gate_can_steer_while_superseded_steer_is_unresolved(
    tmp_path: Path,
) -> None:
    steer_blocker = asyncio.Event()
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=Fakes(steer_blocker=steer_blocker),
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    old_steering = asyncio.create_task(
        manager.command(
            created.session_id,
            SteerCommand(type="steer", message="guidance for the running step"),
        )
    )
    await asyncio.wait_for(fakes.models[0].steer_started.wait(), timeout=1)
    navigation = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanNavigationRuntimeAction(
                type="request_human_navigation",
                instruction="Complete the new public checkpoint.",
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "navigation")

    new_steering = asyncio.create_task(
        manager.command(
            created.session_id,
            SteerCommand(type="steer", message="guidance for the new gate"),
        )
    )
    await wait_until(lambda: len(fakes.models[0].steer_calls) == 2)
    steer_blocker.set()

    with pytest.raises(HarnessServiceError) as raised:
        await old_steering
    assert_service_error(
        raised.value,
        409,
        "command_conflict",
        "The application state changed; review the latest session state",
    )
    await new_steering
    assert fakes.models[0].steer_calls == [
        "guidance for the running step",
        "guidance for the new gate",
    ]
    assert isinstance(await navigation, InterruptedRuntimeActionResponse)
    await manager.delete(created.session_id)


async def test_final_submit_waits_for_superseded_steering_dispatch(
    tmp_path: Path,
) -> None:
    steer_blocker = asyncio.Event()
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=Fakes(steer_blocker=steer_blocker),
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    old_steering = asyncio.create_task(
        manager.command(
            created.session_id,
            SteerCommand(type="steer", message="guidance for the running step"),
        )
    )
    await asyncio.wait_for(fakes.models[0].steer_started.wait(), timeout=1)
    review = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanReviewRuntimeAction(
                type="request_human_review",
                result=review_result(),
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "review")

    with pytest.raises(HarnessServiceError) as raised:
        await manager.command(created.session_id, SubmitCommand(type="submit"))
    assert_service_error(
        raised.value,
        409,
        "command_conflict",
        "The application state changed; review the latest session state",
    )
    assert record.human_gate.submission_approved is False

    steer_blocker.set()
    with pytest.raises(HarnessServiceError) as stale:
        await old_steering
    assert_service_error(
        stale.value,
        409,
        "command_conflict",
        "The application state changed; review the latest session state",
    )
    await manager.command(created.session_id, SubmitCommand(type="submit"))
    assert isinstance(await review, SubmitRuntimeActionResponse)
    assert record.human_gate.submission_approved is True
    await manager.delete(created.session_id)

@pytest.mark.parametrize(
    ("job_url", "opportunity_kind", "origins"),
    [
        ("not-a-url", "job", []),
        (JOB_URL, "internship", []),
        (JOB_URL, "job", ["https://ats.example/path"]),
        (JOB_URL, "job", ["https://jobs.example"]),
    ],
    ids=[
        "job-url",
        "opportunity-kind",
        "origin",
        "duplicate-origin",
    ],
)
async def test_invalid_create_values_fail_before_storage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    job_url: str,
    opportunity_kind: Any,
    origins: list[str],
) -> None:
    storage_called = False

    async def forbidden_storage(*_args: Any, **_kwargs: Any) -> None:
        nonlocal storage_called
        storage_called = True
        raise AssertionError("storage must not run")

    monkeypatch.setattr(sessions_module, "store_uploads", forbidden_storage)
    manager, fakes, root = make_manager(tmp_path, blocked_runner)
    personal, resume, resume_source = valid_uploads()

    with pytest.raises(HarnessServiceError) as caught:
        await manager.create_session(
            job_url=job_url,
            opportunity_kind=opportunity_kind,
            allow_domains=origins,
            personal_information=personal,
            resume=resume,
            resume_source=resume_source,
            context=[],
            anecdotes=[],
        )

    assert_service_error(caught.value, 422, "invalid_request", "Request is invalid")
    assert storage_called is False
    assert fakes.models == []
    assert fakes.runtimes == []
    assert not root.exists()


async def test_preflight_completes_before_playwright_runtime_and_create_contract_is_public_safe(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order: list[str] = []
    frozen_now = datetime(2026, 7, 21, 12, 0, tzinfo=UTC)
    monkeypatch.setattr(sessions_module, "_now", lambda: frozen_now)
    runner_started = asyncio.Event()

    async def runner(
        request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        runner_started.set()
        await step(1, f"{request.session.job_url}&email={PROFILE_SECRET}")
        await asyncio.Future()
        raise AssertionError("unreachable")

    manager, fakes, _root = make_manager(tmp_path, runner, fakes=Fakes(order=order))
    await manager._user_info_store.merge(
        JOB_URL,
        (
            AdditionalInfoTextQuestion(
                id="saved_path",
                key="privacy.saved_path",
                scope="global",
                question="Saved path value?",
                answer_type="text",
            ),
        ),
        (
            AdditionalInfoTextCommandAnswer(
                id="saved_path",
                status="answered",
                raw_value="openings",
                value="openings",
            ),
        ),
    )
    response = await create_valid(manager)
    snapshot = manager.get_snapshot(response.session_id)

    assert response.state == "starting"
    assert response.events_url == f"http://127.0.0.1:8765/v1/sessions/{response.session_id}/events"
    assert response.commands_url == f"http://127.0.0.1:8765/v1/sessions/{response.session_id}/commands"
    assert order[:2] == ["model.check_ready", "runtime.factory"]
    assert snapshot.state == "starting"
    assert snapshot.job_url == "https://jobs.example/[redacted]/42"
    assert snapshot.approved_origins == ["https://jobs.example"]
    assert snapshot.expires_at is None

    await asyncio.wait_for(runner_started.wait(), timeout=1)
    await wait_until(lambda: len(only_session(manager).events) >= 2)  # type: ignore[union-attr]
    record = only_session(manager)
    assert record is not None
    assert record.deadline_monotonic is None
    assert record.ttl_task is None
    assert [event.event for event in list(record.events)[:2]] == [
        "session_started",
        "agent_step",
    ]
    assert [event.id for event in record.events] == list(range(1, len(record.events) + 1))
    events = tuple(record.events)
    assert all(
        previous.session.updated_at < current.session.updated_at
        for previous, current in zip(events, events[1:])
    )
    public = json.dumps(
        {
            "snapshot": manager.get_snapshot(response.session_id).model_dump(mode="json"),
            "events": [event.model_dump(mode="json") for event in record.events],
        }
    )
    assert PROFILE_SECRET not in public
    assert "openings" not in public
    assert "candidate=private-secret" not in public
    assert "answer=private" not in public
    assert decode_frame(sessions_module._sse_frame(record.events[-1]))["detail"] == {
        "step_number": 1,
        "current_url": "https://jobs.example/[redacted]/42",
    }

    await manager.delete(response.session_id)
    assert fakes.runtimes[0].closed
    assert fakes.models[0].closed


@pytest.mark.parametrize(
    ("code", "message", "status"),
    [
        ("oauth_required", "Connect OpenAI Codex in Provider access", 409),
        ("pipeline_unavailable", "The local pipeline model service is unavailable", 503),
    ],
)
async def test_preflight_errors_cleanup_before_playwright_runtime_factory(
    tmp_path: Path, code: str, message: str, status: int
) -> None:
    fakes = Fakes(ready_error=PipelineApplicationAgentError(code, message))
    manager, fakes, root = make_manager(tmp_path, blocked_runner, fakes=fakes)

    with pytest.raises(HarnessServiceError) as caught:
        await create_valid(manager)

    assert_service_error(caught.value, status, code, message)
    assert fakes.runtimes == []
    assert fakes.models[0].closed
    assert only_session(manager) is None
    assert not root.exists() or tuple(root.iterdir()) == ()


async def test_runtime_start_session_timeout_preserves_timeout_failure(
    tmp_path: Path,
) -> None:
    session_id = UUID("18e0c59f-5808-437b-b508-f2411b08fca5")
    fakes = Fakes(
        runtime_start_error=PlaywrightCliRuntimeError("session_timeout")
    )
    manager, fakes, root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=fakes,
    )

    with pytest.raises(HarnessServiceError) as caught:
        await create_valid(manager, session_id=session_id)

    assert_service_error(
        caught.value,
        504,
        "session_timeout",
        SESSION_ERROR_MESSAGES["session_timeout"],
    )
    tombstone = manager._tombstones[session_id]
    assert tombstone.snapshot.state == "failed"
    assert tombstone.snapshot.error is not None
    assert tombstone.snapshot.error.model_dump() == {
        "code": "session_timeout",
        "message": SESSION_ERROR_MESSAGES["session_timeout"],
    }
    assert fakes.runtimes[0].closed
    assert fakes.models[0].closed
    assert only_session(manager) is None
    assert not root.exists() or tuple(root.iterdir()) == ()


async def test_manager_accepts_three_concurrent_application_sessions(
    tmp_path: Path,
) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    session_ids = (
        UUID("b37751ec-9b70-48ab-b3ea-604619ad9189"),
        UUID("d5a68755-0720-46b9-9d04-e715905e1db7"),
        UUID("b9861051-ea95-4bea-a923-3d6bbd9143b1"),
    )

    try:
        for session_id in session_ids:
            created = await create_valid(manager, session_id=session_id)
            assert created.session_id == session_id
        for session_id in session_ids:
            await wait_state(manager, session_id, "running")

        with pytest.raises(HarnessServiceError) as at_capacity:
            await create_valid(
                manager,
                session_id=UUID("fd617e2e-8c8c-479c-a775-da481a621815"),
            )
        assert_service_error(
            at_capacity.value,
            409,
            "session_capacity",
            "Browser application session capacity is full",
        )
    finally:
        await manager.shutdown()


async def test_capacity_api_returns_fixed_conflict(tmp_path: Path) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    for _ in range(3):
        await create_valid(manager)
    app = create_app(
        HarnessConfig(bearer_token=TOKEN),
        HarnessDependencies(sessions=manager, gmail_auth=_UNUSED_GMAIL_AUTH),
    )
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    try:
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://harness.test",
        ) as client:
            response = await client.post(
                "/v1/sessions",
                files=[
                    ("session_id", (None, str(uuid4()))),
                    *multipart_parts(),
                ],
                headers=AUTHORIZATION,
            )

        assert response.status_code == 409
        assert response.json() == {
            "code": "session_capacity",
            "message": "Browser application session capacity is full",
        }
    finally:
        await manager.shutdown()


async def test_omitted_session_id_uses_uuid4(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    generated = UUID("c92fc1d7-b6fc-45fd-a288-f2aa2572e5bb")
    monkeypatch.setattr(sessions_module, "uuid4", lambda: generated)
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)

    created = await create_valid(manager)

    assert created.session_id == generated
    await manager.delete(generated)


async def test_same_active_caller_id_replays_create_without_uploads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested = UUID("69a8263f-910a-46a0-8098-9c5975722e1c")
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    first = await create_valid(manager, session_id=requested)
    await wait_state(manager, requested, "running")
    storage_called = False

    async def forbidden_storage(*_args: Any, **_kwargs: Any) -> None:
        nonlocal storage_called
        storage_called = True
        raise AssertionError("idempotent create must not reprocess uploads")

    monkeypatch.setattr(sessions_module, "store_uploads", forbidden_storage)
    replayed = await create_valid(manager, session_id=requested)

    assert replayed == first
    assert storage_called is False
    await manager.delete(requested)


async def test_same_starting_caller_id_replays_before_setup_completes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested = UUID("ad6977a1-2a39-4437-af6e-1f168c82df5f")
    release_preflight = asyncio.Event()
    fakes = Fakes(check_blocker=release_preflight)
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=fakes,
    )
    first_task = asyncio.create_task(
        create_valid(manager, session_id=requested)
    )
    await wait_until(lambda: len(fakes.models) == 1)
    await asyncio.wait_for(fakes.models[0].check_started.wait(), timeout=1)
    storage_called = False

    async def forbidden_storage(*_args: Any, **_kwargs: Any) -> None:
        nonlocal storage_called
        storage_called = True
        raise AssertionError("idempotent create must not reprocess uploads")

    monkeypatch.setattr(sessions_module, "store_uploads", forbidden_storage)
    replayed = await create_valid(manager, session_id=requested)

    assert replayed.session_id == requested
    assert first_task.done() is False
    assert storage_called is False
    release_preflight.set()
    assert await first_task == replayed
    await manager.delete(requested)


async def test_tombstoned_caller_id_is_a_distinct_conflict_without_uploads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested = UUID("88b30bc7-53c6-4393-8c93-9efb99e156cf")
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    await create_valid(manager, session_id=requested)
    await manager.delete(requested)
    storage_called = False

    async def forbidden_storage(*_args: Any, **_kwargs: Any) -> None:
        nonlocal storage_called
        storage_called = True
        raise AssertionError("terminal create must not reprocess uploads")

    monkeypatch.setattr(sessions_module, "store_uploads", forbidden_storage)
    with pytest.raises(HarnessServiceError) as caught:
        await create_valid(manager, session_id=requested)

    assert_service_error(
        caught.value,
        409,
        "session_terminal",
        "The application session has already ended",
    )
    assert storage_called is False
    app = create_app(
        HarnessConfig(bearer_token=TOKEN),
        HarnessDependencies(sessions=manager, gmail_auth=_UNUSED_GMAIL_AUTH),
    )
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://harness.test",
    ) as client:
        response = await client.post(
            "/v1/sessions",
            files=[
                ("session_id", (None, str(requested))),
                *multipart_parts(),
            ],
            headers=AUTHORIZATION,
        )
    assert response.status_code == 409
    assert response.json() == {
        "code": "session_terminal",
        "message": "The application session has already ended",
    }
    assert storage_called is False


async def test_navigation_origin_auto_submission_and_resource_retention(
    tmp_path: Path,
) -> None:
    submission_executed = asyncio.Event()

    async def runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        gate: HumanGate,
        step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await step(1, f"https://jobs.example/openings/42?email={PROFILE_SECRET}")
        navigation = await gate.request_human_navigation(
            f"Complete verification for {PROFILE_SECRET}", playwright_runtime
        )
        if navigation.is_done:
            return CancelledApplicationResult.model_validate_json(
                navigation.extracted_content
            )
        review = await gate.request_human_review(review_result(), playwright_runtime)
        if review.is_done:
            return CancelledApplicationResult.model_validate_json(
                review.extracted_content
            )
        assert review.long_term_memory == "You're good to submit."
        await submission_executed.wait()
        return submitted_result(revision_count=gate.revision_count)

    manager, fakes, root = make_manager(tmp_path, runner)
    created = await create_valid(manager, auto_submit=True)
    await wait_state(manager, created.session_id, "awaiting_human_navigation")
    record = only_session(manager)
    assert record is not None and record.playwright_runtime is not None and record.human_gate is not None
    navigation_snapshot = manager.get_snapshot(created.session_id)
    assert navigation_snapshot.pending_action is not None
    assert navigation_snapshot.pending_action.model_dump(mode="json") == {
        "type": "human_navigation",
        "instruction": "Complete verification for [redacted]",
    }
    navigation_replay = manager._replay_events(
        navigation_snapshot,
        tuple(record.events),
        999,
    )[0].session
    assert navigation_replay.pending_action == navigation_snapshot.pending_action
    assert navigation_replay.expires_at == navigation_snapshot.expires_at
    record.playwright_runtime.current_url = "https://ats.example/application/42?token=private"

    await manager.command(created.session_id, ContinueCommand(type="continue"))
    await wait_until(
        lambda: record.human_gate is not None
        and record.human_gate.submission_approved
    )
    with pytest.raises(HarnessServiceError) as disabled_origin_command:
        await manager.command(
            created.session_id,
            ApproveOriginCommand(
                type="approve_origin",
                origin="https://ats.example",
            ),
        )
    assert disabled_origin_command.value.code == "command_conflict"
    review_snapshot = manager.get_snapshot(created.session_id)
    assert review_snapshot.state == "running"
    assert review_snapshot.pending_action is None
    assert review_snapshot.company == "Example Corp"
    assert review_snapshot.revision_count == 0
    with pytest.raises(HarnessServiceError) as revise:
        await manager.command(
            created.session_id,
            ReviseCommand(type="revise", context="Use a corrected project example"),
        )
    assert revise.value.code == "command_conflict"
    with pytest.raises(HarnessServiceError) as submit:
        await manager.command(created.session_id, SubmitCommand(type="submit"))
    assert submit.value.code == "command_conflict"
    submission_response = await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="click",
            args=["button#submit"],
        ),
    )
    assert isinstance(submission_response, PlaywrightCliResultRuntimeActionResponse)
    submission_executed.set()
    await wait_state(manager, created.session_id, "submitted")
    assert manager.get_snapshot(created.session_id).pending_action is None
    assert all(
        event.session.pending_action is None
        for event in record.events
        if event.event in {
            "session_started",
            "agent_step",
            "revision_applied",
            "submission_started",
            "application_submitted",
        }
    )

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.revision_count == 0
    assert snapshot.approved_origins == ["https://jobs.example", "https://ats.example"]
    assert record.human_gate.approved_origins == (
        "https://jobs.example",
        "https://ats.example",
    )
    assert record.playwright_runtime.approved_origins == (
        "https://jobs.example",
        "https://ats.example",
    )
    event_names = [event.event for event in record.events]
    assert event_names == [
        "session_started",
        "agent_step",
        "human_navigation_required",
        "snapshot",
        "submission_started",
        "agent_step",
        "application_submitted",
    ]
    assert [event.id for event in record.events] == list(range(1, 8))
    assert record.events[4].session.pending_action is None
    public_events = json.dumps([event.model_dump(mode="json") for event in record.events])
    assert PROFILE_SECRET not in public_events
    assert "token=private" not in public_events
    assert "Application received." not in public_events
    assert record.playwright_runtime.closed is False
    assert record.model is not None and record.model.closed is False
    assert record.stored is not None and record.stored.session_directory.exists()
    assert any(root.iterdir())

    with pytest.raises(HarnessServiceError) as submitted_command:
        await manager.command(created.session_id, CancelCommand(type="cancel"))
    assert submitted_command.value.code == "command_conflict"
    with pytest.raises(HarnessServiceError) as submitted_runtime:
        await runtime_action(
            manager,
            created.session_id,
            PlaywrightCliRuntimeAction(type="playwright_cli", command="eval", args=["console.log('late')"]),
        )
    assert submitted_runtime.value.code == "command_conflict"

    await manager.delete(created.session_id)
    assert manager.get_snapshot(created.session_id).pending_action is None


async def test_delete_orders_gate_runner_resources_artifacts_event_and_slot_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    order: list[str] = []
    original_cleanup = sessions_module.cleanup_session_artifacts
    original_gate_cancel = HumanGate.cancel

    async def observed_gate_cancel(gate: HumanGate) -> None:
        order.append("gate.cancel")
        await original_gate_cancel(gate)

    def observed_cleanup(path: Path) -> None:
        original_cleanup(path)
        order.append("artifacts.cleanup")

    monkeypatch.setattr(sessions_module, "cleanup_session_artifacts", observed_cleanup)
    monkeypatch.setattr(HumanGate, "cancel", observed_gate_cancel)

    async def gated_runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        try:
            action = await gate.request_human_navigation("Continue in the browser", playwright_runtime)
            return CancelledApplicationResult.model_validate_json(
                action.extracted_content
            )
        finally:
            order.append("runner.done")

    manager, fakes, _root = make_manager(
        tmp_path, gated_runner, fakes=Fakes(order=order)
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "awaiting_human_navigation")
    record = only_session(manager)
    assert record is not None and record.stored is not None
    artifact_directory = record.stored.session_directory
    original_publish = manager._publish_event

    async def observed_publish(
        current_record: Any, event: str, detail: dict[str, object]
    ) -> None:
        if event == "closed":
            assert only_session(manager) is current_record
            assert current_record.snapshot.slot_released is True
            assert not artifact_directory.exists()
            order.append("event.closed")
        await original_publish(current_record, event, detail)

    manager._publish_event = observed_publish  # type: ignore[method-assign]

    await manager.delete(created.session_id)

    assert order.index("gate.cancel") < order.index("runner.done")
    assert order.index("runner.done") < order.index("runtime.close")
    assert order.index("runtime.close") < order.index("model.aclose")
    assert order.index("model.aclose") < order.index("artifacts.cleanup")
    assert order.index("artifacts.cleanup") < order.index("event.closed")
    assert not artifact_directory.exists()
    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "closed" and snapshot.error is None
    assert snapshot.slot_released is True
    tombstone = manager._tombstones[created.session_id]
    assert tombstone.events[-1].event == "closed"
    assert only_session(manager) is None
    assert fakes.runtimes[0].closed and fakes.models[0].closed
    assert fakes.runtimes[0].closed

    event_count = len(tombstone.events)
    await manager.delete(created.session_id)
    assert len(manager._tombstones[created.session_id].events) == event_count

    manager._publish_event = original_publish  # type: ignore[method-assign]

    replacement = await create_valid(manager)
    assert replacement.session_id != created.session_id
    await manager.delete(replacement.session_id)


async def test_terminal_event_is_published_before_tombstone_exposure(
    tmp_path: Path,
) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    last_event_id = record.events[-1].id
    original_publish = manager._publish_event
    terminal_publish_started = asyncio.Event()
    allow_terminal_publish = asyncio.Event()

    async def blocked_publish(
        current_record: Any, event: str, detail: dict[str, object]
    ) -> None:
        if event == "closed":
            terminal_publish_started.set()
            await allow_terminal_publish.wait()
        await original_publish(current_record, event, detail)

    manager._publish_event = blocked_publish  # type: ignore[method-assign]
    deletion = asyncio.create_task(manager.delete(created.session_id))
    stream = None
    next_frame: asyncio.Task[str] | None = None
    try:
        await asyncio.wait_for(terminal_publish_started.wait(), timeout=1)
        assert only_session(manager) is record
        assert created.session_id not in manager._tombstones

        stream = manager.stream_events(created.session_id, last_event_id)
        next_frame = asyncio.create_task(anext(stream))
        await asyncio.sleep(0)
        assert next_frame.done() is False

        allow_terminal_publish.set()
        payload = decode_frame(await asyncio.wait_for(next_frame, timeout=1))
        assert payload["event"] == "closed"
        await asyncio.wait_for(deletion, timeout=1)
    finally:
        allow_terminal_publish.set()
        if not deletion.done():
            await asyncio.wait_for(deletion, timeout=1)
        if next_frame is not None and not next_frame.done():
            next_frame.cancel()
            await asyncio.gather(next_frame, return_exceptions=True)
        if stream is not None:
            await stream.aclose()

    tombstone = manager._tombstones[created.session_id]
    assert tombstone.events[-1].event == "closed"



async def test_suggestions_cannot_read_saved_answers_after_finalization_starts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    assert record.human_gate is not None
    question = AdditionalInfoTextQuestion(
        id="availability",
        key="availability.summer_2027",
        scope="global",
        question="What dates are available?",
        answer_type="text",
    )

    def pending_question(
        _gate: HumanGate,
        _question_id: str,
    ) -> AdditionalInfoTextQuestion:
        return question

    monkeypatch.setattr(
        HumanGate,
        "get_pending_text_question",
        pending_question,
    )

    saved_answers_read = False

    def tracked_suggestions(*_args: object, **_kwargs: object) -> object:
        nonlocal saved_answers_read
        saved_answers_read = True
        return ()

    monkeypatch.setattr(
        type(manager._user_info_store),
        "suggestions",
        tracked_suggestions,
    )
    original_publish = manager._publish_event
    terminal_publish_started = asyncio.Event()
    allow_terminal_publish = asyncio.Event()

    async def blocked_publish(
        current_record: Any, event: str, detail: dict[str, object]
    ) -> None:
        if event == "closed":
            terminal_publish_started.set()
            await allow_terminal_publish.wait()
        await original_publish(current_record, event, detail)

    manager._publish_event = blocked_publish  # type: ignore[method-assign]
    deletion = asyncio.create_task(manager.delete(created.session_id))
    suggestions: asyncio.Task[Any] | None = None
    try:
        await asyncio.wait_for(terminal_publish_started.wait(), timeout=1)
        suggestions = asyncio.create_task(
            manager.get_additional_info_suggestions(
                created.session_id,
                "availability",
            )
        )
        await asyncio.sleep(0)
        assert suggestions.done() is False
        assert saved_answers_read is False

        allow_terminal_publish.set()
        await asyncio.wait_for(deletion, timeout=1)
        with pytest.raises(HarnessServiceError) as raised:
            await suggestions
        assert_service_error(
            raised.value,
            409,
            "command_conflict",
            "A terminal command is already pending",
        )
        assert saved_answers_read is False
    finally:
        allow_terminal_publish.set()
        if not deletion.done():
            await asyncio.wait_for(deletion, timeout=1)
        if suggestions is not None and not suggestions.done():
            suggestions.cancel()
            await asyncio.gather(suggestions, return_exceptions=True)


@pytest.mark.parametrize(
    ("failure", "expected_code"),
    [
        (
            PipelineApplicationAgentError(
                "application_mismatch",
                SESSION_ERROR_MESSAGES["application_mismatch"],
            ),
            "application_mismatch",
        ),
        (
            PipelineApplicationAgentError(
                "oauth_required", SESSION_ERROR_MESSAGES["oauth_required"]
            ),
            "oauth_required",
        ),
        (
            PipelineApplicationAgentError(
                "model_timeout", SESSION_ERROR_MESSAGES["model_timeout"]
            ),
            "model_timeout",
        ),
        (
            PipelineApplicationAgentError(
                "invalid_model_output", SESSION_ERROR_MESSAGES["invalid_model_output"]
            ),
            "invalid_model_output",
        ),
        (
            PipelineApplicationAgentError(
                "model_failed", SESSION_ERROR_MESSAGES["model_failed"]
            ),
            "model_failed",
        ),
        (RuntimeError("raw provider secret must not escape"), "browser_failed"),
    ],
    ids=[
        "mismatch",
        "oauth",
        "model-timeout",
        "invalid-model-output",
        "model-failed",
        "unexpected",
    ],
)
async def test_runner_failure_mappings_are_sanitized_and_cleanup(
    tmp_path: Path, failure: Exception, expected_code: str
) -> None:
    async def failing_runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        raise failure

    manager, fakes, _root = make_manager(tmp_path, failing_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "failed")

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.error is not None
    assert snapshot.error.model_dump() == {
        "code": expected_code,
        "message": SESSION_ERROR_MESSAGES[expected_code],
    }
    public = snapshot.model_dump_json()
    assert "raw provider secret" not in public
    assert fakes.runtimes[0].closed and fakes.models[0].closed
    assert only_session(manager) is None
    assert manager._tombstones[created.session_id].events[-1].event == "failed"


async def test_cancelled_runner_result_has_no_error_and_releases_slot(tmp_path: Path) -> None:
    async def cancelled_runner(
        request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        return CancelledApplicationResult(
            status="cancelled",
            job_url=request.session.job_url,
            final_url=request.session.job_url,
            company=PROFILE_SECRET,
            role=f"Role {PROFILE_SECRET}",
            fields_filled=[
                {
                    "label": "Secret payload",
                    "field_type": "text",
                    "value_present": True,
                    "note": PROFILE_SECRET,
                }
            ],
            warnings=[PROFILE_SECRET],
            submit_attempted=False,
            submission_confirmation=None,
        )

    manager, fakes, _root = make_manager(tmp_path, cancelled_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "cancelled")
    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.error is None
    assert snapshot.company is None
    assert snapshot.role is None
    assert snapshot.fields_filled == []
    assert snapshot.warnings == []
    assert PROFILE_SECRET not in snapshot.model_dump_json()
    assert manager._tombstones[created.session_id].events[-1].event == "cancelled"
    assert only_session(manager) is None
    assert fakes.runtimes[0].closed and fakes.models[0].closed


async def test_cancel_command_interrupts_active_model_call_before_cleanup(tmp_path: Path) -> None:
    order: list[str] = []

    async def model_runner(
        _request: ApplicationRunRequest,
        model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await model.active_call()
        raise AssertionError("unreachable")

    manager, fakes, _root = make_manager(
        tmp_path, model_runner, fakes=Fakes(order=order)
    )
    created = await create_valid(manager)
    await asyncio.wait_for(fakes.models[0].active_started.wait(), timeout=1)

    await manager.command(created.session_id, CancelCommand(type="cancel"))
    await wait_state(manager, created.session_id, "cancelled")

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "cancelled" and snapshot.error is None
    assert fakes.models[0].active_finished.is_set()
    assert order.index("model.active_finished") < order.index("runtime.close")
    assert order.index("runtime.close") < order.index("model.aclose")


async def test_delete_during_blocked_preflight_cancels_setup_and_cleans_without_playwright_runtime(
    tmp_path: Path,
) -> None:
    blocker = asyncio.Event()
    fakes = Fakes(check_blocker=blocker)
    manager, fakes, root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(fakes.models) and fakes.models[0].check_started.is_set())
    record = only_session(manager)
    assert record is not None

    await manager.delete(record.session_id)

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)
    assert fakes.runtimes == []
    assert fakes.models[0].closed
    assert manager.get_snapshot(record.session_id).state == "closed"
    assert manager._tombstones[record.session_id].events[-1].event == "closed"
    assert only_session(manager) is None
    await manager.delete(record.session_id)
    assert manager.get_snapshot(record.session_id).state == "closed"
    assert not root.exists() or tuple(root.iterdir()) == ()


async def test_absolute_ttl_maps_to_session_timeout_without_real_sleep(tmp_path: Path) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, timeout=1)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.ttl_task is not None
    record.ttl_task.cancel()
    record.deadline_monotonic = asyncio.get_running_loop().time() - 1

    await manager._expire_session(record)
    await wait_state(manager, created.session_id, "failed")

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "failed"
    assert snapshot.error is not None
    assert snapshot.error.model_dump() == {
        "code": "session_timeout",
        "message": "The application session expired",
    }
    await asyncio.wait_for(record.closed_event.wait(), timeout=1)
    assert fakes.runtimes[0].closed and fakes.models[0].closed


async def test_expiry_cannot_publish_after_concurrent_delete_tombstones_session(
    tmp_path: Path,
) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner, timeout=60)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.ttl_task is not None
    record.ttl_task.cancel()
    await asyncio.gather(record.ttl_task, return_exceptions=True)
    record.deadline_monotonic = asyncio.get_running_loop().time() - 1
    record.submission_action_started = True
    original_park = manager._park_submission_uncertain
    allow_park = asyncio.Event()

    async def delayed_park(current_record: Any) -> None:
        await allow_park.wait()
        await original_park(current_record)

    manager._park_submission_uncertain = delayed_park  # type: ignore[method-assign]
    await record.request_lock.acquire()
    deletion = asyncio.create_task(manager.delete(created.session_id))
    await asyncio.sleep(0)
    expiry = asyncio.create_task(manager._expire_session(record))
    await asyncio.sleep(0)
    record.request_lock.release()

    await asyncio.wait_for(deletion, timeout=1)
    terminal_events = tuple(record.events)
    allow_park.set()
    await asyncio.wait_for(expiry, timeout=1)

    assert record.snapshot.state == "closed"
    assert tuple(record.events) == terminal_events
    tombstone = manager._tombstones[created.session_id]
    assert tombstone.snapshot.state == "closed"
    assert tombstone.events == terminal_events

async def test_expired_setup_cannot_publish_running_after_timeout(
    tmp_path: Path,
) -> None:
    preflight_release = asyncio.Event()
    ttl_release = asyncio.Event()
    runtime_close_release = asyncio.Event()
    fakes = Fakes(
        check_blocker=preflight_release,
        runtime_close_blocker=runtime_close_release,
    )
    manager, _fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        fakes=fakes,
        timeout=1,
    )
    expire_session = manager._expire_session

    async def controlled_expiration(record: Any) -> None:
        await ttl_release.wait()
        await expire_session(record)

    manager._expire_session = controlled_expiration  # type: ignore[method-assign]
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(fakes.models) and fakes.models[0].check_started.is_set())
    record = only_session(manager)
    assert record is not None
    record.deadline_monotonic = asyncio.get_running_loop().time() - 1
    ttl_release.set()
    preflight_release.set()
    created = await asyncio.wait_for(creation, timeout=1)

    try:
        await asyncio.sleep(0)
        snapshot = manager.get_snapshot(created.session_id)
        assert snapshot.state == "failed"
        assert snapshot.error is not None
        assert snapshot.error.code == "session_timeout"
        assert snapshot.slot_released is False
        assert [event.event for event in record.events] == ["failed"]
    finally:
        runtime_close_release.set()
        await asyncio.wait_for(record.closed_event.wait(), timeout=1)

    tombstone = manager._tombstones[created.session_id]
    assert tombstone.snapshot.state == "failed"
    assert tombstone.snapshot.slot_released is True
    assert [event.event for event in tombstone.events] == ["failed", "snapshot"]
    assert tombstone.events[-1].session.slot_released is True

async def test_expired_agent_result_cannot_beat_absolute_timeout(
    tmp_path: Path,
) -> None:
    result_release = asyncio.Event()
    ttl_release = asyncio.Event()
    runtime_close_release = asyncio.Event()

    async def runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await result_release.wait()
        return cancelled_result()

    fakes = Fakes(runtime_close_blocker=runtime_close_release)
    manager, _fakes, _root = make_manager(
        tmp_path,
        runner,
        fakes=fakes,
        timeout=1,
    )
    expire_session = manager._expire_session

    async def controlled_expiration(record: Any) -> None:
        await ttl_release.wait()
        await expire_session(record)

    manager._expire_session = controlled_expiration  # type: ignore[method-assign]
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    record.deadline_monotonic = asyncio.get_running_loop().time() - 1
    result_release.set()
    ttl_release.set()

    try:
        await wait_until(lambda: record.final_request is not None)
        assert record.final_request is not None
        assert (
            record.final_request.state,
            record.final_request.error_code,
        ) == ("failed", "session_timeout")
        snapshot = manager.get_snapshot(created.session_id)
        assert snapshot.state == "failed"
        assert snapshot.error is not None
        assert snapshot.error.code == "session_timeout"
        assert [event.event for event in record.events][-1] == "failed"
    finally:
        runtime_close_release.set()
        await asyncio.wait_for(record.closed_event.wait(), timeout=1)

    tombstone = manager._tombstones[created.session_id]
    assert tombstone.snapshot.state == "failed"
    assert tombstone.snapshot.error is not None
    assert tombstone.snapshot.error.code == "session_timeout"

async def test_expired_agent_error_cannot_beat_absolute_timeout(
    tmp_path: Path,
) -> None:
    error_release = asyncio.Event()
    ttl_release = asyncio.Event()

    async def runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await error_release.wait()
        raise PipelineApplicationAgentError(
            "model_timeout",
            SESSION_ERROR_MESSAGES["model_timeout"],
        )

    manager, _fakes, _root = make_manager(
        tmp_path,
        runner,
        timeout=1,
    )
    expire_session = manager._expire_session

    async def controlled_expiration(record: Any) -> None:
        await ttl_release.wait()
        await expire_session(record)

    manager._expire_session = controlled_expiration  # type: ignore[method-assign]
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    record.deadline_monotonic = asyncio.get_running_loop().time() - 1
    error_release.set()
    ttl_release.set()

    await wait_until(lambda: record.final_request is not None)
    assert record.final_request is not None
    assert (
        record.final_request.state,
        record.final_request.error_code,
    ) == ("failed", "session_timeout")
    await asyncio.wait_for(record.closed_event.wait(), timeout=1)
    tombstone = manager._tombstones[created.session_id]
    assert tombstone.snapshot.state == "failed"
    assert tombstone.snapshot.error is not None
    assert tombstone.snapshot.error.code == "session_timeout"


async def test_continue_at_absolute_deadline_fails_before_resuming_gate(
    tmp_path: Path,
) -> None:
    cleanup_blocker = asyncio.Event()
    navigation_resumed = asyncio.Event()

    async def runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        navigation = await gate.request_human_navigation(
            "Complete verification in the browser",
            playwright_runtime,
        )
        if not navigation.is_done:
            navigation_resumed.set()
            await asyncio.Future()
        return CancelledApplicationResult.model_validate_json(
            navigation.extracted_content
        )

    manager, fakes, _root = make_manager(
        tmp_path,
        runner,
        fakes=Fakes(runtime_close_blocker=cleanup_blocker),
        timeout=60,
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "awaiting_human_navigation")
    record = only_session(manager)
    assert record is not None and record.ttl_task is not None
    record.ttl_task.cancel()
    await asyncio.gather(record.ttl_task, return_exceptions=True)
    record.deadline_monotonic = asyncio.get_running_loop().time() - 1

    try:
        with pytest.raises(HarnessServiceError) as caught:
            await manager.command(
                created.session_id,
                ContinueCommand(type="continue"),
            )
        assert_service_error(
            caught.value,
            409,
            "session_terminal",
            "The application session has already ended",
        )
        snapshot = manager.get_snapshot(created.session_id)
        assert snapshot.state == "failed"
        assert snapshot.error is not None
        assert snapshot.error.model_dump() == {
            "code": "session_timeout",
            "message": "The application session expired",
        }
        assert not navigation_resumed.is_set()
        assert record.events[-1].event == "failed"
        assert record.events[-1].session.state == "failed"
        await wait_until(lambda: fakes.runtimes[0].close_started.is_set())
        assert not fakes.runtimes[0].closed
    finally:
        cleanup_blocker.set()
        if record.final_request is None:
            await manager.delete(created.session_id)
        else:
            await asyncio.wait_for(record.closed_event.wait(), timeout=1)

    assert fakes.runtimes[0].closed
    assert manager._tombstones[created.session_id].events[-1].event == "snapshot"
    assert manager._tombstones[created.session_id].snapshot.slot_released is True
    assert sum(
        event.event == "failed"
        for event in manager._tombstones[created.session_id].events
    ) == 1


async def test_submission_action_cannot_start_after_absolute_deadline(
    tmp_path: Path,
) -> None:
    cleanup_blocker = asyncio.Event()
    review_released = asyncio.Event()

    async def runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        review = await gate.request_human_review(review_result(), playwright_runtime)
        if review.is_done:
            return CancelledApplicationResult.model_validate_json(
                review.extracted_content
            )
        review_released.set()
        await asyncio.Future()
        raise AssertionError("unreachable")

    manager, fakes, _root = make_manager(
        tmp_path,
        runner,
        fakes=Fakes(runtime_close_blocker=cleanup_blocker),
        timeout=60,
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "awaiting_human_review")
    await manager.command(created.session_id, SubmitCommand(type="submit"))
    await asyncio.wait_for(review_released.wait(), timeout=1)
    record = only_session(manager)
    assert record is not None and record.ttl_task is not None
    record.ttl_task.cancel()
    await asyncio.gather(record.ttl_task, return_exceptions=True)
    record.deadline_monotonic = asyncio.get_running_loop().time() - 1

    try:
        with pytest.raises(HarnessServiceError) as caught:
            await runtime_action(
                manager,
                created.session_id,
                PlaywrightCliRuntimeAction(type="playwright_cli", command="click", args=["button#submit"]),
            )
        assert_service_error(
            caught.value,
            504,
            "session_timeout",
            "The application session expired",
        )
        assert record.submission_action_started is False
        assert manager.get_snapshot(created.session_id).state == "failed"
        assert [event.event for event in record.events].count("submission_started") == 0
    finally:
        cleanup_blocker.set()
        if record.final_request is None:
            await manager.delete(created.session_id)
        else:
            await asyncio.wait_for(record.closed_event.wait(), timeout=1)

    assert manager.get_snapshot(created.session_id).state == "failed"


async def test_shutdown_finalizes_active_session_and_rejects_new_sessions(tmp_path: Path) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")

    await manager.shutdown()

    assert manager.get_snapshot(created.session_id).state == "closed"
    assert manager._tombstones[created.session_id].events[-1].event == "closed"
    assert fakes.runtimes[0].closed and fakes.models[0].closed
    personal, resume, resume_source = valid_uploads()
    with pytest.raises(HarnessServiceError) as caught:
        await manager.create_session(
            job_url=JOB_URL,
            opportunity_kind="job",
            allow_domains=[],
            personal_information=personal,
            resume=resume,
            resume_source=resume_source,
            context=[],
            anecdotes=[],
        )
    assert_service_error(
        caught.value,
        503,
        "service_unavailable",
        "The browser harness is shutting down",
    )


async def test_tombstones_are_bounded_to_32_and_oldest_id_is_evicted(tmp_path: Path) -> None:
    async def immediate_cancelled(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        return cancelled_result()

    manager, _fakes, _root = make_manager(tmp_path, immediate_cancelled)
    session_ids: list[UUID] = []
    for _ in range(33):
        created = await create_valid(manager)
        session_ids.append(created.session_id)
        await wait_state(manager, created.session_id, "cancelled")
        await manager.delete(created.session_id)

    assert len(manager._tombstones) == 32
    assert list(manager._tombstones) == session_ids[1:]
    with pytest.raises(HarnessServiceError) as caught:
        manager.get_snapshot(session_ids[0])
    assert_service_error(caught.value, 404, "session_not_found", "Session was not found")
    assert manager.get_snapshot(session_ids[-1]).state == "closed"


async def test_event_buffer_replay_eviction_snapshot_and_monotonic_ids(tmp_path: Path) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None

    for step in range(1, 301):
        await manager._agent_step(
            record,
            step,
            f"https://jobs.example/openings/42/page/{step}?secret={PROFILE_SECRET}",
        )

    assert len(record.events) == 256
    ids = [event.id for event in record.events]
    assert ids == list(range(46, 302))
    assert all("?" not in event.detail.current_url for event in record.events)  # type: ignore[union-attr]

    replay = manager.stream_events(created.session_id, 300)
    frame = await asyncio.wait_for(anext(replay), timeout=1)
    assert decode_frame(frame)["id"] == 301
    await replay.aclose()

    evicted = manager.stream_events(created.session_id, 0)
    snapshot_frame = await asyncio.wait_for(anext(evicted), timeout=1)
    snapshot_payload = decode_frame(snapshot_frame)
    assert snapshot_payload["event"] == "snapshot"
    assert snapshot_payload["id"] == 301
    assert PROFILE_SECRET not in snapshot_frame
    await evicted.aclose()

    ahead = manager.stream_events(created.session_id, 999)
    assert decode_frame(await asyncio.wait_for(anext(ahead), timeout=1))["event"] == "snapshot"
    await ahead.aclose()
    await manager.delete(created.session_id)


async def test_agent_step_uses_job_url_for_internal_runtime_page(tmp_path: Path) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None

    await manager._agent_step(record, 1, "chrome://newtab/")

    event = record.events[-1]
    assert event.event == "agent_step"
    assert event.detail.step_number == 1  # type: ignore[union-attr]
    assert event.detail.current_url == "https://jobs.example/openings/42"  # type: ignore[union-attr]
    await manager.delete(created.session_id)


async def test_sse_heartbeat_and_disconnect_do_not_cancel_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    latest = record.events[-1].id
    monkeypatch.setattr(sessions_module, "_HEARTBEAT_SECONDS", 0.001)

    stream = manager.stream_events(created.session_id, latest)
    heartbeat = await asyncio.wait_for(anext(stream), timeout=1)
    assert heartbeat == ": heartbeat\n\n"
    await stream.aclose()

    assert only_session(manager) is record
    assert record.agent_task is not None and not record.agent_task.done()
    assert fakes.runtimes[0].closed is False
    await manager.delete(created.session_id)


async def test_api_unknown_and_terminal_command_responses(tmp_path: Path) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    app = create_app(
        HarnessConfig(bearer_token=TOKEN),
        HarnessDependencies(sessions=manager, gmail_auth=_UNUSED_GMAIL_AUTH),
    )
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    unknown_id = uuid4()

    async with httpx.AsyncClient(transport=transport, base_url="http://harness.test") as client:
        unknown_command = await client.post(
            f"/v1/sessions/{unknown_id}/commands",
            json={"type": "cancel"},
            headers=AUTHORIZATION,
        )
        invalid_command = await client.post(
            f"/v1/sessions/{created.session_id}/commands",
            json={"type": "submit"},
            headers=AUTHORIZATION,
        )
        no_pending_gate = await client.post(
            f"/v1/sessions/{created.session_id}/commands",
            json={"type": "ready"},
            headers=AUTHORIZATION,
        )
        await manager.delete(created.session_id)
        terminal_command = await client.post(
            f"/v1/sessions/{created.session_id}/commands",
            json={"type": "cancel"},
            headers=AUTHORIZATION,
        )
        unknown_delete = await client.delete(
            f"/v1/sessions/{unknown_id}", headers=AUTHORIZATION
        )
        known_delete = await client.delete(
            f"/v1/sessions/{created.session_id}", headers=AUTHORIZATION
        )

    assert unknown_command.status_code == 404
    assert unknown_command.json() == {
        "code": "session_not_found",
        "message": "Session was not found",
    }
    assert invalid_command.status_code == 409
    assert invalid_command.json() == {
        "code": "command_conflict",
        "message": "No matching human gate is pending",
    }
    assert no_pending_gate.status_code == 422
    assert no_pending_gate.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }
    assert terminal_command.status_code == 409
    assert terminal_command.json() == {
        "code": "command_conflict",
        "message": "The session is terminal",
    }
    assert unknown_delete.status_code == 404
    assert known_delete.status_code == 204


async def test_duplicate_cancel_conflicts_while_first_finalizer_is_pending(
    tmp_path: Path,
) -> None:
    close_blocker = asyncio.Event()
    fakes = Fakes(runtime_close_blocker=close_blocker)
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")

    await manager.command(created.session_id, CancelCommand(type="cancel"))
    await wait_until(
        lambda: bool(fakes.runtimes) and fakes.runtimes[0].close_started.is_set()
    )
    assert only_session(manager) is not None
    assert manager.get_snapshot(created.session_id).state == "running"
    with pytest.raises(HarnessServiceError) as duplicate:
        await manager.command(created.session_id, CancelCommand(type="cancel"))
    assert_service_error(
        duplicate.value,
        409,
        "command_conflict",
        "A terminal command is already pending",
    )

    close_blocker.set()
    await wait_state(manager, created.session_id, "cancelled")
    assert only_session(manager) is None


async def test_delete_during_natural_finalization_joins_shielded_owner_and_closes(
    tmp_path: Path,
) -> None:
    close_blocker = asyncio.Event()

    async def failing_runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        raise RuntimeError("synthetic runner failure")

    fakes = Fakes(runtime_close_blocker=close_blocker)
    manager, fakes, _root = make_manager(tmp_path, failing_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_until(lambda: fakes.runtimes[0].close_started.is_set())
    record = only_session(manager)
    assert record is not None and record.finalizer_task is not None

    first_delete = asyncio.create_task(manager.delete(created.session_id))
    await asyncio.sleep(0)
    assert not first_delete.done()
    first_delete.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first_delete
    assert record.finalizer_task is not None and not record.finalizer_task.cancelled()

    joined_delete = asyncio.create_task(manager.delete(created.session_id))
    await asyncio.sleep(0)
    assert not joined_delete.done()
    close_blocker.set()
    await asyncio.wait_for(joined_delete, timeout=1)

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "closed" and snapshot.error is None
    assert manager._tombstones[created.session_id].events[-1].event == "closed"


async def test_cleanup_observation_timeouts_do_not_cancel_owned_tasks_or_release_slot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_wait_for = asyncio.wait_for
    original_sleep = asyncio.sleep
    timed_out: set[float] = set()
    observations = 0

    async def observing_wait_for(awaitable: Any, timeout: float) -> Any:
        nonlocal observations
        if timeout == 30:
            observations += 1
            if observations in {1, 3}:
                timed_out.add(timeout)
                await original_sleep(0)
                raise TimeoutError
        return await original_wait_for(awaitable, timeout)

    runtime_close_blocker = asyncio.Event()
    model_close_blocker = asyncio.Event()
    fakes = Fakes(
        runtime_close_blocker=runtime_close_blocker,
        model_close_blocker=model_close_blocker,
    )
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    monkeypatch.setattr(sessions_module.asyncio, "wait_for", observing_wait_for)

    await manager.command(created.session_id, CancelCommand(type="cancel"))
    await original_wait_for(fakes.runtimes[0].close_started.wait(), timeout=1)
    await original_sleep(0)
    record = only_session(manager)
    assert record is not None and record.runtime_close_task is not None
    assert not record.runtime_close_task.cancelled()
    assert fakes.runtimes[0].closed is False

    runtime_close_blocker.set()
    await original_wait_for(fakes.models[0].close_started.wait(), timeout=1)
    await original_sleep(0)
    assert only_session(manager) is record
    assert record.model_close_task is not None
    assert not record.model_close_task.cancelled()
    assert fakes.models[0].closed is False

    model_close_blocker.set()
    await wait_state(manager, created.session_id, "cancelled")
    assert timed_out == {30}
    assert observations == 4
    assert only_session(manager) is None
    assert fakes.runtimes[0].closed and fakes.models[0].closed
    assert fakes.order.count("runtime.close") == 1
    assert fakes.order.count("model.aclose") == 1


async def test_slow_context_process_terminate_is_joined_before_artifact_cleanup(
    tmp_path: Path,
) -> None:
    instances: list[Any] = []

    class ControlledContextProcess:
        def __init__(self, stored: Any) -> None:
            self.candidate = load_candidate_context(stored)
            self.started = asyncio.Event()
            self.terminate_started = asyncio.Event()
            self.allow_terminate = asyncio.Event()
            self.worker_finished = asyncio.Event()
            self.worker_task: asyncio.Task[CandidateContext] | None = None
            instances.append(self)

        async def _worker(self) -> CandidateContext:
            await self.allow_terminate.wait()
            self.worker_finished.set()
            return self.candidate

        async def result(self) -> CandidateContext:
            self.started.set()
            self.worker_task = asyncio.create_task(self._worker())
            return await asyncio.shield(self.worker_task)

        async def terminate(self) -> None:
            self.terminate_started.set()
            await self.allow_terminate.wait()
            assert self.worker_task is not None
            await asyncio.shield(self.worker_task)

    manager, _fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        context_process_factory=ControlledContextProcess,
    )
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(instances) and instances[0].started.is_set())
    process = instances[0]
    record = only_session(manager)
    assert record is not None and record.stored is not None
    artifact_directory = record.stored.session_directory

    deletion = asyncio.create_task(manager.delete(record.session_id))
    await asyncio.wait_for(process.terminate_started.wait(), timeout=1)
    assert not deletion.done()
    assert only_session(manager) is record
    assert artifact_directory.exists()
    process.allow_terminate.set()
    await asyncio.wait_for(deletion, timeout=1)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)

    assert process.worker_finished.is_set()
    assert not artifact_directory.exists()
    assert only_session(manager) is None
    assert manager.get_snapshot(record.session_id).state == "closed"


async def test_absolute_ttl_begins_during_model_preflight_setup(tmp_path: Path) -> None:
    blocker = asyncio.Event()
    fakes = Fakes(check_blocker=blocker)
    manager, fakes, _root = make_manager(
        tmp_path, blocked_runner, fakes=fakes, timeout=1
    )
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(fakes.models) and fakes.models[0].check_started.is_set())
    record = only_session(manager)
    assert record is not None and record.ttl_task is not None
    record.ttl_task.cancel()
    record.deadline_monotonic = asyncio.get_running_loop().time() - 1

    await manager._expire_session(record)
    with pytest.raises(HarnessServiceError) as expired:
        await asyncio.wait_for(creation, timeout=1)
    assert_service_error(
        expired.value,
        504,
        "session_timeout",
        "The application session expired",
    )
    await wait_state(manager, record.session_id, "failed")
    assert manager.get_snapshot(record.session_id).error is not None
    assert manager.get_snapshot(record.session_id).error.code == "session_timeout"
    assert fakes.runtimes == []
    await asyncio.wait_for(record.closed_event.wait(), timeout=1)
    assert fakes.models[0].closed


async def test_cancel_while_starting_publishes_terminal_tombstone_then_delete_is_idempotent(
    tmp_path: Path,
) -> None:
    blocker = asyncio.Event()
    fakes = Fakes(check_blocker=blocker)
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(fakes.models) and fakes.models[0].check_started.is_set())
    record = only_session(manager)
    assert record is not None

    await manager.command(record.session_id, CancelCommand(type="cancel"))
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)
    await wait_state(manager, record.session_id, "cancelled")
    tombstone = manager._tombstones[record.session_id]
    assert tombstone.events[-1].event == "cancelled"
    assert only_session(manager) is None

    await manager.delete(record.session_id)
    await manager.delete(record.session_id)
    assert manager.get_snapshot(record.session_id).state == "closed"
    assert manager._tombstones[record.session_id].events[-1].event == "closed"


async def test_repeated_starting_delete_cancellation_does_not_cancel_cleanup(
    tmp_path: Path,
) -> None:
    preflight_blocker = asyncio.Event()
    close_blocker = asyncio.Event()
    fakes = Fakes(
        check_blocker=preflight_blocker,
        model_close_blocker=close_blocker,
    )
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(fakes.models) and fakes.models[0].check_started.is_set())
    record = only_session(manager)
    assert record is not None

    first_delete = asyncio.create_task(manager.delete(record.session_id))
    await asyncio.wait_for(fakes.models[0].close_started.wait(), timeout=1)
    first_delete.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first_delete
    assert record.finalizer_task is not None and not record.finalizer_task.cancelled()
    assert only_session(manager) is record

    second_delete = asyncio.create_task(manager.delete(record.session_id))
    await asyncio.sleep(0)
    second_delete.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second_delete
    assert record.finalizer_task is not None and not record.finalizer_task.cancelled()

    final_delete = asyncio.create_task(manager.delete(record.session_id))
    close_blocker.set()
    await asyncio.wait_for(final_delete, timeout=1)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)
    assert manager.get_snapshot(record.session_id).state == "closed"
    assert only_session(manager) is None


async def test_direct_values_literal_and_url_encoded_are_redacted_from_paths(
    tmp_path: Path,
) -> None:
    encoded_secret = "ada.private%40example.test"
    private_job_url = (
        f"https://jobs.example/openings/{encoded_secret}/literal-{PROFILE_SECRET}"
        "?candidate=private"
    )

    async def stepping_runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await step(
            1,
            f"https://jobs.example/application/{PROFILE_SECRET}/{encoded_secret}?private=yes",
        )
        await asyncio.Future()
        raise AssertionError("unreachable")

    manager, _fakes, _root = make_manager(tmp_path, stepping_runner)
    personal, resume, resume_source = valid_uploads()
    created = await manager.create_session(
        job_url=private_job_url,
        opportunity_kind="job",
        allow_domains=[],
        personal_information=personal,
        resume=resume,
        resume_source=resume_source,
        context=[],
        anecdotes=[],
    )
    await wait_until(
        lambda: only_session(manager) is not None and len(only_session(manager).events) >= 2
    )
    record = only_session(manager)
    assert record is not None
    public = json.dumps(
        {
            "snapshot": manager.get_snapshot(created.session_id).model_dump(mode="json"),
            "events": [event.model_dump(mode="json") for event in record.events],
        }
    )
    assert PROFILE_SECRET not in public
    assert encoded_secret not in public
    assert "candidate=private" not in public
    assert "private=yes" not in public
    assert public.count("redacted") >= 4
    await manager.delete(created.session_id)


async def test_concurrent_cancel_commands_are_serialized_by_request_lock(
    tmp_path: Path,
) -> None:
    close_blocker = asyncio.Event()
    fakes = Fakes(runtime_close_blocker=close_blocker)
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")

    results = await asyncio.gather(
        manager.command(created.session_id, CancelCommand(type="cancel")),
        manager.command(created.session_id, CancelCommand(type="cancel")),
        return_exceptions=True,
    )
    assert sum(result is None for result in results) == 1
    conflicts = [result for result in results if isinstance(result, HarnessServiceError)]
    assert len(conflicts) == 1
    assert_service_error(
        conflicts[0],
        409,
        "command_conflict",
        "A terminal command is already pending",
    )
    assert only_session(manager) is not None
    close_blocker.set()
    await wait_state(manager, created.session_id, "cancelled")


async def test_delete_closes_session_that_moves_from_active_to_tombstone_mid_request(
    tmp_path: Path,
) -> None:
    runner_release = asyncio.Event()

    async def naturally_cancelled(
        request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await runner_release.wait()
        return CancelledApplicationResult(
            status="cancelled",
            job_url=request.session.job_url,
            final_url=request.session.job_url,
            submit_attempted=False,
            submission_confirmation=None,
        )

    manager, _fakes, _root = make_manager(tmp_path, naturally_cancelled)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    original_request = manager._request_terminal
    delete_entered = asyncio.Event()
    allow_delete = asyncio.Event()

    async def delayed_request(
        record: Any,
        request: Any,
        *,
        wait: bool,
        duplicate_ok: bool,
    ) -> None:
        if request.state == "closed":
            delete_entered.set()
            await allow_delete.wait()
        await original_request(
            record,
            request,
            wait=wait,
            duplicate_ok=duplicate_ok,
        )

    manager._request_terminal = delayed_request  # type: ignore[method-assign]
    deletion = asyncio.create_task(manager.delete(created.session_id))
    await asyncio.wait_for(delete_entered.wait(), timeout=1)
    runner_release.set()
    await wait_until(lambda: created.session_id in manager._tombstones)
    assert manager.get_snapshot(created.session_id).state == "cancelled"
    allow_delete.set()
    await asyncio.wait_for(deletion, timeout=1)

    tombstone = manager._tombstones[created.session_id]
    assert tombstone.snapshot.state == "closed"
    assert [event.event for event in tombstone.events][-2:] == ["cancelled", "closed"]


async def test_pending_cleanup_false_blocks_terminal_publish_and_slot_release(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_sleep = asyncio.sleep
    allow_cleanup = asyncio.Event()
    cleanup_calls = 0

    def pending_cleanup() -> bool | None:
        nonlocal cleanup_calls
        cleanup_calls += 1
        return None if allow_cleanup.is_set() else False

    async def no_delay(_delay: float) -> None:
        await original_sleep(0)

    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    monkeypatch.setattr(sessions_module, "retry_pending_cleanup", pending_cleanup)
    monkeypatch.setattr(sessions_module.asyncio, "sleep", no_delay)
    await manager.command(created.session_id, CancelCommand(type="cancel"))

    await wait_until(lambda: cleanup_calls > 0)
    assert only_session(manager) is not None
    assert created.session_id not in manager._tombstones
    allow_cleanup.set()
    await wait_state(manager, created.session_id, "cancelled")
    assert only_session(manager) is None


@pytest.mark.parametrize(
    ("resource", "operation"),
    [
        ("playwright_runtime", "delete"),
        ("playwright_runtime", "shutdown"),
        ("model", "delete"),
        ("model", "shutdown"),
    ],
)
async def test_transient_cleanup_failure_retries_while_retaining_ownership(
    tmp_path: Path,
    resource: str,
    operation: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_sleep = asyncio.sleep

    async def no_delay(_delay: float) -> None:
        await original_sleep(0)

    blocker = asyncio.Event()
    fakes = Fakes(
        runtime_close_failures=1 if resource == "playwright_runtime" else 0,
        runtime_close_blocker=blocker if resource == "playwright_runtime" else None,
        model_close_failures=1 if resource == "model" else 0,
        model_close_blocker=blocker if resource == "model" else None,
    )
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    monkeypatch.setattr(sessions_module.asyncio, "sleep", no_delay)
    record = only_session(manager)
    assert record is not None

    caller = asyncio.create_task(
        manager.delete(created.session_id)
        if operation == "delete"
        else manager.shutdown()
    )
    cleanup_name = "runtime.close" if resource == "playwright_runtime" else "model.aclose"
    await wait_until(lambda: fakes.order.count(cleanup_name) >= 2)

    assert not caller.done()
    assert record.finalizer_task is not None and not record.finalizer_task.done()
    assert only_session(manager) is record
    assert created.session_id not in manager._tombstones
    assert manager.get_snapshot(created.session_id).state == "running"
    blocker.set()
    await asyncio.wait_for(caller, timeout=1)

    assert fakes.order.count(cleanup_name) == 2
    assert only_session(manager) is None
    assert manager.get_snapshot(created.session_id).state == "closed"
    assert manager._tombstones[created.session_id].events[-1].event == "closed"


async def test_create_session_uses_latex_source_as_resume_evidence_and_pdf_for_upload(
    tmp_path: Path,
) -> None:
    latex_source = (
        b"\\documentclass{article}\n"
        b"\\begin{document}\n"
        b"Exact approved LaTeX evidence.\n"
        b"\\end{document}\n"
    )
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    app = create_app(
        HarnessConfig(bearer_token=TOKEN),
        HarnessDependencies(sessions=manager, gmail_auth=_UNUSED_GMAIL_AUTH),
    )
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://harness.test",
    ) as client:
        response = await client.post(
            "/v1/sessions",
            headers=AUTHORIZATION,
            files=[
                *(part for part in multipart_parts() if part[0] != "resume_source"),
                (
                    "resume_source",
                    ("Alex_Example_Resume.tex", latex_source, "text/x-tex"),
                ),
            ],
        )

    assert response.status_code == 202
    created = response.json()
    session_id = UUID(created["session_id"])
    await wait_state(manager, session_id, "running")
    record = only_session(manager)
    assert record is not None
    assert record.stored is not None
    assert record.application_task is not None
    task = json.loads(record.application_task)
    stored_resume = record.stored.resume.path

    assert task["evidence"][0] == {
        "category": "resume",
        "name": "Alex_Example_Resume.tex",
        "text": latex_source.decode("utf-8"),
    }
    assert Path(task["job"]["resume"]["path"]) == stored_resume
    assert task["job"]["resume"]["display_name"] == "resume.pdf"
    assert stored_resume.read_bytes() == pdf_bytes()

    await manager.delete(session_id)


@pytest.mark.parametrize(
    ("source_name", "source_content"),
    [
        ("resume.txt", b"not latex"),
        ("resume.tex", b""),
        ("resume.tex", b"\xff"),
        ("resume.tex", b"x" * (APPLICATION_RESUME_SOURCE_MAX_BYTES + 1)),
    ],
    ids=["wrong-extension", "empty", "invalid-utf8", "over-byte-limit"],
)
async def test_create_session_rejects_invalid_resume_source_with_fixed_error(
    tmp_path: Path,
    source_name: str,
    source_content: bytes,
) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    app = create_app(
        HarnessConfig(bearer_token=TOKEN),
        HarnessDependencies(sessions=manager, gmail_auth=_UNUSED_GMAIL_AUTH),
    )
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)

    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://harness.test",
    ) as client:
        response = await client.post(
            "/v1/sessions",
            headers=AUTHORIZATION,
            files=[
                *(part for part in multipart_parts() if part[0] != "resume_source"),
                (
                    "resume_source",
                    (source_name, source_content, "text/x-tex"),
                ),
            ],
        )

    assert response.status_code == 422
    assert response.json() == {
        "code": "invalid_request",
        "message": "Request is invalid",
    }


async def test_application_task_preserves_absolute_stored_resume_path(
    tmp_path: Path,
) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)

    assert record is not None
    assert record.stored is not None
    assert record.application_task is not None
    stored_resume = record.stored.resume.path
    task = json.loads(record.application_task)
    task_resume = Path(task["job"]["resume"]["path"])
    assert stored_resume.is_absolute()
    assert task_resume == stored_resume

    await manager.delete(created.session_id)


async def test_mixed_encoded_path_redaction_preserves_scheme_and_authority(
    tmp_path: Path,
) -> None:
    personal = upload(
        "profile.md",
        (
            "---\n"
            "full_name: Ada Lovelace\n"
            f"email: {PROFILE_SECRET}\n"
            "city: A\n"
            "---\nProfile.\n"
        ).encode(),
    )
    resume = upload("resume.pdf", pdf_bytes())
    resume_source = upload("resume.tex", b"Resume evidence")
    encoded_secret = "ada.private%252525252540example.test"
    job_url = (
        f"https://a.example/Apply/%252525252541/{encoded_secret}/{PROFILE_SECRET}"
        "?private=yes"
    )

    async def stepping(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await step(
            1,
            f"https://a.example/Apply/%41/{encoded_secret}/{PROFILE_SECRET}?secret=yes",
        )
        await asyncio.Future()
        raise AssertionError("unreachable")

    manager, _fakes, _root = make_manager(tmp_path, stepping)
    created = await manager.create_session(
        job_url=job_url,
        opportunity_kind="job",
        allow_domains=[],
        personal_information=personal,
        resume=resume,
        resume_source=resume_source,
        context=[],
        anecdotes=[],
    )
    await wait_until(
        lambda: only_session(manager) is not None and len(only_session(manager).events) >= 2
    )
    record = only_session(manager)
    assert record is not None
    snapshot = manager.get_snapshot(created.session_id)
    payload = json.dumps(
        {
            "snapshot": snapshot.model_dump(mode="json"),
            "events": [event.model_dump(mode="json") for event in record.events],
        }
    )
    assert snapshot.job_url.startswith("https://a.example/")
    assert all(
        event.detail.current_url.startswith("https://a.example/")
        for event in record.events
        if event.event == "agent_step"
    )
    assert PROFILE_SECRET not in payload
    assert "ada.private%40example.test" not in payload
    assert "%2540" not in payload
    assert "%2541" not in payload
    assert "private=yes" not in payload and "secret=yes" not in payload
    assert "https://redacted.example" not in payload
    await manager.delete(created.session_id)


async def test_encoded_gate_result_and_file_values_project_actionable_warnings(
    tmp_path: Path,
) -> None:
    raw_secret = "ada.private%40example.test"
    normalized_secret = "ada.private@example.test"
    encoded_secret = "ada.private%25252540example.test"
    private_job_url = f"https://jobs.example/openings/{encoded_secret}?private=yes"
    expected_warnings = [
        "Confirm the portfolio URL before submitting.",
        "Account [redacted] needs a final review.",
    ]
    def private_result() -> ReviewApplicationResult:
        return ReviewApplicationResult(
            status="ready_for_submission",
            company=encoded_secret,
            role=raw_secret,
            job_url=private_job_url,
            final_url=private_job_url,
            fields_filled=[
                {
                    "label": encoded_secret,
                    "field_type": "text",
                    "value_present": True,
                    "note": normalized_secret,
                }
            ],
            files_attached=[f"{encoded_secret}.pdf"],
            warnings=[
                "Confirm the portfolio URL before submitting.",
                f"Account {encoded_secret} needs a final review.",
            ],
            submit_attempted=False,
        )

    async def gated(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        navigation = await gate.request_human_navigation(encoded_secret, playwright_runtime)
        assert not navigation.is_done
        review = await gate.request_human_review(private_result(), playwright_runtime)
        assert not review.is_done
        await asyncio.Future()
        raise AssertionError("unreachable")

    manager, _fakes, _root = make_manager(tmp_path, gated)
    personal = upload(
        "profile.md",
        (
            "---\n"
            "full_name: Ada Lovelace\n"
            f"email: {raw_secret}\n"
            "---\nProfile.\n"
        ).encode(),
    )
    created = await manager.create_session(
        job_url=private_job_url,
        opportunity_kind="job",
        allow_domains=[],
        auto_submit=True,
        personal_information=personal,
        resume=upload("resume.pdf", pdf_bytes()),
        resume_source=upload("resume.tex", b"Resume evidence"),
        context=[],
        anecdotes=[],
    )
    await wait_state(manager, created.session_id, "awaiting_human_navigation")
    await manager.command(created.session_id, ContinueCommand(type="continue"))
    await wait_until(
        lambda: only_session(manager) is not None
        and only_session(manager).human_gate is not None
        and only_session(manager).human_gate.submission_approved
    )
    review_snapshot = manager.get_snapshot(created.session_id)
    assert review_snapshot.company == "[redacted]"
    assert review_snapshot.role == "[redacted]"
    assert review_snapshot.fields_filled[0].label == "[redacted]"
    assert review_snapshot.fields_filled[0].note == "Filled"
    assert review_snapshot.files_attached == ["resume.pdf"]
    assert review_snapshot.warnings == expected_warnings
    record = only_session(manager)
    assert record is not None
    public = json.dumps(
        {
            "snapshot": manager.get_snapshot(created.session_id).model_dump(mode="json"),
            "events": [event.model_dump(mode="json") for event in record.events],
        }
    )
    assert expected_warnings[0] in public
    assert expected_warnings[1] in public
    assert raw_secret not in public
    assert normalized_secret not in public
    assert encoded_secret not in public
    assert "private=yes" not in public
    await manager.delete(created.session_id)


async def test_candidate_context_process_returns_valid_context_and_closes(
    tmp_path: Path,
) -> None:
    personal, resume, resume_source = valid_uploads()
    session_id = uuid4()
    stored = await store_uploads(
        tmp_path,
        session_id,
        personal,
        resume,
        resume_source,
        [],
        [],
    )
    process = CandidateContextProcess(stored)
    try:
        candidate = await asyncio.wait_for(process.result(), timeout=10)
        assert candidate.direct_fields["email"] == PROFILE_SECRET
        assert candidate.resume_text == "\\documentclass{article}\nResume evidence.\n"
        assert process._closed is True
    finally:
        await asyncio.wait_for(process.terminate(), timeout=1)
        cleanup_session_artifacts(stored.session_directory)


async def test_candidate_context_process_terminate_joins_hung_receive_worker() -> None:
    release = asyncio.Event()

    class FakeReceiver:
        def close(self) -> None:
            release.set()

    class FakeProcess:
        def __init__(self) -> None:
            self.alive = True
            self.terminated = False
            self.closed = False

        def is_alive(self) -> bool:
            return self.alive

        def terminate(self) -> None:
            self.terminated = True
            self.alive = False

        def join(self, _timeout: float) -> None:
            return

        def kill(self) -> None:
            self.alive = False

        def close(self) -> None:
            self.closed = True

    async def hung_receive() -> object:
        await release.wait()
        raise EOFError

    process = object.__new__(CandidateContextProcess)
    fake_process = FakeProcess()
    process._receiver = FakeReceiver()
    process._process = fake_process
    process._receive_task = asyncio.create_task(hung_receive())
    process._closed = False

    await asyncio.wait_for(process.terminate(), timeout=1)
    assert fake_process.terminated is True
    assert fake_process.closed is True
    assert process._receive_task.done()
    assert process._closed is True


async def test_context_terminate_failure_retries_before_other_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_sleep = asyncio.sleep
    instances: list[Any] = []

    async def no_delay(_delay: float) -> None:
        await original_sleep(0)

    class RetryContextProcess:
        def __init__(self, stored: Any) -> None:
            self.started = asyncio.Event()
            self.calls = 0
            self.release = asyncio.Event()
            instances.append(self)

        async def result(self) -> CandidateContext:
            self.started.set()
            await asyncio.Future()
            raise AssertionError("unreachable")

        async def terminate(self) -> None:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("synthetic context cleanup failure")
            await self.release.wait()

    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        context_process_factory=RetryContextProcess,
    )
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(instances) and instances[0].started.is_set())
    record = only_session(manager)
    assert record is not None and record.stored is not None
    artifact_directory = record.stored.session_directory
    monkeypatch.setattr(sessions_module.asyncio, "sleep", no_delay)
    deletion = asyncio.create_task(manager.delete(record.session_id))
    await wait_until(lambda: instances[0].calls >= 2)

    assert not deletion.done()
    assert only_session(manager) is record
    assert artifact_directory.exists()
    assert fakes.runtimes == []
    assert fakes.models == []
    instances[0].release.set()
    await asyncio.wait_for(deletion, timeout=1)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)
    assert instances[0].calls == 2
    assert not artifact_directory.exists()
    assert only_session(manager) is None
    assert manager.get_snapshot(record.session_id).state == "closed"
    assert manager._tombstones[record.session_id].events[-1].event == "closed"


async def test_shutdown_upgrades_active_to_terminal_race_tombstone_to_closed(
    tmp_path: Path,
) -> None:
    runner_release = asyncio.Event()

    async def naturally_cancelled(
        request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await runner_release.wait()
        return CancelledApplicationResult(
            status="cancelled",
            job_url=request.session.job_url,
            final_url=request.session.job_url,
            submit_attempted=False,
            submission_confirmation=None,
        )

    manager, _fakes, _root = make_manager(tmp_path, naturally_cancelled)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    original_request = manager._request_terminal
    shutdown_entered = asyncio.Event()
    allow_shutdown = asyncio.Event()

    async def delayed_request(
        record: Any,
        request: Any,
        *,
        wait: bool,
        duplicate_ok: bool,
    ) -> None:
        if request.state == "closed":
            shutdown_entered.set()
            await allow_shutdown.wait()
        await original_request(
            record,
            request,
            wait=wait,
            duplicate_ok=duplicate_ok,
        )

    manager._request_terminal = delayed_request  # type: ignore[method-assign]
    shutdown = asyncio.create_task(manager.shutdown())
    await asyncio.wait_for(shutdown_entered.wait(), timeout=1)
    runner_release.set()
    await wait_until(lambda: created.session_id in manager._tombstones)
    assert manager.get_snapshot(created.session_id).state == "cancelled"
    allow_shutdown.set()
    await asyncio.wait_for(shutdown, timeout=1)

    tombstone = manager._tombstones[created.session_id]
    assert tombstone.snapshot.state == "closed"
    assert [event.event for event in tombstone.events][-2:] == ["cancelled", "closed"]


async def test_runtime_playwright_cli_actions_have_no_count_limit(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    personal, resume, resume_source = valid_uploads()
    created = await manager.create_session(
        job_url=JOB_URL,
        opportunity_kind="job",
        allow_domains=[],
        personal_information=personal,
        resume=resume,
        resume_source=resume_source,
        context=[],
        anecdotes=[],
    )
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    runtime = FakePlaywrightRuntime()
    record.playwright_runtime = runtime
    action = PlaywrightCliRuntimeAction(
        type="playwright_cli",
        command="snapshot",
        args=[],
    )

    for _attempt in range(501):
        result = await runtime_action(manager, created.session_id, action)
        assert isinstance(result, PlaywrightCliResultRuntimeActionResponse)

    assert record.playwright_cli_action_count == 501
    assert runtime.commands == [("snapshot", [])] * 501
    assert runtime.closed is False
    step = record.events[-1]
    assert step.event == "agent_step"
    assert step.detail.step_number == 501
    diagnostics = manager.get_snapshot(
        created.session_id
    ).playwright_cli_diagnostics
    assert [diagnostic.step for diagnostic in diagnostics] == list(range(402, 502))
    await manager.delete(created.session_id)


async def test_runtime_action_separates_public_and_model_results(
    tmp_path: Path,
) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    private_url = (
        f"https://jobs.example/openings/{PROFILE_SECRET}?candidate=private"
    )
    execution = playwright_execution_result(private_url)
    execution = execution.model_copy(
        update={
            "stdout": f"output {PROFILE_SECRET}",
            "stderr": f"stderr {PROFILE_SECRET}",
            "observation": execution.observation.model_copy(
                update={
                    "title": f"Application {PROFILE_SECRET}",
                    "tabs": [
                        BrowserTab(
                            url=private_url,
                            title=f"Application {PROFILE_SECRET}",
                            tab_id="tab-1",
                        ),
                        BrowserTab(
                            url="about:blank",
                            title="Empty tab",
                            tab_id="tab-2",
                        ),
                    ],
                    "dom": f"Application form for {PROFILE_SECRET}",
                    "page_info": {"url": private_url},
                }
            ),
        }
    )
    record.playwright_runtime = FakePlaywrightRuntime(result=execution)

    action = PlaywrightCliRuntimeAction(
        type="playwright_cli",
        command="snapshot",
        args=[],
    )
    response = await manager.runtime_action(created.session_id, action)

    assert isinstance(response, PlaywrightCliResultRuntimeActionResponse)
    assert response.observation.url == "https://jobs.example/openings/[redacted]"
    assert response.observation.tabs[0].url == response.observation.url
    assert response.observation.tabs[1].url == "about:blank"
    assert response.observation.page_info is None
    serialized = response.model_dump_json()
    assert PROFILE_SECRET not in serialized
    assert "candidate=private" not in serialized

    private_response = await manager.runtime_model_action(
        created.session_id,
        action,
    )
    private_serialized = private_response.model_dump_json()
    assert PROFILE_SECRET in private_serialized
    assert "candidate=private" in private_serialized
    assert private_response.observation.page_info == {"url": private_url}
    public_events = "".join(event.model_dump_json() for event in record.events)
    assert PROFILE_SECRET not in public_events
    assert "candidate=private" not in public_events
    await manager.delete(created.session_id)


async def test_runtime_playwright_cli_result_rebounds_expanded_redactions(
    tmp_path: Path,
) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    private_value = "x"
    created = await create_valid(manager, full_name=private_value)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    private_url = f"https://jobs.example/{private_value * 4_000}"
    execution = PlaywrightCliExecutionResult(
        exit_code=0,
        stdout=private_value * 20_000,
        stderr=private_value * 20_000,
        stdout_truncated=False,
        stderr_truncated=False,
        observation=BrowserObservation(
            url=private_url,
            title=private_value * 4_096,
            tabs=[
                BrowserTab(
                    url=private_url,
                    title=private_value * 4_096,
                    tab_id="tab-1",
                ),
            ],
            dom=private_value * 40_000,
            page_info=None,
            screenshot=None,
        ),
    )
    record.playwright_runtime = FakePlaywrightRuntime(result=execution)

    response = await manager.runtime_action(
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )

    assert isinstance(response, PlaywrightCliResultRuntimeActionResponse)
    assert response.observation.url == "https://jobs.example"
    assert len(response.observation.url) <= 4_096
    assert response.observation.tabs[0].url == response.observation.url
    step = record.events[-1]
    assert step.event == "agent_step"
    assert step.detail.current_url == response.observation.url
    assert private_value * 2 not in response.observation.url
    for value in (response.stdout, response.stderr):
        assert len(value) == 20_000
        assert private_value not in value
    assert response.stdout_truncated
    assert response.stderr_truncated
    for value, maximum in (
        (response.observation.title, 4_096),
        (response.observation.tabs[0].title, 4_096),
        (response.observation.dom, 40_000),
    ):
        assert len(value) == maximum
        assert private_value not in value
        assert value.endswith("…")
    await manager.delete(created.session_id)


@pytest.mark.parametrize(
    ("error_code", "status_code"),
    [
        ("browser_failed", 502),
        ("session_timeout", 504),
    ],
)
async def test_runtime_human_navigation_maps_guard_suspension_runtime_errors(
    tmp_path: Path,
    error_code: Literal["browser_failed", "session_timeout"],
    status_code: int,
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None
    runtime = fakes.runtimes[0]
    private_error = PlaywrightCliRuntimeError(error_code)
    private_error.args = ("private Playwright guard failure detail",)
    runtime.suspend_navigation_guard_error = private_error
    snapshot_before = record.snapshot
    events_before = tuple(record.events)

    with pytest.raises(HarnessServiceError) as raised:
        await runtime_action(
            manager,
            created.session_id,
            RequestHumanNavigationRuntimeAction(
                type="request_human_navigation",
                instruction="Complete the account sign-in.",
            ),
        )

    assert_service_error(
        raised.value,
        status_code,
        error_code,
        SESSION_ERROR_MESSAGES[error_code],
    )
    assert "private Playwright guard failure detail" not in str(raised.value)
    assert record.snapshot == snapshot_before
    assert tuple(record.events) == events_before
    assert record.human_gate.pending_kind is None
    assert record.runtime_action_task is None
    await manager.delete(created.session_id)


async def test_runtime_playwright_cli_errors_keep_monotonic_steps(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    personal, resume, resume_source = valid_uploads()
    created = await manager.create_session(
        job_url=JOB_URL,
        opportunity_kind="job",
        allow_domains=[],
        personal_information=personal,
        resume=resume,
        resume_source=resume_source,
        context=[],
        anecdotes=[],
    )
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    runtime = FakePlaywrightRuntime(error=PlaywrightCliRuntimeError("browser_failed"))
    record.playwright_runtime = runtime
    action = PlaywrightCliRuntimeAction(
        type="playwright_cli",
        command="snapshot",
        args=[],
    )

    for _attempt in range(3):
        with pytest.raises(HarnessServiceError) as raised:
            await runtime_action(manager, created.session_id, action)
        assert raised.value.code == "browser_failed"

    assert record.playwright_cli_action_count == 3
    assert runtime.commands == [("snapshot", [])] * 3
    assert [
        diagnostic.step
        for diagnostic in manager.get_snapshot(
            created.session_id
        ).playwright_cli_diagnostics
    ] == [1, 2, 3]
    assert runtime.closed is False
    await manager.delete(created.session_id)


async def test_runtime_playwright_cli_action_persists_only_redacted_process_diagnostics(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    record.playwright_runtime = FakePlaywrightRuntime(
        result=playwright_execution_result().model_copy(
            update={
                "exit_code": 7,
                "stderr": "private selector and provider detail",
                "stderr_truncated": True,
            }
        )
    )

    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(type="playwright_cli", command="eval", args=["console.log('private code')"]),
    )

    diagnostics = manager.get_snapshot(created.session_id).playwright_cli_diagnostics
    assert [item.model_dump() for item in diagnostics] == [
        {
            "step": 1,
            "status": "failed",
            "exit_code": 7,
            "error_category": "process_exit",
            "stderr_excerpt": "[redacted]",
            "stderr_truncated": True,
        }
    ]
    serialized = manager.get_snapshot(created.session_id).model_dump_json()
    assert "private selector" not in serialized
    assert "private code" not in serialized
    await manager.delete(created.session_id)
    assert (
        manager._tombstones[created.session_id]
        .snapshot.playwright_cli_diagnostics
        == diagnostics
    )


async def test_runtime_playwright_cli_action_persists_fixed_runtime_error_diagnostic(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    record.playwright_runtime = FakePlaywrightRuntime(
        error=PlaywrightCliRuntimeError("browser_failed")
    )

    with pytest.raises(HarnessServiceError) as raised:
        await runtime_action(
            manager,
            created.session_id,
            PlaywrightCliRuntimeAction(
                type="playwright_cli",
                command="eval",
                args=["console.log('private code')"],
            ),
        )

    assert raised.value.code == "browser_failed"
    diagnostics = manager.get_snapshot(
        created.session_id
    ).playwright_cli_diagnostics
    assert [item.model_dump() for item in diagnostics] == [
        {
            "step": 1,
            "status": "failed",
            "exit_code": -1,
            "error_category": "browser_runtime",
            "stderr_excerpt": "Browser runtime failed.",
            "stderr_truncated": False,
        }
    ]
    assert (
        "private code"
        not in manager.get_snapshot(created.session_id).model_dump_json()
    )
    await manager.delete(created.session_id)


async def test_runtime_additional_info_continue_resumes_same_run_without_persistence(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None
    record.playwright_runtime = FakePlaywrightRuntime()
    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(type="playwright_cli", command="snapshot", args=[]),
    )
    store_path = tmp_path / "user-info.json"
    store_before = store_path.read_bytes()
    pending = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestAdditionalInfoRuntimeAction(
                type="request_additional_info",
                questions=[
                    AdditionalInfoTextQuestion(
                        id="availability",
                        key="availability.summer_2027",
                        scope="global",
                        question="What dates are you available?",
                        answer_type="text",
                    )
                ],
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "additional_info")

    with pytest.raises(HarnessServiceError) as navigation_continue:
        await manager.command(
            created.session_id,
            ContinueCommand(type="continue"),
        )
    assert_service_error(
        navigation_continue.value,
        409,
        "command_conflict",
        "No matching human gate is pending",
    )
    assert pending.done() is False
    assert manager.get_snapshot(created.session_id).state == "awaiting_additional_info"

    await manager.command(
        created.session_id,
        ContinueWithoutAdditionalInfoCommand(
            type="continue_without_additional_info"
        ),
    )
    response = await pending

    assert response == ContinueWithoutAdditionalInfoRuntimeActionResponse(
        type="continue_without_additional_info"
    )
    assert only_session(manager) is record
    assert record.session_id == created.session_id
    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "running"
    assert snapshot.pending_action is None
    assert record.human_gate.pending_kind is None
    assert store_path.read_bytes() == store_before
    assert all(event.event != "additional_info_saved" for event in record.events)
    await manager.delete(created.session_id)


async def test_runtime_additional_info_requires_playwright_cli_then_resumes_same_run(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None
    record.playwright_runtime = FakePlaywrightRuntime()
    private_question = f"What dates are available for {PROFILE_SECRET}?"
    action = RequestAdditionalInfoRuntimeAction(
        type="request_additional_info",
        questions=[
            AdditionalInfoTextQuestion(
                id="availability",
                key="availability.summer_2027",
                scope="global",
                question=private_question,
                answer_type="text",
            ),
            AdditionalInfoSingleSelectQuestion(
                id="referral",
                key="referral.source",
                scope="application",
                question="How did you hear about this role?",
                answer_type="single_select",
                options=[
                    AdditionalInfoOption(id="friend", label="A friend"),
                    AdditionalInfoOption(id="board", label="Job board"),
                ],
            ),
            AdditionalInfoBooleanQuestion(
                id="sponsorship",
                key="authorization.sponsorship_required",
                scope="global",
                question="Will you require sponsorship?",
                answer_type="boolean",
            ),
            AdditionalInfoMultiSelectQuestion(
                id="work_modes",
                key="preferences.work_modes",
                scope="application",
                question="Which work modes are acceptable?",
                answer_type="multi_select",
                options=[
                    AdditionalInfoOption(id="remote", label="Remote"),
                    AdditionalInfoOption(id="hybrid", label="Hybrid"),
                    AdditionalInfoOption(id="office", label="Office"),
                ],
            ),
            AdditionalInfoTextQuestion(
                id="salary",
                key="compensation.minimum",
                scope="application",
                question="What minimum salary do you require?",
                answer_type="text",
            ),
        ],
    )

    with pytest.raises(HarnessServiceError) as before_playwright_runtime:
        await runtime_action(manager, created.session_id, action)
    assert_service_error(
        before_playwright_runtime.value,
        409,
        "command_conflict",
        "Inspect the application before requesting additional information",
    )

    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(type="playwright_cli", command="snapshot", args=[]),
    )
    pending = asyncio.create_task(
        runtime_action(manager, created.session_id, action)
    )
    await wait_until(lambda: record.human_gate.pending_kind == "additional_info")
    assert manager.get_snapshot(created.session_id).state == "awaiting_additional_info"
    required = record.events[-1]
    assert required.event == "additional_info_required"
    assert [question.id for question in required.detail.questions] == [
        "availability",
        "referral",
        "sponsorship",
        "work_modes",
        "salary",
    ]
    assert required.detail.questions[0].question == private_question
    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.pending_action is not None
    assert snapshot.pending_action.model_dump(mode="json") == {
        "type": "additional_info",
        "questions": [
            question.model_dump(mode="json")
            for question in required.detail.questions
        ],
    }
    assert required.session.pending_action == snapshot.pending_action
    additional_info_replay = manager._replay_events(
        snapshot,
        tuple(record.events),
        999,
    )[0].session
    assert additional_info_replay.pending_action == snapshot.pending_action
    assert additional_info_replay.expires_at == snapshot.expires_at
    assert PROFILE_SECRET in additional_info_replay.pending_action.model_dump_json()
    assert (
        await manager.get_additional_info_suggestions(
            created.session_id,
            "availability",
        )
    ).model_dump() == {"suggestions": []}
    for invalid_question_id in ("referral", "stale_question"):
        with pytest.raises(HarnessServiceError) as invalid_suggestions:
            await manager.get_additional_info_suggestions(
                created.session_id,
                invalid_question_id,
            )
        assert_service_error(
            invalid_suggestions.value,
            409,
            "command_conflict",
            "No matching text question is pending",
        )
    previous_store = (tmp_path / "user-info.json").read_bytes()
    with pytest.raises(HarnessServiceError) as partial:
        await manager.command(
            created.session_id,
            ProvideAdditionalInfoCommand(
                type="provide_additional_info",
                answers=[
                    AdditionalInfoTextCommandAnswer(
                        id="availability",
                        status="answered",
                        raw_value="partial raw value",
                        value="partial value",
                    )
                ],
            ),
        )
    assert_service_error(
        partial.value,
        409,
        "command_conflict",
        "The additional-information answers are incomplete",
    )
    assert (tmp_path / "user-info.json").read_bytes() == previous_store
    assert record.human_gate.pending_kind == "additional_info"

    retained_event_ids_before_answers = [
        event.id
        for event in record.events
        if event.event != "additional_info_required"
    ]
    next_event_id_before_answers = record.next_event_id
    events_before_answers = len(record.events)
    raw_answer_value = "free june through august"
    answer_value = "I am available from June through August 2027."
    await manager.command(
        created.session_id,
        ProvideAdditionalInfoCommand(
            type="provide_additional_info",
            answers=[
                AdditionalInfoTextCommandAnswer(
                    id="availability",
                    status="answered",
                    raw_value=raw_answer_value,
                    value=answer_value,
                ),
                AdditionalInfoSingleSelectCommandAnswer(
                    id="referral",
                    status="answered",
                    option_id="friend",
                ),
                AdditionalInfoBooleanCommandAnswer(
                    id="sponsorship",
                    status="answered",
                    value=False,
                ),
                AdditionalInfoMultiSelectCommandAnswer(
                    id="work_modes",
                    status="answered",
                    option_ids=["remote", "hybrid"],
                ),
                AdditionalInfoDeclinedCommandAnswer(
                    id="salary",
                    status="declined",
                ),
            ],
        ),
    )
    response = await pending

    assert response == AdditionalInfoRuntimeActionResponse(
        type="additional_info",
        answers=response.answers,
    )
    assert [answer.value for answer in response.answers] == [
        answer_value,
        "A friend",
        False,
        ["Remote", "Hybrid"],
        None,
    ]
    assert raw_answer_value not in response.model_dump_json()
    public_response = sessions_module._public_runtime_action_response(response)
    assert public_response == ContinueRuntimeActionResponse(type="continue")
    assert answer_value not in public_response.model_dump_json()
    assert manager.get_snapshot(created.session_id).state == "running"
    assert manager.get_snapshot(created.session_id).pending_action is None
    saved = record.events[-1]
    assert saved.event == "additional_info_saved"
    assert saved.detail.count == 5
    retained_events = tuple(record.events)
    assert [event.id for event in retained_events] == [
        *retained_event_ids_before_answers,
        next_event_id_before_answers,
    ]
    assert saved.id == next_event_id_before_answers
    assert all(
        event.event != "additional_info_required" for event in retained_events
    )
    retained_public_data = json.dumps(
        [event.model_dump(mode="json") for event in retained_events]
    )
    assert PROFILE_SECRET not in retained_public_data
    replayed_after_answers = manager._replay_events(
        manager.get_snapshot(created.session_id),
        retained_events,
        None,
    )
    replayed_public_data = json.dumps(
        [event.model_dump(mode="json") for event in replayed_after_answers]
    )
    assert PROFILE_SECRET not in replayed_public_data
    assert all(
        event.event != "additional_info_required"
        for event in replayed_after_answers
    )
    public_data = json.dumps(
        {
            "snapshot": manager.get_snapshot(created.session_id).model_dump(mode="json"),
            "events": [event.model_dump(mode="json") for event in record.events],
        }
    )
    assert answer_value not in public_data
    assert raw_answer_value not in public_data
    assert '"status": "answered"' not in public_data
    post_answer_public_data = json.dumps(
        {
            "snapshot": manager.get_snapshot(created.session_id).model_dump(mode="json"),
            "events": [
                event.model_dump(mode="json")
                for event in tuple(record.events)[events_before_answers:]
            ],
        }
    )
    for accepted_private_value in (
        raw_answer_value,
        answer_value,
        "A friend",
        "Remote",
        "Hybrid",
        '"option_id"',
        '"option_ids"',
        '"answers"',
    ):
        assert accepted_private_value not in post_answer_public_data
    disk = json.loads((tmp_path / "user-info.json").read_text(encoding="utf-8"))
    assert set(disk) == {"version", "global", "applications"}
    assert disk["version"] == 2
    assert set(disk["global"]) == {
        "availability.summer_2027",
        "authorization.sponsorship_required",
    }
    assert set(disk["applications"]) == {JOB_URL}
    assert set(disk["applications"][JOB_URL]) == {
        "referral.source",
        "preferences.work_modes",
        "compensation.minimum",
    }
    assert (
        disk["global"]["availability.summer_2027"]["raw_value"]
        == raw_answer_value
    )
    assert (
        disk["global"]["availability.summer_2027"]["sanitized_value"]
        == answer_value
    )
    assert "value" not in disk["global"]["availability.summer_2027"]
    assert disk["applications"][JOB_URL]["referral.source"]["value"] == "A friend"
    assert disk["global"]["authorization.sponsorship_required"]["value"] is False
    assert disk["applications"][JOB_URL]["preferences.work_modes"]["value"] == [
        "Remote",
        "Hybrid",
    ]
    declined = disk["applications"][JOB_URL]["compensation.minimum"]
    assert declined["status"] == "declined"
    assert "value" not in declined

    with pytest.raises(HarnessServiceError) as stale:
        await manager.command(
            created.session_id,
            ProvideAdditionalInfoCommand(
                type="provide_additional_info",
                answers=[
                    AdditionalInfoTextCommandAnswer(
                        id="availability",
                        status="answered",
                        raw_value="stale raw private value",
                        value="stale final private value",
                    ),
                    AdditionalInfoSingleSelectCommandAnswer(
                        id="referral",
                        status="answered",
                        option_id="friend",
                    ),
                ],
            ),
        )
    assert {
        "stale raw private value",
        "stale final private value",
    } <= record.human_gate.redaction_values
    assert stale.value.code == "command_conflict"
    with pytest.raises(HarnessServiceError) as stale_suggestions:
        await manager.get_additional_info_suggestions(
            created.session_id,
            "availability",
        )
    assert_service_error(
        stale_suggestions.value,
        409,
        "command_conflict",
        "No matching text question is pending",
    )

    record.additional_info_question_count = 99
    with pytest.raises(HarnessServiceError) as over_limit:
        await runtime_action(manager, created.session_id, action)
    assert_service_error(
        over_limit.value,
        409,
        "command_conflict",
        "The additional-information question limit was reached",
    )
    assert record.additional_info_question_count == 99
    await manager.delete(created.session_id)
    tombstone = manager._tombstones[created.session_id]
    tombstone_public_data = json.dumps(
        {
            "snapshot": tombstone.snapshot.model_dump(mode="json"),
            "events": [
                event.model_dump(mode="json") for event in tombstone.events
            ],
        }
    )
    assert PROFILE_SECRET not in tombstone_public_data
    assert all(
        event.event != "additional_info_required"
        for event in tombstone.events
    )


async def test_runtime_action_rejects_concurrency_without_cancelling_active_call(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    blocker = asyncio.Event()
    runtime = FakePlaywrightRuntime(blocker=blocker)
    record.playwright_runtime = runtime
    active = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            PlaywrightCliRuntimeAction(type="playwright_cli", command="eval", args=["console.log('blocked')"]),
        )
    )
    await runtime.started.wait()

    with pytest.raises(HarnessServiceError) as raised:
        await runtime_action(
            manager,
            created.session_id,
            ReportApplicationMismatchRuntimeAction(
                type="report_application_mismatch"
            ),
        )

    assert_service_error(
        raised.value,
        409,
        "command_conflict",
        "A runtime action is already pending",
    )
    assert not active.done()
    blocker.set()
    assert isinstance(await active, PlaywrightCliResultRuntimeActionResponse)
    await manager.delete(created.session_id)


async def test_runtime_action_continues_once_after_requester_cancellation_and_releases_ownership(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    blocker = asyncio.Event()
    runtime = FakePlaywrightRuntime(blocker=blocker)
    record.playwright_runtime = runtime
    action = PlaywrightCliRuntimeAction(
        type="playwright_cli",
        command="snapshot",
        args=[],
    )

    requester = asyncio.create_task(
        manager.runtime_action(created.session_id, action)
    )
    await runtime.started.wait()
    owner = record.runtime_action_task
    assert owner is not None
    assert owner is not requester
    assert not owner.done()
    assert runtime.commands == [("snapshot", [])]

    requester.cancel()
    with pytest.raises(asyncio.CancelledError):
        await requester
    assert not owner.done()

    blocker.set()
    await wait_until(lambda: record.runtime_action_task is None)
    assert runtime.commands == [("snapshot", [])]
    assert record.playwright_cli_action_count == 1

    next_result = await manager.runtime_action(
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="eval",
            args=["() => document.title"],
        ),
    )
    assert isinstance(next_result, PlaywrightCliResultRuntimeActionResponse)
    assert runtime.commands == [
        ("snapshot", []),
        ("eval", ["() => document.title"]),
    ]
    assert record.playwright_cli_action_count == 2
    await manager.delete(created.session_id)




async def test_runtime_navigation_registers_exact_origin_automatically(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert (
        record is not None
        and record.playwright_runtime is not None
        and record.human_gate is not None
    )
    record.playwright_runtime = FakePlaywrightRuntime()

    navigation = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanNavigationRuntimeAction(
                type="request_human_navigation",
                instruction="Complete the hardware-key prompt.",
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "navigation")
    record.playwright_runtime.current_url = "https://ats.example/application/42?private=value"
    await manager.command(created.session_id, ContinueCommand(type="continue"))
    continued = await navigation
    assert isinstance(continued, ContinueRuntimeActionResponse)
    assert manager.get_snapshot(created.session_id).approved_origins == [
        "https://jobs.example",
        "https://ats.example",
    ]
    await manager.delete(created.session_id)


async def test_runtime_review_rejects_a_result_for_another_job_before_gate(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None
    record.playwright_runtime = FakePlaywrightRuntime()
    mismatched_result = review_result().model_copy(
        update={"job_url": "https://other.example/jobs/42"}
    )

    response = await asyncio.wait_for(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanReviewRuntimeAction(
                type="request_human_review",
                result=mismatched_result,
            ),
        ),
        timeout=0.1,
    )

    assert isinstance(response, ApplicationMismatchRuntimeActionResponse)
    assert record.human_gate.pending_kind is None
    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "running"
    assert snapshot.job_url == "https://jobs.example/openings/42"
    await manager.delete(created.session_id)


async def test_runtime_review_auto_approves_explicit_playwright_cli_submission_actions(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager, auto_submit=True)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert (
        record is not None
        and record.playwright_runtime is not None
        and record.human_gate is not None
    )
    first_execution = playwright_execution_result()
    first_execution = first_execution.model_copy(
        update={
            "observation": first_execution.observation.model_copy(
                update={
                    "tabs": [
                        BrowserTab(
                            url=first_execution.observation.url,
                            title="Application",
                            tab_id="tab-1",
                        ),
                        BrowserTab(
                            url="about:blank",
                            title="Empty tab",
                            tab_id="tab-2",
                        ),
                    ]
                }
            )
        }
    )
    second_execution = playwright_execution_result("about:blank")
    runtime = FakePlaywrightRuntime(results=[first_execution, second_execution])
    record.playwright_runtime = runtime

    approved = await asyncio.wait_for(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanReviewRuntimeAction(
                type="request_human_review",
                result=review_result(),
            ),
        ),
        timeout=0.1,
    )
    assert isinstance(approved, SubmitRuntimeActionResponse)
    assert approved.instruction == "You're good to submit."
    assert approved.result.status == "ready_for_submission"
    assert approved.result.revision_count == 0
    assert record.human_gate.pending_kind is None
    assert record.human_gate.submission_approved is True
    assert manager.get_snapshot(created.session_id).state == "running"


    navigation = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanNavigationRuntimeAction(
                type="request_human_navigation",
                instruction="Complete the final human-only verification.",
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "navigation")
    await manager.command(created.session_id, ContinueCommand(type="continue"))
    assert isinstance(await navigation, ContinueRuntimeActionResponse)
    assert record.submission_action_started is True
    assert manager.get_snapshot(created.session_id).state == "submitting"
    assert [event.event for event in record.events].count("submission_started") == 1

    with pytest.raises(HarnessServiceError) as revise:
        await manager.command(
            created.session_id,
            ReviseCommand(type="revise", context="Use the corrected date."),
        )
    assert revise.value.code == "command_conflict"

    with pytest.raises(HarnessServiceError) as replay:
        await manager.command(created.session_id, SubmitCommand(type="submit"))
    assert replay.value.code == "command_conflict"

    forbidden_actions = (
        RequestAdditionalInfoRuntimeAction(
            type="request_additional_info",
            questions=[
                AdditionalInfoTextQuestion(
                    id="late_question",
                    key="application.late_question",
                    scope="application",
                    question="Provide a new fact after approval?",
                    answer_type="text",
                )
            ],
        ),
        RequestHumanReviewRuntimeAction(
            type="request_human_review",
            result=review_result(),
        ),
        ReportApplicationMismatchRuntimeAction(type="report_application_mismatch"),
    )
    for forbidden in forbidden_actions:
        with pytest.raises(HarnessServiceError) as raised:
            await runtime_action(manager, created.session_id, forbidden)
        assert_service_error(
            raised.value,
            409,
            "command_conflict",
            "Only browser execution and human navigation may run after "
            "submission approval",
        )

    first = await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(type="playwright_cli", command="click", args=["#final-submit"]),
    )
    assert isinstance(first, PlaywrightCliResultRuntimeActionResponse)
    assert first.observation == first_execution.observation
    assert manager.get_snapshot(created.session_id).state == "submitting"

    second = await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(type="playwright_cli", command="snapshot", args=[]),
    )
    assert isinstance(second, PlaywrightCliResultRuntimeActionResponse)
    assert second.observation.url == "about:blank"
    assert second.observation == second_execution.observation
    assert manager.get_snapshot(created.session_id).state == "submitting"
    assert runtime.commands == [('click', ['#final-submit']), ('snapshot', [])]
    assert record.playwright_cli_action_count == 2
    assert len(record.snapshot.playwright_cli_diagnostics) == 2
    assert [event.event for event in record.events].count("submission_started") == 1
    assert all(
        event.session.state == "submitting"
        for event in record.events
        if event.event == "agent_step"
    )
    await manager.delete(created.session_id)


async def test_manual_review_returns_exact_submit_permission(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    review = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanReviewRuntimeAction(
                type="request_human_review",
                result=review_result(),
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "review")
    await manager.command(created.session_id, SubmitCommand(type="submit"))

    approved = await review
    assert isinstance(approved, SubmitRuntimeActionResponse)
    assert approved.instruction == "You're good to submit."
    assert record.human_gate.submission_approved is True
    await manager.delete(created.session_id)

async def test_steer_rejects_after_submission_approval_before_browser_action(
    tmp_path: Path,
) -> None:
    manager, fakes, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    review = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanReviewRuntimeAction(
                type="request_human_review",
                result=review_result(),
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "review")
    await manager.command(created.session_id, SubmitCommand(type="submit"))
    assert isinstance(await review, SubmitRuntimeActionResponse)
    assert record.human_gate.submission_approved is True
    assert record.submission_action_started is False

    with pytest.raises(HarnessServiceError) as raised:
        await manager.command(
            created.session_id,
            SteerCommand(type="steer", message="late guidance"),
        )
    assert_service_error(
        raised.value,
        409,
        "command_conflict",
        "The application state changed; review the latest session state",
    )
    assert fakes.models[0].steer_calls == []
    await manager.delete(created.session_id)


async def test_submission_approval_rejects_while_steering_is_in_flight(
    tmp_path: Path,
) -> None:
    steer_blocker = asyncio.Event()
    fakes = Fakes(steer_blocker=steer_blocker)
    manager, fakes, _ = make_manager(tmp_path, blocked_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    review = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestHumanReviewRuntimeAction(
                type="request_human_review",
                result=review_result(),
            ),
        )
    )
    await wait_until(lambda: record.human_gate.pending_kind == "review")
    steering = asyncio.create_task(
        manager.command(
            created.session_id,
            SteerCommand(type="steer", message="finish this guidance first"),
        )
    )
    await asyncio.wait_for(fakes.models[0].steer_started.wait(), timeout=1)
    with pytest.raises(HarnessServiceError) as raised:
        await manager.command(created.session_id, SubmitCommand(type="submit"))
    assert_service_error(
        raised.value,
        409,
        "command_conflict",
        "The application state changed; review the latest session state",
    )
    assert record.human_gate.submission_approved is False

    steer_blocker.set()
    await steering
    assert isinstance(await review, InterruptedRuntimeActionResponse)
    with pytest.raises(HarnessServiceError) as raised_after_steering:
        await manager.command(created.session_id, SubmitCommand(type="submit"))
    assert_service_error(
        raised_after_steering.value,
        409,
        "command_conflict",
        "No matching human gate is pending",
    )
    assert record.human_gate.submission_approved is False
    assert fakes.models[0].steer_calls == ["finish this guidance first"]
    await manager.delete(created.session_id)

async def test_auto_submit_review_conflicts_while_steering_is_in_flight(
    tmp_path: Path,
) -> None:
    steer_blocker = asyncio.Event()
    manager, fakes, _ = make_manager(
        tmp_path,
        blocked_runner,
        fakes=Fakes(steer_blocker=steer_blocker),
    )
    created = await create_valid(manager, auto_submit=True)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    steering = asyncio.create_task(
        manager.command(
            created.session_id,
            SteerCommand(type="steer", message="finish this guidance first"),
        )
    )
    await asyncio.wait_for(fakes.models[0].steer_started.wait(), timeout=1)
    with pytest.raises(HarnessServiceError) as raised:
        await runtime_action(
            manager,
            created.session_id,
            RequestHumanReviewRuntimeAction(
                type="request_human_review",
                result=review_result(),
            ),
        )
    assert_service_error(
        raised.value,
        409,
        "command_conflict",
        "The application state changed; review the latest session state",
    )
    assert record.human_gate.submission_approved is False

    steer_blocker.set()
    await steering
    approved = await runtime_action(
        manager,
        created.session_id,
        RequestHumanReviewRuntimeAction(
            type="request_human_review",
            result=review_result(),
        ),
    )
    assert isinstance(approved, SubmitRuntimeActionResponse)
    assert record.human_gate.submission_approved is True
    await manager.delete(created.session_id)

async def test_first_approved_playwright_cli_execution_failure_parks_uncertainty_without_cleanup(
    tmp_path: Path,
) -> None:
    manager, fakes, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager, auto_submit=True)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None
    runtime = FakePlaywrightRuntime(
        error=PlaywrightCliRuntimeError("browser_failed")
    )
    record.playwright_runtime = runtime

    review = await runtime_action(
        manager,
        created.session_id,
        RequestHumanReviewRuntimeAction(
            type="request_human_review",
            result=review_result(),
        ),
    )
    assert isinstance(review, SubmitRuntimeActionResponse)
    assert record.human_gate.pending_kind is None

    with pytest.raises(HarnessServiceError) as failed:
        await runtime_action(
            manager,
            created.session_id,
            PlaywrightCliRuntimeAction(type="playwright_cli", command="click", args=["button#submit"]),
        )
    assert failed.value.code == "browser_failed"

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "submission_uncertain"
    assert snapshot.pending_action is None
    assert snapshot.company == "Example Corp"
    assert snapshot.warnings == [
        "The application submission could not be verified. Check the headed browser "
        "if it is still available, then close this session."
    ]
    assert [event.event for event in tuple(record.events)[-2:]] == [
        "submission_started",
        "submission_uncertain",
    ]
    assert only_session(manager) is record
    assert record.final_request is None
    assert record.finalized is False
    assert runtime.closed is False
    assert fakes.runtimes[0].closed is False
    assert fakes.models[0].closed is False

    with pytest.raises(HarnessServiceError) as close_only:
        await manager.command(created.session_id, CancelCommand(type="cancel"))
    assert close_only.value.code == "command_conflict"
    await manager.delete(created.session_id)


async def test_first_approved_human_navigation_guard_failure_parks_uncertainty_without_cleanup(
    tmp_path: Path,
) -> None:
    manager, fakes, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager, auto_submit=True)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None
    runtime = fakes.runtimes[0]

    review = await runtime_action(
        manager,
        created.session_id,
        RequestHumanReviewRuntimeAction(
            type="request_human_review",
            result=review_result(),
        ),
    )
    assert isinstance(review, SubmitRuntimeActionResponse)
    runtime.suspend_navigation_guard_error = PlaywrightCliRuntimeError(
        "browser_failed"
    )

    with pytest.raises(HarnessServiceError) as failed:
        await runtime_action(
            manager,
            created.session_id,
            RequestHumanNavigationRuntimeAction(
                type="request_human_navigation",
                instruction="Complete the final submission.",
            ),
        )

    assert_service_error(
        failed.value,
        502,
        "browser_failed",
        SESSION_ERROR_MESSAGES["browser_failed"],
    )
    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "submission_uncertain"
    assert snapshot.pending_action is None
    assert [event.event for event in tuple(record.events)[-2:]] == [
        "submission_started",
        "submission_uncertain",
    ]
    assert only_session(manager) is record
    assert record.final_request is None
    assert record.finalized is False
    assert record.runtime_action_task is None
    assert runtime.closed is False
    assert fakes.models[0].closed is False
    await manager.delete(created.session_id)


async def test_submit_latch_wins_a_queued_cancel_race(
    tmp_path: Path,
) -> None:
    manager, fakes, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager, auto_submit=True)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    review = await runtime_action(
        manager,
        created.session_id,
        RequestHumanReviewRuntimeAction(
            type="request_human_review",
            result=review_result(),
        ),
    )
    assert isinstance(review, SubmitRuntimeActionResponse)

    await record.request_lock.acquire()
    submission = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            PlaywrightCliRuntimeAction(type="playwright_cli", command="click", args=["button#submit"]),
        )
    )
    await asyncio.sleep(0)
    cancellation = asyncio.create_task(
        manager.command(created.session_id, CancelCommand(type="cancel"))
    )
    await asyncio.sleep(0)
    record.request_lock.release()

    completed = await submission
    assert isinstance(completed, PlaywrightCliResultRuntimeActionResponse)
    assert completed.observation.url == (
        "https://jobs.example/openings/42?private=value"
    )
    assert completed.observation.tabs == []
    assert completed.observation.page_info == {
        "url": "https://jobs.example/openings/42?private=value"
    }
    await cancellation
    await wait_state(manager, created.session_id, "submission_uncertain")
    assert record.finalized is False
    assert fakes.runtimes[0].commands == [
        ("click", ["button#submit"]),
    ]
    assert record.playwright_cli_action_count == 1
    assert len(record.snapshot.playwright_cli_diagnostics) == 1
    assert [event.event for event in record.events][-2:] == [
        "submission_started",
        "submission_uncertain",
    ]
    assert fakes.runtimes[0].closed is False
    await manager.delete(created.session_id)


async def test_submit_latch_wins_a_queued_ttl_expiry_and_then_closes(
    tmp_path: Path,
) -> None:
    manager, fakes, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager, auto_submit=True)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    review = await runtime_action(
        manager,
        created.session_id,
        RequestHumanReviewRuntimeAction(
            type="request_human_review",
            result=review_result(),
        ),
    )
    assert isinstance(review, SubmitRuntimeActionResponse)

    await record.request_lock.acquire()
    submission = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            PlaywrightCliRuntimeAction(type="playwright_cli", command="click", args=["button#submit"]),
        )
    )
    await asyncio.sleep(0)
    expiry = asyncio.create_task(
        manager._request_terminal(
            record,
            sessions_module._TerminalRequest(
                "failed",
                "failed",
                "session_timeout",
            ),
            wait=False,
            duplicate_ok=True,
        )
    )
    await asyncio.sleep(0)
    record.request_lock.release()

    completed = await submission
    assert isinstance(completed, PlaywrightCliResultRuntimeActionResponse)
    assert completed.observation.tabs == []
    assert completed.observation.page_info == {
        "url": "https://jobs.example/openings/42?private=value"
    }
    await expiry
    await wait_state(manager, created.session_id, "closed")
    tombstone = manager._tombstones[created.session_id]
    assert [event.event for event in tombstone.events][-3:] == [
        "submission_started",
        "submission_uncertain",
        "closed",
    ]
    assert fakes.runtimes[0].commands == [
        ("click", ["button#submit"]),
    ]
    assert record.playwright_cli_action_count == 1
    assert len(record.snapshot.playwright_cli_diagnostics) == 1
    assert fakes.runtimes[0].closed is True


async def test_submit_latch_wins_a_queued_model_failure(
    tmp_path: Path,
) -> None:
    fail_model = asyncio.Event()

    async def runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        approved = await gate.request_human_review(review_result(), playwright_runtime)
        assert approved.is_done is False
        await fail_model.wait()
        raise PipelineApplicationAgentError(
            "model_failed",
            SESSION_ERROR_MESSAGES["model_failed"],
        )

    manager, fakes, _ = make_manager(tmp_path, runner)
    created = await create_valid(manager, auto_submit=True)
    await wait_until(
        lambda: only_session(manager) is not None
        and only_session(manager).human_gate is not None
        and only_session(manager).human_gate.submission_approved
    )
    record = only_session(manager)
    assert record is not None and record.human_gate is not None

    await record.request_lock.acquire()
    submission = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            PlaywrightCliRuntimeAction(type="playwright_cli", command="click", args=["button#submit"]),
        )
    )
    await asyncio.sleep(0)
    fail_model.set()
    await asyncio.sleep(0)
    record.request_lock.release()

    completed = await submission
    assert isinstance(completed, PlaywrightCliResultRuntimeActionResponse)
    assert completed.observation.tabs == []
    assert completed.observation.page_info == {
        "url": "https://jobs.example/openings/42?private=value"
    }
    await wait_state(manager, created.session_id, "submission_uncertain")
    assert record.finalized is False
    assert fakes.runtimes[0].commands == [
        ("click", ["button#submit"]),
    ]
    assert record.playwright_cli_action_count == 1
    assert len(record.snapshot.playwright_cli_diagnostics) == 1
    assert [event.event for event in record.events][-2:] == [
        "submission_started",
        "submission_uncertain",
    ]
    assert fakes.runtimes[0].closed is False
    await manager.delete(created.session_id)


@pytest.mark.parametrize("failure_kind", ["model_transport", "cancellation"])
async def test_post_action_model_failures_park_uncertainty(
    tmp_path: Path,
    failure_kind: str,
) -> None:
    release = asyncio.Event()

    async def runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        approved = await gate.request_human_review(review_result(), playwright_runtime)
        assert approved.is_done is False
        await release.wait()
        if failure_kind == "model_transport":
            raise PipelineApplicationAgentError(
                "model_failed",
                SESSION_ERROR_MESSAGES["model_failed"],
            )
        await asyncio.Future()
        raise AssertionError("unreachable")

    manager, fakes, _ = make_manager(tmp_path, runner)
    created = await create_valid(manager, auto_submit=True)
    record = only_session(manager)
    assert record is not None and record.human_gate is not None
    await wait_until(lambda: record.human_gate.submission_approved)
    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(type="playwright_cli", command="click", args=["button#submit"]),
    )
    if failure_kind == "model_transport":
        release.set()
    else:
        assert record.agent_task is not None
        record.agent_task.cancel()

    await wait_state(manager, created.session_id, "submission_uncertain")
    assert record.finalized is False
    assert fakes.runtimes[0].closed is False
    assert fakes.runtimes[0].closed is False
    await manager.delete(created.session_id)


async def test_failure_after_approval_but_before_submit_action_is_ordinary_failed(
    tmp_path: Path,
) -> None:
    async def runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        playwright_runtime: FakePlaywrightRuntime,
        gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        approved = await gate.request_human_review(review_result(), playwright_runtime)
        assert approved.is_done is False
        raise PipelineApplicationAgentError(
            "model_failed",
            SESSION_ERROR_MESSAGES["model_failed"],
        )

    manager, fakes, _ = make_manager(tmp_path, runner)
    created = await create_valid(manager, auto_submit=True)
    await wait_state(manager, created.session_id, "failed")

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.error is not None
    assert snapshot.error.code == "model_failed"
    assert fakes.runtimes[0].commands == []
    assert fakes.runtimes[0].closed is True


async def test_runtime_review_rejects_unresolved_fields_without_approval(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager, auto_submit=True)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None and record.human_gate is not None
    record.playwright_runtime = FakePlaywrightRuntime()
    unresolved = ReviewApplicationResult.model_validate(
        {
            **review_result().model_dump(),
            "fields_needing_human": [
                {
                    "label": "Work authorization",
                    "field_type": "radio",
                    "value_present": False,
                    "note": "Candidate answer is required.",
                }
            ],
        }
    )

    with pytest.raises(HarnessServiceError) as rejected:
        await runtime_action(
            manager,
            created.session_id,
            RequestHumanReviewRuntimeAction(
                type="request_human_review",
                result=unresolved,
            ),
        )

    assert rejected.value.status_code == 422
    assert rejected.value.code == "invalid_request"
    assert record.human_gate.submission_approved is False
    assert record.human_gate.pending_kind is None
    assert manager.get_snapshot(created.session_id).state == "running"
    await manager.delete(created.session_id)


async def test_runtime_mismatch_is_typed_and_unknown_session_is_not_found(
    tmp_path: Path,
) -> None:
    manager, _, _ = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    assert record is not None
    record.playwright_runtime = FakePlaywrightRuntime()

    mismatch = await runtime_action(
        manager,
        created.session_id,
        ReportApplicationMismatchRuntimeAction(
            type="report_application_mismatch"
        ),
    )

    assert isinstance(mismatch, ApplicationMismatchRuntimeActionResponse)
    with pytest.raises(HarnessServiceError) as missing:
        await runtime_action(
            manager,
            uuid4(),
            ReportApplicationMismatchRuntimeAction(
                type="report_application_mismatch"
            ),
        )
    assert_service_error(
        missing.value,
        404,
        "session_not_found",
        "Session was not found",
    )
    await manager.delete(created.session_id)


async def test_runtime_action_rejects_starting_and_terminal_sessions(
    tmp_path: Path,
) -> None:
    preflight_release = asyncio.Event()
    fakes = Fakes(check_blocker=preflight_release)
    manager, _, _ = make_manager(tmp_path, blocked_runner, fakes=fakes)
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(
        lambda: bool(fakes.models) and fakes.models[0].check_started.is_set()
    )
    record = only_session(manager)
    assert record is not None
    action = ReportApplicationMismatchRuntimeAction(
        type="report_application_mismatch"
    )

    with pytest.raises(HarnessServiceError) as starting:
        await runtime_action(manager, record.session_id, action)
    assert_service_error(
        starting.value,
        409,
        "command_conflict",
        "The session is still starting",
    )

    preflight_release.set()
    created = await creation
    await wait_state(manager, created.session_id, "running")
    record.playwright_runtime = FakePlaywrightRuntime()
    await manager.delete(created.session_id)

    with pytest.raises(HarnessServiceError) as terminal:
        await runtime_action(manager, created.session_id, action)
    assert_service_error(
        terminal.value,
        409,
        "command_conflict",
        "The session is terminal",
    )


async def test_create_starts_playwright_runtime_before_accepting_runtime_actions(
    tmp_path: Path,
) -> None:
    manager, fakes, _ = make_manager(tmp_path, blocked_runner)

    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)

    assert record is not None
    assert record.playwright_runtime is fakes.runtimes[0]
    assert fakes.runtimes[0].runtime_started is True
    assert fakes.order.index("runtime.factory") < fakes.order.index("runtime.start")

    response = await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(type="playwright_cli", command="eval", args=["console.log('connected')"]),
    )
    assert isinstance(response, PlaywrightCliResultRuntimeActionResponse)
    await manager.delete(created.session_id)


async def test_terminal_cleanup_cancels_active_runtime_action_before_playwright_runtime_cleanup(
    tmp_path: Path,
) -> None:
    order: list[str] = []
    manager, fakes, _ = make_manager(
        tmp_path,
        blocked_runner,
        fakes=Fakes(
            order=order,
            runtime_close_cancels_active=False,
        ),
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = only_session(manager)
    runtime = fakes.runtimes[0]
    runtime.blocker = asyncio.Event()
    assert record is not None
    ownership_at_close: list[Any] = []
    runtime.close_observer = lambda: ownership_at_close.append(
        record.runtime_action_task
    )
    requester = asyncio.create_task(
        manager.runtime_action(
            created.session_id,
            PlaywrightCliRuntimeAction(
                type="playwright_cli",
                command="eval",
                args=["new Promise(r => setTimeout(r, 30000))"],
            ),
        )
    )
    await runtime.started.wait()
    owner = record.runtime_action_task
    assert owner is not None
    assert owner is not requester

    try:
        await asyncio.wait_for(
            manager.delete(created.session_id),
            timeout=0.2,
        )
    except BaseException:
        requester.cancel()
        await asyncio.gather(requester, return_exceptions=True)
        await asyncio.wait_for(record.closed_event.wait(), timeout=1)
        raise

    with pytest.raises(asyncio.CancelledError):
        await requester
    assert runtime.closed
    assert ownership_at_close == [None]
    assert owner.cancelled()
    assert record.runtime_action_task is None
    assert order.index("runtime.execute_finished") < order.index("runtime.close")
    assert order.index("runtime.close") < order.index("model.aclose")
    events = manager._tombstones[created.session_id].events
    assert all(event.event != "agent_step" for event in events)


@pytest.mark.parametrize("opportunity_kind", ["hackathon", "networking_event"])
async def test_full_application_agent_receives_one_session_scoped_run_request(
    tmp_path: Path,
    opportunity_kind: OpportunityKind,
) -> None:
    cancelled = cancelled_result()
    fakes = Fakes(agent_result=cancelled)
    manager, fakes, _ = make_manager(tmp_path, None, fakes=fakes)
    await manager._user_info_store.merge(
        JOB_URL,
        (
            AdditionalInfoTextQuestion(
                id="saved_global",
                key="availability.summer_2027",
                scope="global",
                question="When are you available?",
                answer_type="text",
            ),
            AdditionalInfoTextQuestion(
                id="saved_application",
                key="application.follow_up",
                scope="application",
                question="Application-specific follow-up?",
                answer_type="text",
            ),
        ),
        (
            AdditionalInfoTextCommandAnswer(
                id="saved_global",
                status="answered",
                raw_value="free june aug",
                value="June through August 2027",
            ),
            AdditionalInfoDeclinedCommandAnswer(
                id="saved_application",
                status="declined",
            ),
        ),
    )

    created = await create_valid(manager, opportunity_kind=opportunity_kind)
    record = only_session(manager)
    assert record is not None
    assert record.human_gate is not None
    await wait_state(manager, created.session_id, "cancelled")

    assert len(fakes.models[0].run_calls) == 1
    call = fakes.models[0].run_calls[0]
    assert set(call) == {
        "runtime_url",
        "opportunity_kind",
        "auto_submit",
        "task",
        "deadline_ms",
    }
    assert call["auto_submit"] is False
    assert call["runtime_url"] == "http://127.0.0.1:8765"
    task = json.loads(call["task"])
    assert task["job"]["url"] == JOB_URL
    assert call["opportunity_kind"] == opportunity_kind
    assert task["job"]["opportunity_kind"] == opportunity_kind
    assert "opportunity_kind" not in manager.get_snapshot(
        created.session_id
    ).model_dump(mode="json")
    assert task["user_info"]["explicit"]["email"] == PROFILE_SECRET
    assert task["user_info"]["saved_global"] == {
        "availability.summer_2027": {
            "answer_type": "text",
            "status": "answered",
            "value": "June through August 2027",
        }
    }
    assert task["user_info"]["saved_application"] == {
        "application.follow_up": {
            "answer_type": "text",
            "status": "declined",
        }
    }
    assert "free june aug" in record.human_gate.redaction_values
    assert "June through August 2027" in record.human_gate.redaction_values
    assert "free june aug" not in call["task"]
    assert "question" not in call["task"]
    assert "auto_submit" not in call["task"]
    assert "autoSubmit" not in call["task"]
    assert "updated_at" not in call["task"]
    assert task["evidence"][0]["category"] == "resume"
    assert "workflow" not in call["task"].lower()
    assert call["deadline_ms"] is None
    assert fakes.order.index("model.check_ready") < fakes.order.index(
        "runtime.factory"
    )
    assert fakes.order.count("model.run") == 1


async def test_oversized_data_task_fails_before_preflight_and_playwright_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        sessions_module,
        "build_application_task",
        lambda _request: "x" * (sessions_module._MAX_APPLICATION_TASK_BYTES + 1),
    )
    manager, fakes, root = make_manager(tmp_path, None)

    with pytest.raises(HarnessServiceError) as caught:
        await create_valid(manager)

    assert_service_error(
        caught.value,
        422,
        "invalid_request",
        "Request is invalid",
    )
    assert fakes.models == []
    assert fakes.runtimes == []
    assert fakes.runtimes == []
    assert only_session(manager) is None
    assert not root.exists() or tuple(root.iterdir()) == ()


@pytest.mark.parametrize(
    ("result", "expected_code"),
    [
        (review_result(), "invalid_model_output"),
        (
            cancelled_result().model_copy(
                update={
                    "status": "cancelled",
                    "job_url": "https://other.example/jobs/42",
                }
            ),
            "application_mismatch",
        ),
    ],
    ids=["review-returned-as-terminal", "wrong-job-url"],
)
async def test_full_agent_result_requires_matching_job_and_accepted_review(
    tmp_path: Path,
    result: ApplicationRunResult,
    expected_code: str,
) -> None:
    fakes = Fakes(agent_result=result)
    manager, fakes, _ = make_manager(tmp_path, None, fakes=fakes)

    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "failed")

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.error is not None
    assert snapshot.error.code == expected_code
    assert len(fakes.models[0].run_calls) == 1
    assert fakes.runtimes[0].closed
    assert fakes.runtimes[0].closed
    assert fakes.models[0].closed


@pytest.mark.parametrize(
    "code",
    [
        "oauth_required",
        "model_timeout",
        "invalid_model_output",
        "model_failed",
        "application_mismatch",
        "browser_failed",
    ],
)
async def test_full_agent_errors_become_sanitized_terminal_failures(
    tmp_path: Path,
    code: str,
) -> None:
    fakes = Fakes(
        agent_error=PipelineApplicationAgentError(
            code,
            SESSION_ERROR_MESSAGES[code],
        )
    )
    manager, fakes, _ = make_manager(tmp_path, None, fakes=fakes)

    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "failed")

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.error is not None
    assert snapshot.error.model_dump() == {
        "code": code,
        "message": SESSION_ERROR_MESSAGES[code],
    }
    assert len(fakes.models[0].run_calls) == 1


async def test_subsecond_remaining_deadline_waits_for_ttl_without_posting(
    tmp_path: Path,
) -> None:
    preflight_release = asyncio.Event()
    ttl_release = asyncio.Event()
    cancelled = cancelled_result()
    fakes = Fakes(
        check_blocker=preflight_release,
        agent_result=cancelled,
    )
    manager, fakes, _ = make_manager(
        tmp_path,
        None,
        fakes=fakes,
        timeout=1,
    )
    expire_session = manager._expire_session

    async def controlled_expiration(record: Any) -> None:
        await ttl_release.wait()
        await expire_session(record)

    manager._expire_session = controlled_expiration  # type: ignore[method-assign]
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(fakes.models))
    await asyncio.wait_for(fakes.models[0].check_started.wait(), timeout=1)
    await asyncio.sleep(0.2)
    preflight_release.set()

    created = await creation
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert manager.get_snapshot(created.session_id).state == "running"
    record = only_session(manager)
    assert record is not None
    assert record.final_request is None
    assert fakes.models[0].run_calls == []

    ttl_release.set()
    await wait_state(manager, created.session_id, "failed")
    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.error is not None
    assert snapshot.error.code == "session_timeout"


@pytest.mark.asyncio
async def test_default_then_saved_credentials_try_once_per_inspection_then_gate(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    moments = iter(
        [
            datetime(2026, 8, 1, 12, 0, tzinfo=UTC),
            datetime(2026, 8, 2, 12, 0, tzinfo=UTC),
        ]
    )
    credential_store = CredentialStore(
        tmp_path / "credentials.json",
        clock=lambda: next(moments),
    )
    await credential_store.upsert(
        "https://jobs.example",
        "old@example.test",
        "old-password",
    )
    await credential_store.upsert(
        "https://jobs.example",
        "new@example.test",
        "new-password",
    )
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        credential_store=credential_store,
        default_credentials=(DEFAULT_APPLICATION_EMAIL, DEFAULT_APPLICATION_PASSWORD),
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    request = RequestSignInRuntimeAction(
        type="request_sign_in",
        username_ref="e1",
        password_ref="e2",
        submit_ref="e3",
    )

    with pytest.raises(HarnessServiceError) as before_inspection:
        await runtime_action(manager, created.session_id, request)
    assert_service_error(
        before_inspection.value,
        409,
        "command_conflict",
        "Inspect the application before requesting sign-in",
    )

    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    first = await runtime_action(manager, created.session_id, request)
    assert first == SignInRuntimeActionResponse(
        type="sign_in",
        status="attempted",
    )
    assert fakes.runtimes[0].sign_in_calls[-1]["username"] == DEFAULT_APPLICATION_EMAIL

    with pytest.raises(HarnessServiceError) as stale_inspection:
        await runtime_action(manager, created.session_id, request)
    assert_service_error(
        stale_inspection.value,
        409,
        "command_conflict",
        "Inspect the application before requesting sign-in",
    )

    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    second = await runtime_action(manager, created.session_id, request)
    assert second == SignInRuntimeActionResponse(
        type="sign_in",
        status="attempted",
    )
    assert [
        call["username"] for call in fakes.runtimes[0].sign_in_calls
    ] == [DEFAULT_APPLICATION_EMAIL, "new@example.test"]

    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    third = await runtime_action(manager, created.session_id, request)
    assert third == SignInRuntimeActionResponse(
        type="sign_in",
        status="attempted",
    )
    assert [
        call["username"] for call in fakes.runtimes[0].sign_in_calls
    ] == [DEFAULT_APPLICATION_EMAIL, "new@example.test", "old@example.test"]

    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    gated = asyncio.create_task(
        runtime_action(manager, created.session_id, request)
    )
    await wait_state(
        manager,
        created.session_id,
        "awaiting_human_navigation",
    )
    runtime = fakes.runtimes[0]
    assert runtime.capture_suppression_calls == 4
    assert runtime.video_recording is False
    assert runtime.navigation_guard_suspended is False
    assert runtime.order.index(
        "runtime.suppress_private_capture"
    ) < runtime.order.index("runtime.private_sign_in")
    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.pending_action is not None
    assert snapshot.pending_action.model_dump(mode="json") == {
        "type": "credentials"
    }
    record = only_session(manager)
    assert record is not None
    assert record.playwright_cli_action_count == 10
    credentials_event = next(
        event for event in record.events if event.event == "credentials_required"
    )
    assert credentials_event.detail.model_dump(mode="json") == {}
    assert credentials_event.session.pending_action is not None
    assert credentials_event.session.pending_action.model_dump(mode="json") == {
        "type": "credentials"
    }

    with pytest.raises(HarnessServiceError) as wrong_command:
        await manager.command(
            created.session_id,
            ContinueCommand(type="continue"),
        )
    assert wrong_command.value.code == "command_conflict"

    await manager.command(created.session_id, CancelCommand(type="cancel"))
    outcome = (await asyncio.gather(gated, return_exceptions=True))[0]
    assert isinstance(outcome, asyncio.CancelledError) or getattr(
        outcome,
        "type",
        None,
    ) == "cancel"
    await wait_state(manager, created.session_id, "cancelled")


@pytest.mark.asyncio
async def test_transient_sign_in_exposes_model_output_but_keeps_public_state_sanitized(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    credential_store = CredentialStore(tmp_path / "credentials.json")
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        credential_store=credential_store,
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    pending = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestSignInRuntimeAction(
                type="request_sign_in",
                username_ref="e10",
                password_ref="e20",
                submit_ref="e30",
            ),
        )
    )
    await wait_state(
        manager,
        created.session_id,
        "awaiting_human_navigation",
    )
    runtime = fakes.runtimes[0]
    assert runtime.capture_suppression_calls == 1
    assert runtime.video_recording is False
    assert runtime.navigation_guard_suspended is False

    username = "transient@example.test"
    password = " transient-password "
    await manager.command(
        created.session_id,
        SignInCommand(
            type="sign_in",
            username=username,
            password=password,
        ),
    )
    response = await pending

    assert response.model_dump(mode="json") == {
        "type": "sign_in",
        "status": "attempted",
    }
    assert username not in response.model_dump_json()
    assert password not in response.model_dump_json()
    saved = credential_store.credentials_for_origin("https://jobs.example")
    assert [(item.username, item.password) for item in saved] == [
        (username, password)
    ]
    assert runtime.video_recording is False
    assert runtime.sign_in_calls == [
        {
            "expected_origin": "https://jobs.example",
            "username_ref": "e10",
            "password_ref": "e20",
            "submit_ref": "e30",
            "username": username,
            "password": password,
        }
    ]

    runtime.result = PlaywrightCliExecutionResult(exit_code=0, stdout=f"result for {username} using {password}",
    stderr=f"stderr {password}",
    stdout_truncated=False,
    stderr_truncated=False,
    observation=BrowserObservation(
        url=f"https://jobs.example/account/{username}",
        title=f"Welcome {username}",
        tabs=[
            BrowserTab(
                url=f"https://jobs.example/account/{username}",
                title=f"Account {password}",
                tab_id="0",
            )
        ],
        dom=f"Signed in as {username} with {password}",
        page_info={"username": username},
        screenshot={"data": "c2VjcmV0LXNjcmVlbnNob3Q="},
    ),)
    later = await manager.runtime_model_action(
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    dumped = later.model_dump_json()
    assert username in dumped
    assert password in dumped
    assert later.observation.screenshot is None
    assert later.observation.page_info == {"username": username}
    snapshot_dump = manager.get_snapshot(created.session_id).model_dump_json()
    assert username not in snapshot_dump
    assert password not in snapshot_dump
    record = only_session(manager)
    assert record is not None
    event_dump = "".join(event.model_dump_json() for event in record.events)
    assert username not in event_dump
    assert password not in event_dump

    await manager.delete(created.session_id)


@pytest.mark.asyncio
async def test_save_credentials_verifies_same_origin_path_without_browser_submission(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    credential_store = CredentialStore(tmp_path / "credentials.json")
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        credential_store=credential_store,
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    pending = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestSignInRuntimeAction(
                type="request_sign_in",
                username_ref="e1",
                password_ref="e2",
                submit_ref="e3",
            ),
        )
    )
    await wait_state(
        manager,
        created.session_id,
        "awaiting_human_navigation",
    )
    runtime = fakes.runtimes[0]
    assert runtime.capture_suppression_calls == 1
    assert runtime.video_recording is False
    assert runtime.navigation_guard_suspended is False
    runtime.current_url = "https://jobs.example/account/welcome"
    username = "created@example.test"
    password = "created-account-password"

    await manager.command(
        created.session_id,
        SaveCredentialsCommand(
            type="save_credentials",
            username=username,
            password=password,
        ),
    )
    response = await pending

    assert response.model_dump(mode="json") == {
        "type": "sign_in",
        "status": "saved",
    }
    assert runtime.sign_in_calls == []
    assert runtime.activated_private_values == [(username, password)]
    assert credential_store.credentials_for_origin(
        "https://account.example.test"
    ) == ()
    saved = credential_store.credentials_for_origin("https://jobs.example")
    assert [(item.username, item.password) for item in saved] == [
        (username, password)
    ]
    assert manager.get_snapshot(created.session_id).approved_origins == [
        "https://jobs.example",
    ]
    assert runtime.approved_origins == ("https://jobs.example",)
    assert username not in manager.get_snapshot(created.session_id).model_dump_json()
    assert password not in manager.get_snapshot(created.session_id).model_dump_json()

    await manager.delete(created.session_id)


@pytest.mark.asyncio
async def test_save_credentials_conflicts_after_navigation_to_other_approved_origin(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    credential_store = CredentialStore(tmp_path / "credentials.json")
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        credential_store=credential_store,
    )
    created = await create_valid(
        manager,
        allow_domains=("https://account.example.test",),
    )
    await wait_state(manager, created.session_id, "running")
    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    pending = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestSignInRuntimeAction(
                type="request_sign_in",
                username_ref="e1",
                password_ref="e2",
                submit_ref="e3",
            ),
        )
    )
    await wait_state(
        manager,
        created.session_id,
        "awaiting_human_navigation",
    )
    runtime = fakes.runtimes[0]
    runtime.current_url = "https://account.example.test/welcome"
    username = "created@example.test"
    password = "created-account-password"

    with pytest.raises(HarnessServiceError) as caught:
        await manager.command(
            created.session_id,
            SaveCredentialsCommand(
                type="save_credentials",
                username=username,
                password=password,
            ),
        )

    assert_service_error(
        caught.value,
        409,
        "command_conflict",
        "The credential page changed",
    )
    assert credential_store.credentials_for_origin("https://jobs.example") == ()
    assert credential_store.credentials_for_origin(
        "https://account.example.test"
    ) == ()
    assert runtime.activated_private_values == []
    assert not pending.done()

    await manager.command(created.session_id, CancelCommand(type="cancel"))
    await asyncio.gather(pending, return_exceptions=True)
    await wait_state(manager, created.session_id, "cancelled")


@pytest.mark.asyncio
async def test_saved_sign_in_preserves_private_runtime_session_timeout(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    credential_store = CredentialStore(tmp_path / "credentials.json")
    await credential_store.upsert(
        "https://jobs.example",
        "timeout@example.test",
        "timeout-password",
    )
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        credential_store=credential_store,
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    runtime = fakes.runtimes[0]
    runtime.private_sign_in_error = PlaywrightCliRuntimeError(
        "session_timeout"
    )

    with pytest.raises(HarnessServiceError) as caught:
        await runtime_action(
            manager,
            created.session_id,
            RequestSignInRuntimeAction(
                type="request_sign_in",
                username_ref="e1",
                password_ref="e2",
                submit_ref="e3",
            ),
        )

    assert_service_error(
        caught.value,
        504,
        "session_timeout",
        SESSION_ERROR_MESSAGES["session_timeout"],
    )
    assert runtime.capture_suppression_calls == 1
    assert runtime.video_recording is False
    record = only_session(manager)
    assert record is not None
    assert record.human_gate is not None
    assert record.human_gate.screenshots_suppressed is True

    await manager.delete(created.session_id)


@pytest.mark.asyncio
async def test_cancel_preempts_blocked_private_sign_in_before_submission(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    credential_store = CredentialStore(tmp_path / "credentials.json")
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        credential_store=credential_store,
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    gated = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestSignInRuntimeAction(
                type="request_sign_in",
                username_ref="e1",
                password_ref="e2",
                submit_ref="e3",
            ),
        )
    )
    await wait_state(
        manager,
        created.session_id,
        "awaiting_human_navigation",
    )
    runtime = fakes.runtimes[0]
    runtime.private_sign_in_blocker = asyncio.Event()
    command = SignInCommand(
        type="sign_in",
        username="blocked@example.test",
        password="blocked-password",
    )
    signing_in = asyncio.create_task(
        manager.command(created.session_id, command)
    )
    await asyncio.wait_for(runtime.private_sign_in_started.wait(), timeout=1)

    with pytest.raises(HarnessServiceError) as duplicate:
        await manager.command(created.session_id, command)
    assert duplicate.value.status_code == 409
    assert duplicate.value.code == "command_conflict"

    await asyncio.wait_for(
        manager.command(created.session_id, CancelCommand(type="cancel")),
        timeout=1,
    )
    sign_outcome = (
        await asyncio.gather(signing_in, return_exceptions=True)
    )[0]
    assert isinstance(sign_outcome, asyncio.CancelledError)
    gate_outcome = (await asyncio.gather(gated, return_exceptions=True))[0]
    assert isinstance(gate_outcome, asyncio.CancelledError) or getattr(
        gate_outcome,
        "type",
        None,
    ) == "cancel"
    await wait_state(manager, created.session_id, "cancelled")
    assert runtime.sign_in_calls == []
    assert "runtime.private_sign_in" not in runtime.order
    assert runtime.private_sign_in_blocker is not None
    assert not runtime.private_sign_in_blocker.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("runtime_code", "status_code"),
    [("browser_failed", 502), ("session_timeout", 504)],
)
async def test_save_credentials_preserves_private_runtime_errors(
    tmp_path: Path,
    runtime_code: Literal["browser_failed", "session_timeout"],
    status_code: int,
) -> None:
    tmp_path.chmod(0o700)
    credential_store = CredentialStore(tmp_path / "credentials.json")
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        credential_store=credential_store,
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    gated = asyncio.create_task(
        runtime_action(
            manager,
            created.session_id,
            RequestSignInRuntimeAction(
                type="request_sign_in",
                username_ref="e1",
                password_ref="e2",
                submit_ref="e3",
            ),
        )
    )
    await wait_state(
        manager,
        created.session_id,
        "awaiting_human_navigation",
    )
    runtime = fakes.runtimes[0]
    runtime.activate_private_values_error = PlaywrightCliRuntimeError(
        runtime_code
    )

    with pytest.raises(HarnessServiceError) as caught:
        await manager.command(
            created.session_id,
            SaveCredentialsCommand(
                type="save_credentials",
                username="created@example.test",
                password="created-password",
            ),
        )

    assert_service_error(
        caught.value,
        status_code,
        runtime_code,
        SESSION_ERROR_MESSAGES[runtime_code],
    )
    assert credential_store.credentials_for_origin("https://jobs.example") == ()
    await manager.command(created.session_id, CancelCommand(type="cancel"))
    await asyncio.gather(gated, return_exceptions=True)
    await wait_state(manager, created.session_id, "cancelled")

@pytest.mark.asyncio
async def test_capture_failure_never_opens_or_executes_the_credentials_gate(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    manager, fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        credential_store=CredentialStore(tmp_path / "credentials.json"),
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    await runtime_action(
        manager,
        created.session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command="snapshot",
            args=[],
        ),
    )
    runtime = fakes.runtimes[0]
    runtime.capture_suppression_error = PlaywrightCliRuntimeError(
        "browser_failed"
    )

    with pytest.raises(HarnessServiceError) as caught:
        await runtime_action(
            manager,
            created.session_id,
            RequestSignInRuntimeAction(
                type="request_sign_in",
                username_ref="e1",
                password_ref="e2",
                submit_ref="e3",
            ),
        )

    assert_service_error(
        caught.value,
        502,
        "browser_failed",
        SESSION_ERROR_MESSAGES["browser_failed"],
    )
    assert manager.get_snapshot(created.session_id).state == "running"
    record = only_session(manager)
    assert record is not None
    assert all(event.event != "credentials_required" for event in record.events)
    assert runtime.sign_in_calls == []
    assert runtime.capture_suppression_calls == 1
    await manager.delete(created.session_id)


@pytest.mark.asyncio
async def test_model_runtime_can_search_and_read_inbox_but_public_runtime_cannot(
    tmp_path: Path,
) -> None:
    inbox = FakeInbox(
        search_result=InboxSearchResult(
            messages=(
                InboxMessageSummary(
                    message_id="message-1",
                    subject="Your verification code",
                    sent_at=datetime(2026, 8, 30, 14, 22, 3, tzinfo=UTC),
                ),
            ),
            truncated=True,
        ),
        email=InboxEmail(message_id="message-1", content="parsed MIME content"),
    )
    manager, _fakes, _root = make_manager(
        tmp_path,
        blocked_runner,
        gmail_inbox=inbox,
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")

    search = await runtime_action(
        manager,
        created.session_id,
        ReadInboxRuntimeAction(
            type="read_inbox",
            query="code",
            date="2026-08-30",
            time="14:00",
            received_within_minutes=30,
            received_before_minutes_ago=15,
        ),
    )
    assert search.model_dump(mode="json") == {
        "type": "read_inbox_result",
        "messages": [
            {
                "email_id": "message-1",
                "subject": "Your verification code",
                "sent_at": "2026-08-30T14:22:03Z",
            }
        ],
        "truncated": True,
    }
    email = await runtime_action(
        manager,
        created.session_id,
        ReadEmailRuntimeAction(
            type="read_email",
            email_id="message-1",
            offset=51_000,
        ),
    )
    assert email.model_dump() == {
        "type": "read_email_result",
        "content": "parsed MIME content",
    }
    assert inbox.calls == [
        (
            "search",
            {
                "query": "code",
                "date": date(2026, 8, 30),
                "time": time(14, 0),
                "received_within_minutes": 30,
                "received_before_minutes_ago": 15,
            },
        ),
        ("read", {"email_id": "message-1", "offset": 51_000}),
    ]

    with pytest.raises(HarnessServiceError, match="model-only"):
        await manager.runtime_action(
            created.session_id,
            ReadEmailRuntimeAction(type="read_email", email_id="message-1"),
        )
    await manager.delete(created.session_id)
