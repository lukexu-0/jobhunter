from __future__ import annotations

import asyncio
import tempfile
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any
from uuid import UUID

import pytest
from browser_use.agent.views import ActionResult

from browser_use.tools.service import Tools

import jobhunter_browser_harness.agent as agent_module
import jobhunter_browser_harness.tools as tools_module
from jobhunter_browser_harness.agent import (
    LLM_TIMEOUT_SECONDS,
    STEP_TIMEOUT_SECONDS,
    ApplicationAgentFailure,
    ApplicationRunRequest,
    build_application_task,
    run_application,
)
from jobhunter_browser_harness.context import AttributedSource, CandidateContext
from jobhunter_browser_harness.models import (
    ApplicationRunResult,
    HarnessServiceError,
    SessionCreateRequest,
    UploadedArtifacts,
)
from jobhunter_browser_harness.tools import (
    APPLICATION_MISMATCH_RESULT,
    DEFAULT_ACTIONS_0_13_4,
    HumanGate,
    create_unfiltered_tools,
)


SESSION_ID = UUID("39bb70b2-5ea4-4937-8090-32d7404ad597")
JOB_URL = "https://jobs.example/openings/42?source=private"
JOB_ORIGIN = "https://jobs.example"
ATS_ORIGIN = "https://ats.example"

EXPECTED_DEFAULT_ACTIONS = frozenset(
    {
        "done",
        "search",
        "navigate",
        "go_back",
        "wait",
        "click",
        "input",
        "upload_file",
        "switch",
        "close",
        "extract",
        "search_page",
        "find_elements",
        "scroll",
        "send_keys",
        "find_text",
        "screenshot",
        "save_as_pdf",
        "dropdown_options",
        "select_dropdown",
        "write_file",
        "replace_file",
        "read_file",
        "evaluate",
    }
)
CUSTOM_ACTIONS = frozenset(
    {
        "request_human_navigation",
        "request_origin_approval",
        "report_application_mismatch",
        "request_human_review",
    }
)


@dataclass(slots=True)
class FakeBrowserProfile:
    allowed_domains: list[str]


@dataclass(slots=True)
class FakeTarget:
    url: str


class FakeSessionManager:
    def __init__(self, url: str) -> None:
        self.target = FakeTarget(url)

    def get_target(self, target_id: str) -> FakeTarget | None:
        return self.target if target_id == "target" else None


class FakeBrowserSession:
    def __init__(self, url: str = JOB_URL, domains: list[str] | None = None) -> None:
        self.current_url = url
        self.browser_profile = FakeBrowserProfile(
            domains if domains is not None else [f"{JOB_ORIGIN}/"]
        )
        self.agent_focus_target_id = "target"
        self.session_manager = FakeSessionManager(url)
        self.cdp_client = None

    async def get_current_page_url(self) -> str:
        return self.current_url


class EventPublisher:
    def __init__(self) -> None:
        self.events: list[tuple[str, str | None, dict[str, object]]] = []
        self.published = asyncio.Event()

    async def __call__(
        self, state: str, event: str | None, detail: dict[str, object]
    ) -> None:
        self.events.append((state, event, dict(detail)))
        self.published.set()

    async def next_event(self, after: int = 0) -> tuple[str, str | None, dict[str, object]]:
        async with asyncio.timeout(1):
            while len(self.events) <= after:
                self.published.clear()
                if len(self.events) <= after:
                    await self.published.wait()
        return self.events[after]


def make_candidate() -> CandidateContext:
    return CandidateContext(
        direct_fields=MappingProxyType(
            {
                "full_name": "Ada Secret-Value",
                "email": "private-person@example.test",
                "work_authorization": "Explicit authorization fact",
            }
        ),
        resume_text="Built a deterministic data service for Example Corp.",
        profile_narrative=AttributedSource(
            name="profile.md",
            category="profile",
            text="Prefers infrastructure roles and careful operational work.",
        ),
        context_sources=(
            AttributedSource(
                name="background.md",
                category="context",
                text="The candidate maintained an internal deployment platform.",
            ),
        ),
        anecdotes=(
            AttributedSource(
                name="incident.md",
                category="anecdote",
                text="Resolved a relevant production incident without inventing metrics.",
            ),
            AttributedSource(
                name="irrelevant.md",
                category="anecdote",
                text="An unrelated volunteer story.",
            ),
        ),
    )


def make_gate(
    *,
    publisher: EventPublisher | None = None,
    approved_origins: list[str] | None = None,
    sensitive_data: dict[str, dict[str, str]] | None = None,
    action_timeout: float = 1,
    review_snapshot: Any = None,
) -> tuple[HumanGate, EventPublisher, dict[str, dict[str, str]]]:
    publisher = publisher or EventPublisher()
    origins = approved_origins or [JOB_ORIGIN]
    shared_sensitive = sensitive_data or {
        origin: dict(make_candidate().direct_fields) for origin in origins
    }
    gate = HumanGate(
        job_url=JOB_URL,
        candidate=make_candidate(),
        approved_origins=origins,
        sensitive_data=shared_sensitive,
        publish=publisher,
        review_snapshot=review_snapshot,
        action_timeout=action_timeout,
    )
    return gate, publisher, shared_sensitive


