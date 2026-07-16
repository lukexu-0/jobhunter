from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from threading import Event as ThreadEvent
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import UploadFile
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

import jobhunter_browser_harness.sessions as sessions_module
from jobhunter_browser_harness.artifacts import cleanup_session_artifacts, store_uploads
from jobhunter_browser_harness.agent import ApplicationAgentFailure, ApplicationRunRequest
from jobhunter_browser_harness.api import HarnessDependencies, create_app
from jobhunter_browser_harness.context import (
    CandidateContext,
    CandidateContextProcess,
    load_candidate_context,
)
from jobhunter_browser_harness.browser import ResolvedBrowserLaunch
from jobhunter_browser_harness.models import (
    ApplicationRunResult,
    ApproveOriginCommand,
    CancelCommand,
    ContinueCommand,
    HarnessConfig,
    HarnessServiceError,
    ReadyCommand,
    ReviseCommand,
    SESSION_ERROR_MESSAGES,
)
from jobhunter_browser_harness.pipeline_model import PipelineModelError, PipelineOAuthChatModel
from jobhunter_browser_harness.sessions import ApplicationSessionManager
from jobhunter_browser_harness.tools import HumanGate


TOKEN = "test-token-0123456789abcdef-0123456789"
AUTHORIZATION = {"Authorization": f"Bearer {TOKEN}"}
JOB_URL = "https://jobs.example/openings/42?candidate=private-secret"
PROFILE_SECRET = "ada.private@example.test"


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


def valid_uploads() -> tuple[UploadFile, UploadFile]:
    personal = (
        "---\n"
        "full_name: Ada Lovelace\n"
        f"email: {PROFILE_SECRET}\n"
        "---\n"
        "Experienced analytical engineer.\n"
    ).encode()
    return upload("profile.md", personal), upload("resume.pdf", pdf_bytes())


def multipart_parts() -> list[tuple[str, tuple[None, str] | tuple[str, bytes, str]]]:
    return [
        ("job_url", (None, JOB_URL)),
        ("max_steps", (None, "100")),
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
    ]