def make_result(
    *,
    status: str = "cancelled",
    job_url: str = JOB_URL,
    final_url: str = JOB_URL,
) -> ApplicationRunResult:
    return ApplicationRunResult.model_validate(
        {
            "status": status,
            "company": "Example Corp",
            "role": "Platform Engineer",
            "job_url": job_url,
            "final_url": final_url,
            "fields_filled": [
                {
                    "label": "Email",
                    "field_type": "text",
                    "value_present": True,
                    "note": "Filled from an explicit placeholder.",
                }
            ],
            "fields_needing_human": [],
            "files_attached": ["resume.pdf"],
            "warnings": [],
            "revision_count": 0,
            "submit_attempted": False,
        }
    )


def make_request(tmp_path: Path, *, max_steps: int = 3) -> ApplicationRunRequest:
    session_directory = tmp_path / "session"
    session_directory.mkdir()
    resume = session_directory / "resume.pdf"
    resume.write_bytes(b"%PDF-test")
    artifacts = UploadedArtifacts(
        session_directory=session_directory,
        personal_information=session_directory / "profile.md",
        resume=resume,
    )
    session = SessionCreateRequest(
        session_id=SESSION_ID,
        job_url=JOB_URL,
        approved_origins=(JOB_ORIGIN,),
        max_steps=max_steps,
        artifacts=artifacts,
    )
    return ApplicationRunRequest(
        session=session,
        candidate=make_candidate(),
        resume_display_name="resume.pdf",
    )


def assert_conflict(error: BaseException) -> None:
    assert isinstance(error, HarnessServiceError)
    assert error.status_code == 409
    assert error.code == "command_conflict"


async def accept_ready(gate: HumanGate, browser: FakeBrowserSession) -> ApplicationRunResult:
    review = asyncio.create_task(gate.request_human_review(make_result(), browser))
    async with asyncio.timeout(1):
        while gate.pending_kind != "review":
            await asyncio.sleep(0)
    await gate.ready()
    action_result = await review
    return ApplicationRunResult.model_validate_json(action_result.extracted_content)


def make_action(tools: Tools, name: str, params: dict[str, Any]) -> Any:
    action_model = tools.registry.create_action_model(include_actions=[name])
    return action_model(**{name: params})


def test_unfiltered_registry_is_exact_and_custom_actions_are_strictly_additive() -> None:
    gate, _, _ = make_gate()
    baseline = tools_module._HarnessTools(gate, None)
    baseline_actions = baseline.registry.registry.actions
    assert frozenset(baseline_actions) == EXPECTED_DEFAULT_ACTIONS
    assert DEFAULT_ACTIONS_0_13_4 == EXPECTED_DEFAULT_ACTIONS
    original_done = baseline_actions["done"]

    @baseline.action("Test-only additive action.")
    async def additive_probe() -> None:
        return None

    assert baseline.registry.registry.actions["done"] is original_done

    configured = create_unfiltered_tools(gate)
    configured_actions = configured.registry.registry.actions

    assert frozenset(configured_actions) == EXPECTED_DEFAULT_ACTIONS | CUSTOM_ACTIONS
    assert {
        "click",
        "input",
        "upload_file",
        "send_keys",
        "evaluate",
        "done",
    } <= configured_actions.keys()
    assert all(configured_actions[name].terminates_sequence for name in CUSTOM_ACTIONS)


@pytest.mark.asyncio
async def test_custom_actions_redact_direct_values_from_events_and_public_review() -> None:
    candidate = make_candidate()
    direct_values = tuple(candidate.direct_fields.values())
    navigation_gate, navigation_publisher, _ = make_gate()
    navigation_tools = create_unfiltered_tools(navigation_gate)
    browser = FakeBrowserSession()
    navigation = make_action(
        navigation_tools,
        "request_human_navigation",
        {
            "instruction": (
                "Ask <secret>email</secret> "
                f"({candidate.direct_fields['email']}) to finish login."
            )
        },
    )
    pending_navigation = asyncio.create_task(
        navigation_tools.act(navigation, browser, action_timeout=1)
    )
    _, event, detail = await navigation_publisher.next_event()
    assert event == "human_navigation_required"
    assert detail == {
        "instruction": "Ask <secret>email</secret> ([redacted]) to finish login."
    }
    assert all(secret not in str(detail) for secret in direct_values)
    await navigation_gate.cancel()
    await pending_navigation

    snapshots: list[ApplicationRunResult] = []

    async def capture_snapshot(snapshot: ApplicationRunResult) -> None:
        snapshots.append(snapshot)

    review_gate, review_publisher, _ = make_gate(review_snapshot=capture_snapshot)
    review_tools = create_unfiltered_tools(review_gate)
    secret_result = ApplicationRunResult.model_validate(
        {
            **make_result().model_dump(),
            "company": f"Company for {candidate.direct_fields['full_name']}",
            "role": f"Role sent to {candidate.direct_fields['email']}",
            "fields_filled": [
                {
                    "label": f"Email {candidate.direct_fields['email']}",
                    "field_type": "text",
                    "value_present": True,
                    "note": f"Filled with {candidate.direct_fields['email']}",
                }
            ],
            "fields_needing_human": [
                {
                    "label": f"Authorization {candidate.direct_fields['work_authorization']}",
                    "field_type": "select",
                    "value_present": False,
                    "note": f"Missing {candidate.direct_fields['work_authorization']}",
                }
            ],
            "warnings": [f"Check {candidate.direct_fields['full_name']}"],
        }
    )
    review_action = make_action(
        review_tools, "request_human_review", secret_result.model_dump()
    )
    pending_review = asyncio.create_task(
        review_tools.act(review_action, browser, action_timeout=1)
    )
    await review_publisher.next_event()
    assert len(snapshots) == 1
    snapshot = snapshots[0]
    serialized_snapshot = snapshot.model_dump_json()
    assert all(secret not in serialized_snapshot for secret in direct_values)
    assert snapshot.fields_filled[0].note == "Filled"
    assert snapshot.fields_needing_human[0].note == "Needs human review"
    assert snapshot.warnings == [
        "The application agent reported warnings; review all listed fields before submitting."
    ]
    await review_gate.ready()
    ready = await pending_review
    assert ready.success is True
    assert ready.extracted_content == serialized_snapshot


@pytest.mark.asyncio
async def test_sensitive_placeholders_substitute_only_for_input_on_exact_approved_origins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captures: list[tuple[str, Any]] = []

    async def capture_registered(**kwargs: Any) -> ActionResult:
        params = kwargs["params"]
        text = getattr(params, "text", getattr(params, "code", None))
        captures.append((type(params).__name__, text))
        return ActionResult(extracted_content="captured")

    for origin, current_url in (
        ("https://jobs.example:8443", "https://jobs.example:8443/apply"),
        ("https://[::1]:9443", "https://[::1]:9443/apply"),
    ):
        gate, _, _ = make_gate(approved_origins=[origin])
        tools = create_unfiltered_tools(gate)
        monkeypatch.setattr(
            tools.registry.registry.actions["input"], "function", capture_registered
        )
        action = make_action(
            tools,
            "input",
            {"index": 1, "text": "<secret>email</secret>", "clear": True},
        )
        result = await tools.act(action, FakeBrowserSession(current_url, [f"{origin}/"]))
        assert result.error is None
        assert captures[-1][1] == make_candidate().direct_fields["email"]

    port_gate, _, _ = make_gate(approved_origins=["https://jobs.example:8443"])
    port_tools = create_unfiltered_tools(port_gate)
    monkeypatch.setattr(
        port_tools.registry.registry.actions["input"],
        "function",
        capture_registered,
    )
    before = len(captures)
    blocked = await port_tools.act(
        make_action(
            port_tools,
            "input",
            {"index": 1, "text": "<secret>email</secret>", "clear": True},
        ),
        FakeBrowserSession(
            "https://jobs.example:9443/apply",
            ["https://jobs.example:8443/"],
        ),
    )
    assert blocked.error == (
        "The current origin requires exact human approval before this action."
    )
    assert len(captures) == before

    monkeypatch.setattr(
        port_tools.registry.registry.actions["evaluate"],
        "function",
        capture_registered,
    )
    evaluated = await port_tools.act(
        make_action(
            port_tools,
            "evaluate",
            {"code": "'<secret>email</secret>'"},
        ),
        FakeBrowserSession(
            "https://jobs.example:8443/apply",
            ["https://jobs.example:8443/"],
        ),
    )
    assert evaluated.error is None
    assert captures[-1][1] == "'<secret>email</secret>'"