def ready_result(*, revision_count: int = 0) -> ApplicationRunResult:
    return ApplicationRunResult(
        status="ready_for_human_submit",
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


@dataclass(slots=True)
class FakeModel:
    order: list[str]
    ready_error: PipelineModelError | None = None
    check_blocker: asyncio.Event | None = None
    check_started: asyncio.Event = field(default_factory=asyncio.Event)
    active_started: asyncio.Event = field(default_factory=asyncio.Event)
    active_finished: asyncio.Event = field(default_factory=asyncio.Event)
    closed: bool = False
    close_failures: int = 0
    close_started: asyncio.Event = field(default_factory=asyncio.Event)
    close_blocker: asyncio.Event | None = None

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
class FakeBrowser:
    origins: Sequence[str]
    order: list[str]
    current_url: str = JOB_URL
    killed: bool = False
    browser_profile: SimpleNamespace = field(init=False)
    kill_failures: int = 0
    kill_started: asyncio.Event = field(default_factory=asyncio.Event)
    kill_blocker: asyncio.Event | None = None

    def __post_init__(self) -> None:
        self.browser_profile = SimpleNamespace(
            allowed_domains=[f"{origin}/" for origin in self.origins]
        )

    async def get_current_page_url(self) -> str:
        return self.current_url

    async def kill(self) -> None:
        self.order.append("browser.kill")
        self.kill_started.set()
        if self.kill_failures:
            self.kill_failures -= 1
            raise RuntimeError("synthetic browser cleanup failure")
        if self.kill_blocker is not None:
            await self.kill_blocker.wait()
        self.killed = True


class Fakes:
    def __init__(
        self,
        *,
        order: list[str] | None = None,
        ready_error: PipelineModelError | None = None,
        check_blocker: asyncio.Event | None = None,
        browser_kill_failures: int = 0,
        browser_kill_blocker: asyncio.Event | None = None,
        model_close_failures: int = 0,
        model_close_blocker: asyncio.Event | None = None,
    ) -> None:
        self.order = order if order is not None else []
        self.ready_error = ready_error
        self.check_blocker = check_blocker
        self.browser_kill_failures = browser_kill_failures
        self.browser_kill_blocker = browser_kill_blocker
        self.model_close_failures = model_close_failures
        self.model_close_blocker = model_close_blocker
        self.models: list[FakeModel] = []
        self.browsers: list[FakeBrowser] = []

    def model_factory(
        self, _session_id: UUID, _pipeline_url: str, _token: str
    ) -> FakeModel:
        model = FakeModel(
            order=self.order,
            ready_error=self.ready_error,
            check_blocker=self.check_blocker,
            close_failures=self.model_close_failures,
            close_blocker=self.model_close_blocker,
        )
        self.models.append(model)
        return model

    def browser_factory(
        self,
        _launch: ResolvedBrowserLaunch,
        origins: Sequence[str],
        downloads_path: Path,
    ) -> FakeBrowser:
        self.order.append("browser.factory")
        downloads_path.mkdir(mode=0o700, parents=True, exist_ok=True)
        browser = FakeBrowser(
            tuple(origins),
            self.order,
            kill_failures=self.browser_kill_failures,
            kill_blocker=self.browser_kill_blocker,
        )
        self.browsers.append(browser)
        return browser


class ImmediateContextProcess:
    def __init__(self, stored: Any) -> None:
        self._candidate = load_candidate_context(stored)
        self.terminated = False

    async def result(self) -> CandidateContext:
        return self._candidate

    async def terminate(self) -> None:
        self.terminated = True


Runner = Callable[
    [
        ApplicationRunRequest,
        FakeModel,
        FakeBrowser,
        HumanGate,
        Callable[[int, str], Awaitable[None]],
    ],
    Awaitable[ApplicationRunResult],
]


def make_manager(
    tmp_path: Path,
    runner: Runner,
    *,
    fakes: Fakes | None = None,
    timeout: int = 3600,
    context_process_factory: Callable[[Any], Any] = ImmediateContextProcess,
) -> tuple[ApplicationSessionManager, Fakes, Path]:
    doubles = fakes or Fakes()
    root = tmp_path / "sessions"
    manager = ApplicationSessionManager(
        HarnessConfig(bearer_token=TOKEN, session_timeout=timeout),
        artifacts_root=root,
        browser_launch=ResolvedBrowserLaunch(
            cdp_url=None,
            executable_path=tmp_path / "fake-chrome",
            user_data_dir=tmp_path / "profile",
        ),
        model_factory=doubles.model_factory,
        context_process_factory=context_process_factory,
        browser_factory=doubles.browser_factory,
        application_runner=runner,
    )
    return manager, doubles, root


async def create_valid(manager: ApplicationSessionManager):
    personal, resume = valid_uploads()
    return await manager.create_session(
        job_url=JOB_URL,
        allow_domains=[],
        max_steps=100,
        personal_information=personal,
        resume=resume,
        context=[],
        anecdotes=[],
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


def decode_frame(frame: str) -> dict[str, Any]:
    data_line = next(line for line in frame.splitlines() if line.startswith("data: "))
    return json.loads(data_line.removeprefix("data: "))


async def blocked_runner(
    _request: ApplicationRunRequest,
    _model: FakeModel,
    _browser: FakeBrowser,
    _gate: HumanGate,
    _step: Callable[[int, str], Awaitable[None]],
) -> ApplicationRunResult:
    await asyncio.Future()
    raise AssertionError("unreachable")


@pytest.mark.parametrize(
    ("job_url", "origins", "max_steps"),
    [
        ("not-a-url", [], 100),
        (JOB_URL, ["https://ats.example/path"], 100),
        (JOB_URL, ["https://jobs.example"], 100),
        (JOB_URL, [], 0),
        (JOB_URL, [], 501),
    ],
    ids=["job-url", "origin", "duplicate-origin", "min-steps", "max-steps"],
)
async def test_invalid_create_values_fail_before_storage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    job_url: str,
    origins: list[str],
    max_steps: int,
) -> None:
    storage_called = False

    async def forbidden_storage(*_args: Any, **_kwargs: Any) -> None:
        nonlocal storage_called
        storage_called = True
        raise AssertionError("storage must not run")

    monkeypatch.setattr(sessions_module, "store_uploads", forbidden_storage)
    manager, fakes, root = make_manager(tmp_path, blocked_runner)
    personal, resume = valid_uploads()

    with pytest.raises(HarnessServiceError) as caught:
        await manager.create_session(
            job_url=job_url,
            allow_domains=origins,
            max_steps=max_steps,
            personal_information=personal,
            resume=resume,
            context=[],
            anecdotes=[],
        )

    assert_service_error(caught.value, 422, "invalid_request", "Request is invalid")
    assert storage_called is False
    assert fakes.models == []
    assert fakes.browsers == []
    assert not root.exists()


async def test_preflight_completes_before_browser_and_create_contract_is_public_safe(
    tmp_path: Path,
) -> None:
    order: list[str] = []
    runner_started = asyncio.Event()

    async def runner(
        request: ApplicationRunRequest,
        _model: FakeModel,
        _browser: FakeBrowser,
        _gate: HumanGate,
        step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        runner_started.set()
        await step(1, f"{request.session.job_url}&email={PROFILE_SECRET}")
        await asyncio.Future()
        raise AssertionError("unreachable")

    manager, fakes, _root = make_manager(tmp_path, runner, fakes=Fakes(order=order))
    response = await create_valid(manager)
    snapshot = manager.get_snapshot(response.session_id)

    assert response.state == "starting"
    assert response.events_url == f"http://127.0.0.1:8765/v1/sessions/{response.session_id}/events"
    assert response.commands_url == f"http://127.0.0.1:8765/v1/sessions/{response.session_id}/commands"
    assert order[:2] == ["model.check_ready", "browser.factory"]
    assert snapshot.state == "starting"
    assert snapshot.job_url == "https://jobs.example/openings/42"
    assert snapshot.approved_origins == ["https://jobs.example"]

    await asyncio.wait_for(runner_started.wait(), timeout=1)
    await wait_until(lambda: len(manager._active.events) >= 2)  # type: ignore[union-attr]
    record = manager._active
    assert record is not None
    assert [event.event for event in list(record.events)[:2]] == [
        "session_started",
        "agent_step",
    ]
    assert [event.id for event in record.events] == list(range(1, len(record.events) + 1))
    public = json.dumps(
        {
            "snapshot": manager.get_snapshot(response.session_id).model_dump(mode="json"),
            "events": [event.model_dump(mode="json") for event in record.events],
        }
    )
    assert PROFILE_SECRET not in public
    assert "candidate=private-secret" not in public
    assert "answer=private" not in public
    assert decode_frame(sessions_module._sse_frame(record.events[-1]))["detail"] == {
        "step_number": 1,
        "current_url": "https://jobs.example/openings/42",
    }

    await manager.delete(response.session_id)
    assert fakes.browsers[0].killed
    assert fakes.models[0].closed


@pytest.mark.parametrize(
    ("code", "message", "status"),
    [
        ("oauth_required", "Connect OpenAI Codex in Provider access", 409),
        ("pipeline_unavailable", "The local pipeline model service is unavailable", 503),
    ],
)
async def test_preflight_errors_cleanup_before_browser_factory(
    tmp_path: Path, code: str, message: str, status: int
) -> None:
    fakes = Fakes(ready_error=PipelineModelError(code, message))
    manager, fakes, root = make_manager(tmp_path, blocked_runner, fakes=fakes)

    with pytest.raises(HarnessServiceError) as caught:
        await create_valid(manager)

    assert_service_error(caught.value, status, code, message)
    assert fakes.browsers == []
    assert fakes.models[0].closed
    assert manager._active is None
    assert not root.exists() or tuple(root.iterdir()) == ()


async def test_singleton_api_returns_exact_active_session_id(tmp_path: Path) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    first = await create_valid(manager)
    app = create_app(HarnessConfig(bearer_token=TOKEN), HarnessDependencies(sessions=manager))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://harness.test") as client:
        response = await client.post("/v1/sessions", files=multipart_parts(), headers=AUTHORIZATION)

    assert response.status_code == 409
    assert response.json() == {"code": "session_active", "session_id": str(first.session_id)}
    await manager.delete(first.session_id)


async def test_navigation_origin_revision_ready_commands_and_resource_retention(
    tmp_path: Path,
) -> None:
    async def runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        browser: FakeBrowser,
        gate: HumanGate,
        step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await step(1, f"https://jobs.example/openings/42?email={PROFILE_SECRET}")
        navigation = await gate.request_human_navigation(
            f"Complete verification for {PROFILE_SECRET}", browser
        )
        if navigation.is_done:
            return ApplicationRunResult.model_validate_json(navigation.extracted_content)
        first_review = await gate.request_human_review(ready_result(), browser)
        if first_review.is_done:
            return ready_result(revision_count=gate.revision_count)
        assert first_review.long_term_memory == "Use the corrected project example"
        second_review = await gate.request_human_review(
            ready_result(revision_count=gate.revision_count), browser
        )
        assert second_review.is_done and second_review.success
        return ready_result(revision_count=gate.revision_count)

    manager, fakes, root = make_manager(tmp_path, runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "awaiting_human_navigation")
    record = manager._active
    assert record is not None and record.browser is not None and record.human_gate is not None
    record.browser.current_url = "https://ats.example/application/42?token=private"

    await manager.command(created.session_id, ContinueCommand(type="continue"))
    await wait_state(manager, created.session_id, "awaiting_origin_approval")
    with pytest.raises(HarnessServiceError) as wrong_origin:
        await manager.command(
            created.session_id,
            ApproveOriginCommand(type="approve_origin", origin="https://wrong.example"),
        )
    assert_service_error(
        wrong_origin.value,
        409,
        "command_conflict",
        "The approved origin does not match the pending origin",
    )
    await manager.command(
        created.session_id,
        ApproveOriginCommand(type="approve_origin", origin="https://ats.example"),
    )
    await wait_state(manager, created.session_id, "awaiting_human_review")
    await manager.command(
        created.session_id,
        ReviseCommand(type="revise", context="  Use the corrected project example  "),
    )
    await wait_until(
        lambda: manager._active is not None
        and manager._active.human_gate is not None
        and manager._active.human_gate.pending_kind == "review"
    )
    await manager.command(created.session_id, ReadyCommand(type="ready"))
    await wait_state(manager, created.session_id, "ready_for_human_submit")

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.revision_count == 1
    assert snapshot.approved_origins == ["https://jobs.example", "https://ats.example"]
    assert record.human_gate.approved_origins == (
        "https://jobs.example",
        "https://ats.example",
    )
    assert record.human_gate.sensitive_data["https://ats.example"]["email"] == PROFILE_SECRET
    assert record.browser.browser_profile.allowed_domains == [
        "https://jobs.example/",
        "https://ats.example/",
    ]
    event_names = [event.event for event in record.events]
    assert event_names == [
        "session_started",
        "agent_step",
        "human_navigation_required",
        "origin_approval_required",
        "review_required",
        "revision_applied",
        "review_required",
        "ready_for_human_submit",
    ]
    assert [event.id for event in record.events] == list(range(1, 9))
    public_events = json.dumps([event.model_dump(mode="json") for event in record.events])
    assert PROFILE_SECRET not in public_events
    assert "token=private" not in public_events
    assert record.browser.killed is False
    assert record.model is not None and record.model.closed is False
    assert record.stored is not None and record.stored.session_directory.exists()
    assert any(root.iterdir())

    await manager.delete(created.session_id)


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
        browser: FakeBrowser,
        gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        try:
            action = await gate.request_human_navigation("Continue in the browser", browser)
            return ApplicationRunResult.model_validate_json(action.extracted_content)
        finally:
            order.append("runner.done")

    manager, fakes, _root = make_manager(
        tmp_path, gated_runner, fakes=Fakes(order=order)
    )
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "awaiting_human_navigation")
    record = manager._active
    assert record is not None and record.stored is not None
    artifact_directory = record.stored.session_directory
    original_publish = manager._publish_event

    async def observed_publish(
        current_record: Any, event: str, detail: dict[str, object]
    ) -> None:
        if event == "closed":
            assert manager._active is record
            assert not artifact_directory.exists()
            order.append("event.closed")
        await original_publish(current_record, event, detail)

    manager._publish_event = observed_publish  # type: ignore[method-assign]

    await manager.delete(created.session_id)

    assert order.index("gate.cancel") < order.index("runner.done")
    assert order.index("runner.done") < order.index("browser.kill")
    assert order.index("browser.kill") < order.index("model.aclose")
    assert order.index("model.aclose") < order.index("artifacts.cleanup")
    assert order.index("artifacts.cleanup") < order.index("event.closed")
    assert not artifact_directory.exists()
    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "closed" and snapshot.error is None
    tombstone = manager._tombstones[created.session_id]
    assert tombstone.events[-1].event == "closed"
    assert manager._active is None
    assert fakes.browsers[0].killed and fakes.models[0].closed

    event_count = len(tombstone.events)
    await manager.delete(created.session_id)
    assert len(manager._tombstones[created.session_id].events) == event_count

    manager._publish_event = original_publish  # type: ignore[method-assign]

    replacement = await create_valid(manager)
    assert replacement.session_id != created.session_id
    await manager.delete(replacement.session_id)


@pytest.mark.parametrize(
    ("failure", "expected_code"),
    [
        (ApplicationAgentFailure("application_mismatch"), "application_mismatch"),
        (ApplicationAgentFailure("step_limit"), "step_limit"),
        (
            PipelineModelError("oauth_required", SESSION_ERROR_MESSAGES["oauth_required"]),
            "oauth_required",
        ),
        (
            PipelineModelError("model_timeout", SESSION_ERROR_MESSAGES["model_timeout"]),
            "model_timeout",
        ),
        (
            PipelineModelError(
                "invalid_model_output", SESSION_ERROR_MESSAGES["invalid_model_output"]
            ),
            "invalid_model_output",
        ),
        (
            PipelineModelError("model_failed", SESSION_ERROR_MESSAGES["model_failed"]),
            "model_failed",
        ),
        (RuntimeError("raw provider secret must not escape"), "browser_failed"),
    ],
    ids=[
        "mismatch",
        "step-limit",
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
        _browser: FakeBrowser,
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
    assert fakes.browsers[0].killed and fakes.models[0].closed
    assert manager._active is None
    assert manager._tombstones[created.session_id].events[-1].event == "failed"


async def test_cancelled_runner_result_has_no_error_and_releases_slot(tmp_path: Path) -> None:
    async def cancelled_runner(
        request: ApplicationRunRequest,
        _model: FakeModel,
        _browser: FakeBrowser,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        return ApplicationRunResult(
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
    assert manager._active is None
    assert fakes.browsers[0].killed and fakes.models[0].closed


async def test_cancel_command_interrupts_active_model_call_before_cleanup(tmp_path: Path) -> None:
    order: list[str] = []

    async def model_runner(
        _request: ApplicationRunRequest,
        model: FakeModel,
        _browser: FakeBrowser,
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
    assert order.index("model.active_finished") < order.index("browser.kill")
    assert order.index("browser.kill") < order.index("model.aclose")


async def test_delete_during_blocked_preflight_cancels_setup_and_cleans_without_browser(
    tmp_path: Path,
) -> None:
    blocker = asyncio.Event()
    fakes = Fakes(check_blocker=blocker)
    manager, fakes, root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(fakes.models) and fakes.models[0].check_started.is_set())
    record = manager._active
    assert record is not None

    await manager.delete(record.session_id)

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)
    assert fakes.browsers == []
    assert fakes.models[0].closed
    assert manager.get_snapshot(record.session_id).state == "closed"
    assert manager._tombstones[record.session_id].events[-1].event == "closed"
    assert manager._active is None
    await manager.delete(record.session_id)
    assert manager.get_snapshot(record.session_id).state == "closed"
    assert not root.exists() or tuple(root.iterdir()) == ()


async def test_absolute_ttl_maps_to_session_timeout_without_real_sleep(tmp_path: Path) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, timeout=1)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = manager._active
    assert record is not None and record.ttl_task is not None
    record.ttl_task.cancel()
    record.created_monotonic = asyncio.get_running_loop().time() - 1

    await manager._expire_session(record)
    await wait_state(manager, created.session_id, "failed")

    snapshot = manager.get_snapshot(created.session_id)
    assert snapshot.state == "failed"
    assert snapshot.error is not None
    assert snapshot.error.model_dump() == {
        "code": "session_timeout",
        "message": "The application session expired",
    }
    assert fakes.browsers[0].killed and fakes.models[0].closed


async def test_shutdown_finalizes_active_session_and_rejects_new_sessions(tmp_path: Path) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")

    await manager.shutdown()

    assert manager.get_snapshot(created.session_id).state == "closed"
    assert manager._tombstones[created.session_id].events[-1].event == "closed"
    assert fakes.browsers[0].killed and fakes.models[0].closed
    personal, resume = valid_uploads()
    with pytest.raises(HarnessServiceError) as caught:
        await manager.create_session(
            job_url=JOB_URL,
            allow_domains=[],
            max_steps=100,
            personal_information=personal,
            resume=resume,
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
    async def immediate_ready(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        _browser: FakeBrowser,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        return ready_result()

    manager, _fakes, _root = make_manager(tmp_path, immediate_ready)
    session_ids: list[UUID] = []
    for _ in range(33):
        created = await create_valid(manager)
        session_ids.append(created.session_id)
        await wait_state(manager, created.session_id, "ready_for_human_submit")
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
    record = manager._active
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


async def test_sse_heartbeat_and_disconnect_do_not_cancel_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager, fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    record = manager._active
    assert record is not None
    latest = record.events[-1].id
    monkeypatch.setattr(sessions_module, "_HEARTBEAT_SECONDS", 0.001)

    stream = manager.stream_events(created.session_id, latest)
    heartbeat = await asyncio.wait_for(anext(stream), timeout=1)
    assert heartbeat == ": heartbeat\n\n"
    await stream.aclose()

    assert manager._active is record
    assert record.agent_task is not None and not record.agent_task.done()
    assert fakes.browsers[0].killed is False
    await manager.delete(created.session_id)


async def test_api_unknown_and_terminal_command_responses(tmp_path: Path) -> None:
    manager, _fakes, _root = make_manager(tmp_path, blocked_runner)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    app = create_app(HarnessConfig(bearer_token=TOKEN), HarnessDependencies(sessions=manager))
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
    assert invalid_command.status_code == 422
    assert invalid_command.json() == {"code": "invalid_request", "message": "Request is invalid"}
    assert no_pending_gate.status_code == 409
    assert no_pending_gate.json() == {
        "code": "command_conflict",
        "message": "No matching human gate is pending",
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
    kill_blocker = asyncio.Event()
    fakes = Fakes(browser_kill_blocker=kill_blocker)
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")

    await manager.command(created.session_id, CancelCommand(type="cancel"))
    await wait_until(
        lambda: bool(fakes.browsers) and fakes.browsers[0].kill_started.is_set()
    )
    assert manager._active is not None
    assert manager.get_snapshot(created.session_id).state == "running"
    with pytest.raises(HarnessServiceError) as duplicate:
        await manager.command(created.session_id, CancelCommand(type="cancel"))
    assert_service_error(
        duplicate.value,
        409,
        "command_conflict",
        "A terminal command is already pending",
    )

    kill_blocker.set()
    await wait_state(manager, created.session_id, "cancelled")
    assert manager._active is None


async def test_delete_during_natural_finalization_joins_shielded_owner_and_closes(
    tmp_path: Path,
) -> None:
    kill_blocker = asyncio.Event()

    async def failing_runner(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        _browser: FakeBrowser,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        raise RuntimeError("synthetic runner failure")

    fakes = Fakes(browser_kill_blocker=kill_blocker)
    manager, fakes, _root = make_manager(tmp_path, failing_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_until(lambda: fakes.browsers[0].kill_started.is_set())
    record = manager._active
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
    kill_blocker.set()
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

    kill_blocker = asyncio.Event()
    close_blocker = asyncio.Event()
    fakes = Fakes(
        browser_kill_blocker=kill_blocker,
        model_close_blocker=close_blocker,
    )
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    monkeypatch.setattr(sessions_module.asyncio, "wait_for", observing_wait_for)

    await manager.command(created.session_id, CancelCommand(type="cancel"))
    await original_wait_for(fakes.browsers[0].kill_started.wait(), timeout=1)
    await original_sleep(0)
    record = manager._active
    assert record is not None and record.browser_kill_task is not None
    assert not record.browser_kill_task.cancelled()
    assert fakes.browsers[0].killed is False

    kill_blocker.set()
    await original_wait_for(fakes.models[0].close_started.wait(), timeout=1)
    await original_sleep(0)
    assert manager._active is record
    assert record.model_close_task is not None
    assert not record.model_close_task.cancelled()
    assert fakes.models[0].closed is False

    close_blocker.set()
    await wait_state(manager, created.session_id, "cancelled")
    assert timed_out == {30}
    assert observations == 4
    assert manager._active is None
    assert fakes.browsers[0].killed and fakes.models[0].closed
    assert fakes.order.count("browser.kill") == 1
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
    record = manager._active
    assert record is not None and record.stored is not None
    artifact_directory = record.stored.session_directory

    deletion = asyncio.create_task(manager.delete(record.session_id))
    await asyncio.wait_for(process.terminate_started.wait(), timeout=1)
    assert not deletion.done()
    assert manager._active is record
    assert artifact_directory.exists()
    process.allow_terminate.set()
    await asyncio.wait_for(deletion, timeout=1)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)

    assert process.worker_finished.is_set()
    assert not artifact_directory.exists()
    assert manager._active is None
    assert manager.get_snapshot(record.session_id).state == "closed"


async def test_absolute_ttl_begins_during_model_preflight_setup(tmp_path: Path) -> None:
    blocker = asyncio.Event()
    fakes = Fakes(check_blocker=blocker)
    manager, fakes, _root = make_manager(
        tmp_path, blocked_runner, fakes=fakes, timeout=1
    )
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(fakes.models) and fakes.models[0].check_started.is_set())
    record = manager._active
    assert record is not None and record.ttl_task is not None
    record.ttl_task.cancel()
    record.created_monotonic = asyncio.get_running_loop().time() - 1

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
    assert fakes.browsers == []
    assert fakes.models[0].closed


async def test_cancel_while_starting_publishes_terminal_tombstone_then_delete_is_idempotent(
    tmp_path: Path,
) -> None:
    blocker = asyncio.Event()
    fakes = Fakes(check_blocker=blocker)
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(lambda: bool(fakes.models) and fakes.models[0].check_started.is_set())
    record = manager._active
    assert record is not None

    await manager.command(record.session_id, CancelCommand(type="cancel"))
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)
    await wait_state(manager, record.session_id, "cancelled")
    tombstone = manager._tombstones[record.session_id]
    assert tombstone.events[-1].event == "cancelled"
    assert manager._active is None

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
    record = manager._active
    assert record is not None

    first_delete = asyncio.create_task(manager.delete(record.session_id))
    await asyncio.wait_for(fakes.models[0].close_started.wait(), timeout=1)
    first_delete.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first_delete
    assert record.finalizer_task is not None and not record.finalizer_task.cancelled()
    assert manager._active is record

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
    assert manager._active is None


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
        _browser: FakeBrowser,
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
    personal, resume = valid_uploads()
    created = await manager.create_session(
        job_url=private_job_url,
        allow_domains=[],
        max_steps=100,
        personal_information=personal,
        resume=resume,
        context=[],
        anecdotes=[],
    )
    await wait_until(
        lambda: manager._active is not None and len(manager._active.events) >= 2
    )
    record = manager._active
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
    kill_blocker = asyncio.Event()
    fakes = Fakes(browser_kill_blocker=kill_blocker)
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
    assert manager._active is not None
    kill_blocker.set()
    await wait_state(manager, created.session_id, "cancelled")


async def test_delete_closes_session_that_moves_from_active_to_tombstone_mid_request(
    tmp_path: Path,
) -> None:
    runner_release = asyncio.Event()

    async def naturally_cancelled(
        request: ApplicationRunRequest,
        _model: FakeModel,
        _browser: FakeBrowser,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await runner_release.wait()
        return ApplicationRunResult(
            status="cancelled",
            job_url=request.session.job_url,
            final_url=request.session.job_url,
            submit_attempted=False,
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
    assert manager._active is not None
    assert created.session_id not in manager._tombstones
    allow_cleanup.set()
    await wait_state(manager, created.session_id, "cancelled")
    assert manager._active is None


@pytest.mark.parametrize(
    ("resource", "operation"),
    [
        ("browser", "delete"),
        ("browser", "shutdown"),
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
        browser_kill_failures=1 if resource == "browser" else 0,
        browser_kill_blocker=blocker if resource == "browser" else None,
        model_close_failures=1 if resource == "model" else 0,
        model_close_blocker=blocker if resource == "model" else None,
    )
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    created = await create_valid(manager)
    await wait_state(manager, created.session_id, "running")
    monkeypatch.setattr(sessions_module.asyncio, "sleep", no_delay)
    record = manager._active
    assert record is not None

    caller = asyncio.create_task(
        manager.delete(created.session_id)
        if operation == "delete"
        else manager.shutdown()
    )
    cleanup_name = "browser.kill" if resource == "browser" else "model.aclose"
    await wait_until(lambda: fakes.order.count(cleanup_name) >= 2)

    assert not caller.done()
    assert record.finalizer_task is not None and not record.finalizer_task.done()
    assert manager._active is record
    assert created.session_id not in manager._tombstones
    assert manager.get_snapshot(created.session_id).state == "running"
    blocker.set()
    await asyncio.wait_for(caller, timeout=1)

    assert fakes.order.count(cleanup_name) == 2
    assert manager._active is None
    assert manager.get_snapshot(created.session_id).state == "closed"
    assert manager._tombstones[created.session_id].events[-1].event == "closed"


async def test_resume_path_resolution_task_is_joined_before_browser_and_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = ThreadEvent()
    release = ThreadEvent()
    order: list[str] = []
    original_resolver = sessions_module.resolve_resume_upload_path

    def slow_resolver(path: Path, launch: ResolvedBrowserLaunch) -> str:
        started.set()
        if not release.wait(timeout=2):
            raise RuntimeError("test did not release resume path resolution")
        resolved = original_resolver(path, launch)
        order.append("resume.resolved")
        return resolved

    monkeypatch.setattr(sessions_module, "resolve_resume_upload_path", slow_resolver)
    fakes = Fakes(order=order)
    manager, fakes, _root = make_manager(tmp_path, blocked_runner, fakes=fakes)
    creation = asyncio.create_task(create_valid(manager))
    await wait_until(started.is_set)
    record = manager._active
    assert record is not None and record.resume_path_task is not None
    assert record.stored is not None
    artifact_directory = record.stored.session_directory

    deletion = asyncio.create_task(manager.delete(record.session_id))
    await asyncio.sleep(0)
    assert not deletion.done()
    assert artifact_directory.exists()
    assert fakes.browsers[0].killed is False
    release.set()
    await asyncio.wait_for(deletion, timeout=1)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)

    assert order.index("resume.resolved") < order.index("browser.kill")
    assert not artifact_directory.exists()
    assert manager.get_snapshot(record.session_id).state == "closed"


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
    encoded_secret = "ada.private%252525252540example.test"
    job_url = (
        f"https://a.example/Apply/%252525252541/{encoded_secret}/{PROFILE_SECRET}"
        "?private=yes"
    )

    async def stepping(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        _browser: FakeBrowser,
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
        allow_domains=[],
        max_steps=100,
        personal_information=personal,
        resume=resume,
        context=[],
        anecdotes=[],
    )
    await wait_until(
        lambda: manager._active is not None and len(manager._active.events) >= 2
    )
    record = manager._active
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


async def test_encoded_gate_result_and_file_values_are_redacted_or_generic(
    tmp_path: Path,
) -> None:
    raw_secret = "ada.private%40example.test"
    normalized_secret = "ada.private@example.test"
    encoded_secret = "ada.private%25252540example.test"
    private_job_url = f"https://jobs.example/openings/{encoded_secret}?private=yes"
    def private_result() -> ApplicationRunResult:
        return ApplicationRunResult(
            status="ready_for_human_submit",
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
            warnings=[encoded_secret],
            submit_attempted=False,
        )

    async def gated(
        _request: ApplicationRunRequest,
        _model: FakeModel,
        browser: FakeBrowser,
        gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        navigation = await gate.request_human_navigation(encoded_secret, browser)
        assert not navigation.is_done
        review = await gate.request_human_review(private_result(), browser)
        assert review.is_done
        return private_result()

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
        allow_domains=[],
        max_steps=100,
        personal_information=personal,
        resume=upload("resume.pdf", pdf_bytes()),
        context=[],
        anecdotes=[],
    )
    await wait_state(manager, created.session_id, "awaiting_human_navigation")
    await manager.command(created.session_id, ContinueCommand(type="continue"))
    await wait_state(manager, created.session_id, "awaiting_human_review")
    review_snapshot = manager.get_snapshot(created.session_id)
    assert review_snapshot.company == "[redacted]"
    assert review_snapshot.role == "[redacted]"
    assert review_snapshot.fields_filled[0].label == "[redacted]"
    assert review_snapshot.fields_filled[0].note == "Filled"
    assert review_snapshot.files_attached == ["resume.pdf"]
    assert review_snapshot.warnings == [
        "The application agent reported warnings; review all listed fields before submitting."
    ]
    await manager.command(created.session_id, ReadyCommand(type="ready"))
    await wait_state(manager, created.session_id, "ready_for_human_submit")
    record = manager._active
    assert record is not None
    public = json.dumps(
        {
            "snapshot": manager.get_snapshot(created.session_id).model_dump(mode="json"),
            "events": [event.model_dump(mode="json") for event in record.events],
        }
    )
    assert raw_secret not in public
    assert normalized_secret not in public
    assert encoded_secret not in public
    assert "private=yes" not in public
    await manager.delete(created.session_id)


async def test_pipeline_model_close_cancellation_preserves_and_joins_client_task() -> None:
    class BlockingClient:
        def __init__(self) -> None:
            self.started = asyncio.Event()
            self.release = asyncio.Event()
            self.calls = 0
            self.is_closed = False

        async def aclose(self) -> None:
            self.calls += 1
            self.started.set()
            await self.release.wait()

    model = PipelineOAuthChatModel(uuid4(), "http://127.0.0.1:3457", TOKEN)
    await model._client.aclose()
    client = BlockingClient()
    model._client = client  # type: ignore[assignment]
    first = asyncio.create_task(model.aclose())
    await asyncio.wait_for(client.started.wait(), timeout=1)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    assert model._close_task is not None
    assert not model._close_task.cancelled()

    joined = asyncio.create_task(model.aclose())
    await asyncio.sleep(0)
    assert not joined.done()
    client.release.set()
    await asyncio.wait_for(joined, timeout=1)
    assert client.calls == 1
    assert model._closed is True


async def test_pipeline_model_retries_pinned_transport_close_after_closed_client_failure() -> None:
    class RetryTransport:
        def __init__(self) -> None:
            self.calls = 0

        async def aclose(self) -> None:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("synthetic transport close failure")

    class ClosedClient:
        def __init__(self, transport: RetryTransport) -> None:
            self.is_closed = True
            self._transport = transport

    model = PipelineOAuthChatModel(uuid4(), "http://127.0.0.1:3457", TOKEN)
    await model._client.aclose()
    transport = RetryTransport()
    model._client = ClosedClient(transport)  # type: ignore[assignment]

    with pytest.raises(RuntimeError, match="synthetic transport close failure"):
        await model.aclose()
    assert model._close_task is None
    assert model._closed is False
    await model.aclose()
    assert transport.calls == 2
    assert model._closed is True


async def test_candidate_context_process_returns_valid_context_and_closes(
    tmp_path: Path,
) -> None:
    personal, resume = valid_uploads()
    session_id = uuid4()
    stored = await store_uploads(
        tmp_path,
        session_id,
        personal,
        resume,
        [],
        [],
    )
    process = CandidateContextProcess(stored)
    try:
        candidate = await asyncio.wait_for(process.result(), timeout=10)
        assert candidate.direct_fields["email"] == PROFILE_SECRET
        assert "Deterministic resume evidence" in candidate.resume_text
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
    record = manager._active
    assert record is not None and record.stored is not None
    artifact_directory = record.stored.session_directory
    monkeypatch.setattr(sessions_module.asyncio, "sleep", no_delay)
    deletion = asyncio.create_task(manager.delete(record.session_id))
    await wait_until(lambda: instances[0].calls >= 2)

    assert not deletion.done()
    assert manager._active is record
    assert artifact_directory.exists()
    assert fakes.browsers == []
    assert fakes.models == []
    instances[0].release.set()
    await asyncio.wait_for(deletion, timeout=1)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(creation, timeout=1)
    assert instances[0].calls == 2
    assert not artifact_directory.exists()
    assert manager._active is None
    assert manager.get_snapshot(record.session_id).state == "closed"
    assert manager._tombstones[record.session_id].events[-1].event == "closed"


async def test_shutdown_upgrades_active_to_terminal_race_tombstone_to_closed(
    tmp_path: Path,
) -> None:
    runner_release = asyncio.Event()

    async def naturally_cancelled(
        request: ApplicationRunRequest,
        _model: FakeModel,
        _browser: FakeBrowser,
        _gate: HumanGate,
        _step: Callable[[int, str], Awaitable[None]],
    ) -> ApplicationRunResult:
        await runner_release.wait()
        return ApplicationRunResult(
            status="cancelled",
            job_url=request.session.job_url,
            final_url=request.session.job_url,
            submit_attempted=False,
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