@pytest.mark.asyncio
async def test_registry_recheck_suppresses_secrets_after_live_target_port_race(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    approved_origin = "https://jobs.example:8443"
    gate, _, _ = make_gate(approved_origins=[approved_origin])
    tools = create_unfiltered_tools(gate)
    captured: list[tuple[str, str]] = []

    async def capture_registered(**kwargs: Any) -> ActionResult:
        params = kwargs["params"]
        for field in ("text", "keys", "code"):
            value = getattr(params, field, None)
            if value is not None:
                captured.append((field, value))
                break
        return ActionResult(extracted_content="called")

    for name in ("input", "send_keys", "evaluate"):
        monkeypatch.setattr(
            tools.registry.registry.actions[name],
            "function",
            capture_registered,
        )

    browser = FakeBrowserSession(
        f"{approved_origin}/apply",
        [f"{approved_origin}/"],
    )
    # The harness-level check sees the approved URL, but Browser Use's registry
    # observes a target that raced to a distinct effective port.
    browser.session_manager.target.url = "https://jobs.example:9443/apply"
    raced_input = await tools.act(
        make_action(
            tools,
            "input",
            {"index": 1, "text": "<secret>email</secret>", "clear": True},
        ),
        browser,
    )
    assert raced_input.extracted_content == "called"
    assert captured[-1] == ("text", "<secret>email</secret>")

    browser.session_manager.target.url = f"{approved_origin}/apply"
    sent_keys = await tools.act(
        make_action(tools, "send_keys", {"keys": "<secret>email</secret>"}),
        browser,
    )
    evaluated = await tools.act(
        make_action(
            tools,
            "evaluate",
            {"code": "'<secret>email</secret>'"},
        ),
        browser,
    )
    assert sent_keys.extracted_content == "called"
    assert evaluated.extracted_content == "called"
    assert captured[-2:] == [
        ("keys", "<secret>email</secret>"),
        ("code", "'<secret>email</secret>'"),
    ]
    assert all(
        make_candidate().direct_fields["email"] not in value for _, value in captured
    )


@pytest.mark.asyncio
async def test_dispatch_origin_race_blocks_normal_actions_but_keeps_recovery_actions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    approved_origin = "https://jobs.example:8443"
    unapproved_origin = "https://jobs.example:9443"
    gate, _, _ = make_gate(approved_origins=[approved_origin])
    tools = create_unfiltered_tools(gate)
    dispatched: list[str] = []

    class DispatchRaceBrowser(FakeBrowserSession):
        def __init__(self) -> None:
            super().__init__(
                f"{approved_origin}/apply",
                [f"{approved_origin}/"],
            )
            self.url_reads = 0

        async def get_current_page_url(self) -> str:
            self.url_reads += 1
            if self.url_reads == 1:
                return f"{approved_origin}/apply"
            return f"{unapproved_origin}/apply"

    async def normal_action_must_not_run(**kwargs: Any) -> ActionResult:
        dispatched.append("normal")
        return ActionResult(extracted_content="unsafe dispatch")

    for action_name, params in (
        ("click", {"index": 1}),
        ("evaluate", {"code": "document.title"}),
        (
            "input",
            {"index": 1, "text": "<secret>email</secret>", "clear": True},
        ),
    ):
        monkeypatch.setattr(
            tools.registry.registry.actions[action_name],
            "function",
            normal_action_must_not_run,
        )
        blocked = await tools.act(
            make_action(tools, action_name, params),
            DispatchRaceBrowser(),
        )
        assert blocked.error == (
            "The current origin requires exact human approval before this action."
        )
    assert dispatched == []

    def recovery_capture(action_name: str) -> Any:
        async def capture(**kwargs: Any) -> ActionResult:
            dispatched.append(action_name)
            return ActionResult(extracted_content=f"{action_name} dispatched")

        return capture

    for action_name, params in (
        ("request_origin_approval", {"origin": JOB_ORIGIN}),
        ("navigate", {"url": f"{JOB_ORIGIN}/recovery"}),
    ):
        monkeypatch.setattr(
            tools.registry.registry.actions[action_name],
            "function",
            recovery_capture(action_name),
        )
        recovered = await tools.act(
            make_action(tools, action_name, params),
            DispatchRaceBrowser(),
        )
        assert recovered.extracted_content == f"{action_name} dispatched"
    assert dispatched == ["request_origin_approval", "navigate"]


@pytest.mark.asyncio
async def test_upload_guard_rejects_every_non_resume_path_before_parent_dispatch(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    resume = str(tmp_path / "resume.pdf")
    gate, _, _ = make_gate()
    tools = create_unfiltered_tools(gate, resume)
    dispatched: list[dict[str, Any]] = []

    async def fake_parent_act(
        self: Tools,
        action: Any,
        browser_session: Any,
        **kwargs: Any,
    ) -> ActionResult:
        dispatched.append(
            {
                "action": action.model_dump(exclude_unset=True),
                "available_file_paths": kwargs["available_file_paths"],
            }
        )
        return ActionResult(extracted_content="parent dispatched")

    monkeypatch.setattr(Tools, "act", fake_parent_act)
    browser = FakeBrowserSession()
    for rejected_path in (
        str(tmp_path / "agent-files" / "generated.txt"),
        str(tmp_path / "downloads" / "downloaded.pdf"),
        "/tmp/arbitrary.pdf",
        "/remote/browser/path/resume.pdf",
    ):
        rejected = await tools.act(
            make_action(
                tools,
                "upload_file",
                {"index": 7, "path": rejected_path},
            ),
            browser,
        )
        assert rejected.error == "Only the supplied resume path may be uploaded."
    assert dispatched == []

    accepted = await tools.act(
        make_action(tools, "upload_file", {"index": 7, "path": resume}),
        browser,
    )
    assert accepted.extracted_content == "parent dispatched"
    assert dispatched == [
        {
            "action": {
                "upload_file": {
                    "index": 7,
                    "path": resume,
                }
            },
            "available_file_paths": [resume],
        }
    ]


@pytest.mark.asyncio
async def test_unapproved_live_origin_blocks_normal_actions_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gate, _, _ = make_gate()
    tools = create_unfiltered_tools(gate)

    async def unexpected_parent(*args: Any, **kwargs: Any) -> ActionResult:
        raise AssertionError("unapproved action reached Browser Use dispatch")

    monkeypatch.setattr(Tools, "act", unexpected_parent)
    blocked = await tools.act(
        make_action(tools, "evaluate", {"code": "document.title"}),
        FakeBrowserSession(
            "https://jobs.example.evil/apply",
            [f"{JOB_ORIGIN}/"],
        ),
    )
    assert blocked.error == (
        "The current origin requires exact human approval before this action."
    )


@pytest.mark.asyncio
async def test_navigation_continue_publishes_gate_then_resumes() -> None:
    gate, publisher, _ = make_gate()
    browser = FakeBrowserSession()
    pending = asyncio.create_task(
        gate.request_human_navigation("Complete CAPTCHA and return.", browser)
    )

    assert await publisher.next_event() == (
        "awaiting_human_navigation",
        "human_navigation_required",
        {"instruction": "Complete CAPTCHA and return."},
    )
    assert gate.pending_kind == "navigation"
    await gate.continue_navigation()
    result = await pending

    assert result.is_done is False
    assert result.extracted_content == "Human navigation completed."
    assert publisher.events[-1] == ("running", None, {})
    assert gate.pending_kind is None


@pytest.mark.asyncio
async def test_navigation_cancel_and_timeout_return_structured_cancellation() -> None:
    gate, publisher, _ = make_gate()
    browser = FakeBrowserSession("https://jobs.example/apply?secret=value#fragment")
    pending = asyncio.create_task(gate.request_human_navigation("Log in.", browser))
    await publisher.next_event()
    await gate.cancel()
    cancelled = await pending
    payload = ApplicationRunResult.model_validate_json(cancelled.extracted_content)

    assert cancelled.is_done is True
    assert cancelled.success is False
    assert payload.status == "cancelled"
    assert payload.final_url == "https://jobs.example/apply"
    assert payload.submit_attempted is False

    timeout_gate, timeout_publisher, _ = make_gate(action_timeout=0.001)
    timed_out = await timeout_gate.request_human_navigation("Wait for human.", browser)
    timeout_payload = ApplicationRunResult.model_validate_json(timed_out.extracted_content)
    assert timeout_publisher.events[0][0] == "awaiting_human_navigation"
    assert timed_out.is_done is True
    assert timed_out.success is False
    assert timeout_payload.status == "cancelled"
    with pytest.raises(HarnessServiceError) as error:
        await timeout_gate.continue_navigation()
    assert_conflict(error.value)


@pytest.mark.asyncio
async def test_post_navigation_new_current_origin_requires_exact_approval_and_mutates_shared_state() -> None:
    domains = [f"{JOB_ORIGIN}/"]
    browser = FakeBrowserSession("https://ats.example/apply?token=private", domains)
    shared_sensitive = {JOB_ORIGIN: dict(make_candidate().direct_fields)}
    gate, publisher, returned_sensitive = make_gate(sensitive_data=shared_sensitive)
    pending = asyncio.create_task(
        gate.request_human_navigation("Complete the ATS login.", browser)
    )

    await publisher.next_event(0)
    await gate.continue_navigation()
    assert await publisher.next_event(1) == (
        "awaiting_origin_approval",
        "origin_approval_required",
        {"origin": ATS_ORIGIN},
    )
    assert gate.pending_kind == "origin"

    await gate.approve_origin(ATS_ORIGIN)
    result = await pending

    assert result.is_done is False
    assert gate.approved_origins == (JOB_ORIGIN, ATS_ORIGIN)
    assert browser.browser_profile.allowed_domains is domains
    assert domains == [f"{JOB_ORIGIN}/", f"{ATS_ORIGIN}/"]
    assert returned_sensitive is shared_sensitive
    assert gate.sensitive_data is shared_sensitive
    assert shared_sensitive[ATS_ORIGIN] == dict(make_candidate().direct_fields)
    assert ATS_ORIGIN in shared_sensitive
    assert publisher.events[-1] == ("running", None, {})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wrong_origin",
    ["https://other.example", "https://ats.example.evil"],
)
async def test_pre_navigation_target_approval_rejects_mismatch_and_lookalike(
    wrong_origin: str,
) -> None:
    gate, publisher, _ = make_gate()
    browser = FakeBrowserSession()
    pending = asyncio.create_task(gate.request_origin_approval(ATS_ORIGIN, browser))
    assert await publisher.next_event() == (
        "awaiting_origin_approval",
        "origin_approval_required",
        {"origin": ATS_ORIGIN},
    )

    with pytest.raises(HarnessServiceError) as error:
        await gate.approve_origin(wrong_origin)
    assert_conflict(error.value)
    assert gate.pending_kind == "origin"
    assert browser.browser_profile.allowed_domains == [f"{JOB_ORIGIN}/"]

    await gate.approve_origin(ATS_ORIGIN)
    with pytest.raises(HarnessServiceError) as duplicate:
        await gate.approve_origin(ATS_ORIGIN)
    assert_conflict(duplicate.value)
    approved = await pending
    assert approved.extracted_content == "Origin approved."
    assert browser.browser_profile.allowed_domains == [f"{JOB_ORIGIN}/", f"{ATS_ORIGIN}/"]


@pytest.mark.asyncio
async def test_origin_approval_rechecks_live_origin_and_opens_a_second_gate() -> None:
    second_origin = "https://second-ats.example"
    domains = [f"{JOB_ORIGIN}/"]
    browser = FakeBrowserSession(JOB_URL, domains)
    gate, publisher, _ = make_gate()
    pending = asyncio.create_task(gate.request_origin_approval(ATS_ORIGIN, browser))
    assert await publisher.next_event(0) == (
        "awaiting_origin_approval",
        "origin_approval_required",
        {"origin": ATS_ORIGIN},
    )

    await gate.approve_origin(ATS_ORIGIN)
    browser.current_url = f"{second_origin}/apply"
    assert await publisher.next_event(1) == (
        "awaiting_origin_approval",
        "origin_approval_required",
        {"origin": second_origin},
    )
    assert gate.pending_kind == "origin"
    await gate.approve_origin(second_origin)
    result = await pending

    assert result.extracted_content == "Origin approved."
    assert gate.approved_origins == (JOB_ORIGIN, ATS_ORIGIN, second_origin)
    assert domains == [
        f"{JOB_ORIGIN}/",
        f"{ATS_ORIGIN}/",
        f"{second_origin}/",
    ]
    assert publisher.events[-1] == ("running", None, {})


@pytest.mark.asyncio
async def test_origin_cap_existing_origin_and_cancel_are_deterministic() -> None:
    origins = [f"https://approved-{index}.example" for index in range(20)]
    browser = FakeBrowserSession(domains=[f"{origin}/" for origin in origins])
    gate, publisher, _ = make_gate(approved_origins=origins)

    existing = await gate.request_origin_approval(origins[5], browser)
    assert existing.is_done is False
    assert existing.extracted_content == "Origin is already approved."
    capped = await gate.request_origin_approval("https://twenty-first.example", browser)
    payload = ApplicationRunResult.model_validate_json(capped.extracted_content)
    assert capped.is_done is True
    assert capped.success is False
    assert payload.status == "cancelled"
    assert len(gate.approved_origins) == 20
    assert len(browser.browser_profile.allowed_domains) == 20
    assert publisher.events == []


@pytest.mark.asyncio
async def test_duplicate_and_wrong_state_commands_conflict_without_changing_gate() -> None:
    gate, publisher, _ = make_gate()
    browser = FakeBrowserSession()

    for command in (
        gate.continue_navigation,
        lambda: gate.approve_origin(ATS_ORIGIN),
        lambda: gate.revise("correction"),
        gate.ready,
    ):
        with pytest.raises(HarnessServiceError) as error:
            await command()
        assert_conflict(error.value)

    pending = asyncio.create_task(gate.request_human_navigation("Continue.", browser))
    await publisher.next_event()
    await gate.continue_navigation()
    with pytest.raises(HarnessServiceError) as duplicate:
        await gate.continue_navigation()
    assert_conflict(duplicate.value)
    await pending

    await gate.cancel()
    cancelled_after_cancel = await gate.request_human_navigation("Never blocks.", browser)
    assert cancelled_after_cancel.is_done is True
    assert cancelled_after_cancel.success is False


@pytest.mark.asyncio
async def test_revision_trims_context_counts_events_and_resolves_concurrent_race_once() -> None:
    gate, publisher, _ = make_gate()
    browser = FakeBrowserSession()

    first_review = asyncio.create_task(gate.request_human_review(make_result(), browser))
    await publisher.next_event(0)
    await gate.revise("  Correct only the years-of-experience field.  ")
    first = await first_review
    assert first.is_done is False
    assert first.long_term_memory == "Correct only the years-of-experience field."
    assert first.metadata == {"revision_count": 1}
    assert publisher.events[1] == (
        "running",
        "revision_applied",
        {"revision_count": 1},
    )

    second_review = asyncio.create_task(gate.request_human_review(make_result(), browser))
    await publisher.next_event(2)
    outcomes = await asyncio.gather(
        gate.revise("first racing correction"),
        gate.revise("second racing correction"),
        return_exceptions=True,
    )
    successes = [outcome for outcome in outcomes if outcome is None]
    failures = [outcome for outcome in outcomes if isinstance(outcome, BaseException)]
    assert len(successes) == 1
    assert len(failures) == 1
    assert_conflict(failures[0])
    second = await second_review
    assert second.long_term_memory in {
        "first racing correction",
        "second racing correction",
    }
    assert second.metadata == {"revision_count": 2}
    assert gate.revision_count == 2
    assert publisher.events[-1] == (
        "running",
        "revision_applied",
        {"revision_count": 2},
    )

    with pytest.raises(HarnessServiceError) as empty:
        await gate.revise("   ")
    assert empty.value.status_code == 422
    with pytest.raises(HarnessServiceError) as oversized:
        await gate.revise("x" * 20_001)
    assert oversized.value.status_code == 422


@pytest.mark.asyncio
async def test_ready_and_cancellation_return_terminal_validated_json() -> None:
    gate, publisher, _ = make_gate()
    browser = FakeBrowserSession("https://jobs.example/apply?secret=yes")
    review = asyncio.create_task(gate.request_human_review(make_result(), browser))
    await publisher.next_event()
    await gate.ready()
    ready = await review
    ready_payload = ApplicationRunResult.model_validate_json(ready.extracted_content)

    assert ready.is_done is True
    assert ready.success is True
    assert ready_payload.status == "ready_for_human_submit"
    assert ready_payload.submit_attempted is False
    assert ready_payload.revision_count == 0
    assert gate.ready_accepted is True

    cancelled_gate, cancelled_publisher, _ = make_gate()
    cancelled_review = asyncio.create_task(
        cancelled_gate.request_human_review(make_result(), browser)
    )
    await cancelled_publisher.next_event()
    await cancelled_gate.cancel()
    cancelled = await cancelled_review
    cancelled_payload = ApplicationRunResult.model_validate_json(
        cancelled.extracted_content
    )
    assert cancelled.is_done is True
    assert cancelled.success is False
    assert cancelled_payload.status == "cancelled"
    assert cancelled_payload.final_url == "https://jobs.example/apply"
    assert cancelled_payload.submit_attempted is False


@pytest.mark.asyncio
async def test_mismatch_custom_action_returns_exact_agent_sentinel() -> None:
    gate, _, _ = make_gate()
    configured = create_unfiltered_tools(gate)
    registered = configured.registry.registry.actions["report_application_mismatch"]
    result = await registered.function(
        params=registered.param_model(),
        browser_session=FakeBrowserSession(),
    )
    assert result.is_done is True
    assert result.success is False
    assert result.extracted_content == APPLICATION_MISMATCH_RESULT


def test_task_encodes_full_evidence_and_human_submit_policy_without_direct_values(
    tmp_path: Path,
) -> None:
    task = build_application_task(make_request(tmp_path))
    lowered = task.lower()

    assert "active job posting or its application form" in lowered
    assert "materially mismatched" in lowered
    assert "knock-out controls" in lowered
    assert "attributed candidate sources" in lowered
    assert "anecdotes only for relevant professional free-text" in lowered
    assert "never create or transfer metrics" in lowered
    assert "never infer legal, demographic, work authorization" in lowered
    assert "<secret>email</secret>" in task
    assert "<secret>work_authorization</secret>" in task
    assert "Only the supplied resume is uploadable" in task
    assert "Generic clicks" in task
    assert "keyboard input" in task
    assert "send_keys" in task
    assert "JavaScript evaluate" in task
    assert "intermediate controls and custom widgets" in task
    assert "Complete every machine-actionable control" in task
    assert "identifies a control as human-only or manual" in task
    assert "site-provided JavaScript interface" in task
    assert "FINAL SUBMISSION IS HUMAN-ONLY" in task
    assert "Never press Enter when it would submit" in task
    assert "Never invoke a submission API" in task
    assert "Do not use the default done action" in task
    assert "Ready ends the run immediately" in task
    assert "Ada Secret-Value" not in task
    assert "private-person@example.test" not in task
    assert "Explicit authorization fact" not in task
    assert "source=private" in task
    assert "#fragment" not in task


class FakeHistory:
    def __init__(
        self,
        *,
        result: ApplicationRunResult | None,
        done: bool = True,
        final: str | None = None,
        history_length: int = 1,
    ) -> None:
        self.structured_output = result
        self._done = done
        self._final = final
        self.history = [object()] * history_length

    def final_result(self) -> str | None:
        return self._final

    def is_done(self) -> bool:
        return self._done


@pytest.mark.asyncio
async def test_run_application_configures_agent_emits_sanitized_steps_and_secures_runtime_directories(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    request = make_request(tmp_path)
    gate, _, _ = make_gate()
    browser = object()
    llm = object()
    session_directory = request.session.artifacts.session_directory
    ready_result = await accept_ready(gate, FakeBrowserSession())
    captured: dict[str, Any] = {}

    class FakeAgent:
        def __init__(self, **kwargs: Any) -> None:
            captured["kwargs"] = kwargs
            assert kwargs["use_vision"] is False
            actions = kwargs["tools"].registry.registry.actions
            captured["screenshot_action"] = actions.pop("screenshot")
            captured["setup_action_models_calls"] = 0
            runtime_root = Path(tempfile.gettempdir())
            assert runtime_root == session_directory
            runtime = runtime_root / "browser_use_agent_fake"
            runtime.mkdir(mode=0o755)
            screenshots = runtime / "screenshots"
            screenshots.mkdir(mode=0o755)
            self.agent_directory = runtime
            captured["runtime"] = runtime
            captured["screenshots"] = screenshots
            assert self.agent_directory == captured["runtime"]
            self.browser_session = FakeBrowserSession(
                "https://ats.example/application?candidate=secret#private"
            )

        def _setup_action_models(self) -> None:
            captured["setup_action_models_calls"] += 1
            actions = captured["kwargs"]["tools"].registry.registry.actions
            assert actions["screenshot"] is captured["screenshot_action"]

        async def run(self, **kwargs: Any) -> FakeHistory:
            captured["runtime_mode"] = captured["runtime"].stat().st_mode & 0o777
            captured["screenshots_mode"] = (
                captured["screenshots"].stat().st_mode & 0o777
            )
            captured["agent_files_mode"] = (
                Path(captured["kwargs"]["file_system_path"]).stat().st_mode & 0o777
            )
            captured["run_kwargs"] = kwargs
            await kwargs["on_step_start"](self)
            self.browser_session.current_url = "https://ats.example/review?token=secret"
            await kwargs["on_step_start"](self)
            return FakeHistory(result=ready_result)

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)
    steps: list[tuple[int, str]] = []

    async def event_sink(step_number: int, current_url: str) -> None:
        steps.append((step_number, current_url))

    result = await run_application(request, llm, browser, gate, event_sink)
    kwargs = captured["kwargs"]

    assert result == ready_result
    assert kwargs["browser"] is browser
    assert kwargs["llm"] is llm
    assert frozenset(kwargs["tools"].registry.registry.actions) == (
        EXPECTED_DEFAULT_ACTIONS | CUSTOM_ACTIONS
    )
    assert (
        kwargs["tools"].registry.registry.actions["screenshot"]
        is captured["screenshot_action"]
    )
    assert captured["setup_action_models_calls"] == 1
    assert kwargs["sensitive_data"] is gate.sensitive_data
    assert kwargs["step_timeout"] == STEP_TIMEOUT_SECONDS == 3_660
    assert kwargs["step_timeout"] > 3_600
    assert kwargs["llm_timeout"] == LLM_TIMEOUT_SECONDS == 310
    assert kwargs["use_vision"] is False
    assert kwargs["use_judge"] is False
    assert kwargs["generate_gif"] is False
    assert kwargs["save_conversation_path"] is None
    assert kwargs["enable_signal_handler"] is False
    assert kwargs["available_file_paths"] == [str(request.session.artifacts.resume)]
    assert kwargs["file_system_path"] == str(
        request.session.artifacts.session_directory / "agent-files"
    )
    assert kwargs["output_model_schema"] is ApplicationRunResult
    assert "max_actions_per_step" not in kwargs
    assert captured["run_kwargs"]["max_steps"] == request.session.max_steps
    assert steps == [
        (1, "https://ats.example/application"),
        (2, "https://ats.example/review"),
    ]
    assert captured["runtime"].parent == session_directory
    assert captured["runtime_mode"] == 0o700
    assert captured["screenshots_mode"] == 0o700
    assert captured["agent_files_mode"] == 0o700
    assert not captured["runtime"].exists()


@pytest.mark.asyncio
async def test_agent_constructor_failure_removes_private_runtime_and_restores_tempdir(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    request = make_request(tmp_path)
    gate, _, _ = make_gate()
    previous_tempdir = tempfile.tempdir
    created: list[Path] = []

    class FailingAgent:
        def __init__(self, **kwargs: Any) -> None:
            runtime_root = Path(tempfile.gettempdir())
            assert runtime_root == request.session.artifacts.session_directory
            runtime = runtime_root / "browser_use_agent_constructor_failure"
            runtime.mkdir()
            (runtime / "private-state.json").write_text("secret", encoding="utf-8")
            created.append(runtime)
            raise RuntimeError("synthetic constructor failure")

    monkeypatch.setattr(agent_module, "Agent", FailingAgent)

    async def sink(step: int, url: str) -> None:
        raise AssertionError("constructor failure cannot emit a step")

    with pytest.raises(ApplicationAgentFailure) as error:
        await run_application(request, object(), object(), gate, sink)
    assert error.value.code == "browser_failed"
    assert len(created) == 1
    assert created[0].parent == request.session.artifacts.session_directory
    assert not created[0].exists()
    assert tempfile.tempdir == previous_tempdir


@pytest.mark.asyncio
async def test_run_application_accepts_structured_cancel_without_ready_gate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    request = make_request(tmp_path)
    gate, _, _ = make_gate()
    cancelled = make_result(status="cancelled")
    external_directory = tmp_path / "external-cancelled"
    external_directory.mkdir()

    class FakeAgent:
        def __init__(self, **kwargs: Any) -> None:
            self.agent_directory = external_directory
            self.browser_session = FakeBrowserSession()

        async def run(self, **kwargs: Any) -> FakeHistory:
            return FakeHistory(result=cancelled)

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)

    async def sink(step: int, url: str) -> None:
        raise AssertionError("No fake step should be emitted")

    assert await run_application(request, object(), object(), gate, sink) == cancelled
    assert not external_directory.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("history_factory", "expected_code"),
    [
        (
            lambda request: FakeHistory(
                result=None,
                final=APPLICATION_MISMATCH_RESULT,
            ),
            "application_mismatch",
        ),
        (
            lambda request: FakeHistory(
                result=None,
                done=False,
                history_length=request.session.max_steps,
            ),
            "step_limit",
        ),
        (lambda request: FakeHistory(result=None), "invalid_model_output"),
        (
            lambda request: FakeHistory(
                result=make_result(
                    status="ready_for_human_submit",
                    job_url="https://lookalike.example/openings/42",
                )
            ),
            "invalid_model_output",
        ),
    ],
    ids=["mismatch-sentinel", "step-limit", "missing-output", "unaccepted-ready"],
)
async def test_run_application_maps_terminal_history_failures_and_always_cleans(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    history_factory: Any,
    expected_code: str,
) -> None:
    request = make_request(tmp_path)
    gate, _, _ = make_gate()
    external_directory = tmp_path / f"external-{expected_code}"
    external_directory.mkdir()

    class FakeAgent:
        def __init__(self, **kwargs: Any) -> None:
            self.agent_directory = external_directory
            self.browser_session = FakeBrowserSession()

        async def run(self, **kwargs: Any) -> FakeHistory:
            return history_factory(request)

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)

    async def sink(step: int, url: str) -> None:
        return None

    with pytest.raises(ApplicationAgentFailure) as error:
        await run_application(request, object(), object(), gate, sink)
    assert error.value.code == expected_code
    assert not external_directory.exists()


@pytest.mark.asyncio
async def test_run_application_rejects_ready_result_with_mismatched_job_after_gate_acceptance(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    request = make_request(tmp_path)
    gate, _, _ = make_gate()
    await accept_ready(gate, FakeBrowserSession())
    mismatched = make_result(
        status="ready_for_human_submit",
        job_url="https://jobs.example.evil/openings/42",
    )
    external_directory = tmp_path / "external-mismatch"
    external_directory.mkdir()

    class FakeAgent:
        def __init__(self, **kwargs: Any) -> None:
            self.agent_directory = external_directory
            self.browser_session = FakeBrowserSession()

        async def run(self, **kwargs: Any) -> FakeHistory:
            return FakeHistory(result=mismatched)

    monkeypatch.setattr(agent_module, "Agent", FakeAgent)

    async def sink(step: int, url: str) -> None:
        return None

    with pytest.raises(ApplicationAgentFailure) as error:
        await run_application(request, object(), object(), gate, sink)
    assert error.value.code == "application_mismatch"
    assert not external_directory.exists()
