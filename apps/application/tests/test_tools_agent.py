from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from pathlib import Path
from types import MappingProxyType
from typing import Any
from uuid import UUID

import pytest

from jobhunter_browser_harness.agent import (
    ApplicationRunRequest,
    build_application_task,
)
from jobhunter_browser_harness.context import AttributedSource, CandidateContext
from jobhunter_browser_harness.credentials import CredentialStore
from jobhunter_browser_harness.models import (
    AdditionalInfoOption,
    AdditionalInfoSingleSelectCommandAnswer,
    AdditionalInfoSingleSelectQuestion,
    AdditionalInfoTextCommandAnswer,
    AdditionalInfoTextQuestion,
    CancelledApplicationResult,
    ReviewApplicationResult,
    HarnessServiceError,
    OpportunityKind,
    SessionCreateRequest,
    UploadedArtifacts,
)
from jobhunter_browser_harness.user_info import UserInfoStore
from jobhunter_browser_harness.tools import (
    HumanGate,
    redact_public_text,
    sanitize_application_result,
)


SESSION_ID = UUID("39bb70b2-5ea4-4937-8090-32d7404ad597")
JOB_URL = "https://jobs.example/openings/42?source=private"
JOB_ORIGIN = "https://jobs.example"
ATS_ORIGIN = "https://ats.example"


class FakeRuntime:
    def __init__(self, url: str = JOB_URL) -> None:
        self.current_url = url
        self.calls: list[tuple[str, tuple[str, ...] | None]] = []
        self.approved_origin_sets: list[tuple[str, ...]] = []

    async def get_current_page_url(self) -> str:
        self.calls.append(("get_current_page_url", None))
        return self.current_url

    async def set_approved_origins(self, origins: Sequence[str]) -> None:
        approved = tuple(origins)
        self.calls.append(("set_approved_origins", approved))
        self.approved_origin_sets.append(approved)

    async def suspend_navigation_guard(self) -> None:
        self.calls.append(("suspend_navigation_guard", None))


class CredentialRuntime(FakeRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.mutation_started = asyncio.Event()
        self.mutation_release = asyncio.Event()
        self.mutation_finished = asyncio.Event()
        self.sign_in_calls: list[dict[str, str]] = []
        self.activated_private_values: list[tuple[str, ...]] = []

    async def suppress_private_capture(self) -> None:
        self.calls.append(("suppress_private_capture", None))

    async def sign_in(
        self,
        *,
        expected_origin: str,
        username_ref: str,
        password_ref: str,
        submit_ref: str,
        username: str,
        password: str,
    ) -> None:
        self.mutation_started.set()
        await self.mutation_release.wait()
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
        self.mutation_finished.set()

    async def verify_origin_and_activate_private_values(
        self,
        expected_origin: str,
        values: Sequence[str],
    ) -> str | None:
        self.mutation_started.set()
        await self.mutation_release.wait()
        activated = tuple(values)
        self.activated_private_values.append(activated)
        self.mutation_finished.set()
        return expected_origin


class PublicationBlockingCredentialStore(CredentialStore):
    def __init__(self, path: Path) -> None:
        super().__init__(path)
        self.upsert_finished = asyncio.Event()
        self.return_release = asyncio.Event()

    async def upsert(self, origin: str, username: str, password: str) -> None:
        await super().upsert(origin, username, password)
        self.upsert_finished.set()
        await self.return_release.wait()


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


class FakeUserInfoStore:
    async def merge(
        self,
        job_url: str,
        questions: Any,
        answers: Any,
    ) -> tuple[Any, ...]:
        raise AssertionError("unexpected additional information merge")


def make_gate(
    *,
    publisher: EventPublisher | None = None,
    approved_origins: list[str] | None = None,
    review_snapshot: Any = None,
    user_info_store: Any = None,
    auto_submit: bool = False,
) -> tuple[HumanGate, EventPublisher]:
    publisher = publisher or EventPublisher()
    origins = approved_origins or [JOB_ORIGIN]
    gate = HumanGate(
        job_url=JOB_URL,
        private_values=make_candidate().direct_fields.values(),
        user_info_store=user_info_store or FakeUserInfoStore(),
        approved_origins=origins,
        publish=publisher,
        review_snapshot=review_snapshot,
        auto_submit=auto_submit,
    )
    return gate, publisher


@pytest.mark.asyncio
async def test_sign_in_requester_cancellation_after_browser_mutation_resolves_gate(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    gate, publisher = make_gate()
    runtime = CredentialRuntime()
    credential_store = CredentialStore(tmp_path / "credentials.json")
    username = "person@example.test"
    password = "corrected-private-password$$"
    gated = asyncio.create_task(
        gate.request_sign_in(
            username_ref="e1",
            password_ref="e2",
            submit_ref="e3",
            runtime=runtime,
            credential_store=credential_store,
        )
    )
    assert await publisher.next_event() == (
        "awaiting_human_navigation",
        "credentials_required",
        {},
    )
    await credential_store.upsert(JOB_ORIGIN, username, "stale-private-password")

    command = asyncio.create_task(gate.sign_in(username, password))
    await asyncio.wait_for(runtime.mutation_started.wait(), timeout=1)
    await gate._lock.acquire()
    try:
        runtime.mutation_release.set()
        await asyncio.wait_for(runtime.mutation_finished.wait(), timeout=1)
        command.cancel()
        await asyncio.sleep(0)
    finally:
        gate._lock.release()
    with pytest.raises(asyncio.CancelledError):
        await command

    try:
        result = await asyncio.wait_for(asyncio.shield(gated), timeout=1)
    except TimeoutError:
        await gate.cancel()
        await asyncio.gather(gated, return_exceptions=True)
        raise
    assert result.metadata == {"sign_in_status": "attempted"}
    assert await publisher.next_event(after=1) == ("running", None, {})
    assert len(runtime.sign_in_calls) == 1
    saved = credential_store.credentials_for_origin(JOB_ORIGIN)
    assert [(item.username, item.password) for item in saved] == [
        (username, password)
    ]
    assert gate._credential_command_task is None


@pytest.mark.asyncio
async def test_interrupt_does_not_release_running_sign_in_mutation(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    gate, publisher = make_gate()
    runtime = CredentialRuntime()
    credential_store = CredentialStore(tmp_path / "credentials.json")
    username = "person@example.test"
    password = "corrected-private-password$$"
    gated = asyncio.create_task(
        gate.request_sign_in(
            username_ref="e1",
            password_ref="e2",
            submit_ref="e3",
            runtime=runtime,
            credential_store=credential_store,
        )
    )
    assert await publisher.next_event() == (
        "awaiting_human_navigation",
        "credentials_required",
        {},
    )

    command = asyncio.create_task(gate.sign_in(username, password))
    await asyncio.wait_for(runtime.mutation_started.wait(), timeout=1)
    assert await gate.interrupt() is False
    assert gate.pending_kind == "credentials"

    runtime.mutation_release.set()
    await command
    result = await asyncio.wait_for(gated, timeout=1)
    assert result.metadata == {"sign_in_status": "attempted"}
    saved = credential_store.credentials_for_origin(JOB_ORIGIN)
    assert [(item.username, item.password) for item in saved] == [
        (username, password)
    ]


@pytest.mark.asyncio
async def test_failed_sign_in_does_not_replace_saved_credentials(
    tmp_path: Path,
) -> None:
    class FailingCredentialRuntime(CredentialRuntime):
        async def sign_in(self, **_kwargs: str) -> None:
            self.mutation_started.set()
            await self.mutation_release.wait()
            raise RuntimeError("private browser failure")

    tmp_path.chmod(0o700)
    gate, _publisher = make_gate()
    runtime = FailingCredentialRuntime()
    runtime.mutation_release.set()
    credential_store = CredentialStore(tmp_path / "credentials.json")
    username = "person@example.test"
    await credential_store.upsert(JOB_ORIGIN, username, "known-good-password")

    with pytest.raises(HarnessServiceError):
        await gate.request_sign_in(
            username_ref="e1",
            password_ref="e2",
            submit_ref="e3",
            runtime=runtime,
            credential_store=credential_store,
        )

    saved = credential_store.credentials_for_origin(JOB_ORIGIN)
    assert [(item.username, item.password) for item in saved] == [
        (username, "known-good-password")
    ]


@pytest.mark.asyncio
async def test_save_credentials_requester_cancellation_after_upsert_resolves_gate(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    gate, publisher = make_gate()
    runtime = CredentialRuntime()
    runtime.mutation_release.set()
    credential_store = PublicationBlockingCredentialStore(
        tmp_path / "credentials.json"
    )
    gated = asyncio.create_task(
        gate.request_sign_in(
            username_ref="e1",
            password_ref="e2",
            submit_ref="e3",
            runtime=runtime,
            credential_store=credential_store,
        )
    )
    assert await publisher.next_event() == (
        "awaiting_human_navigation",
        "credentials_required",
        {},
    )

    username = "created@example.test"
    password = "created-password"
    command = asyncio.create_task(gate.save_credentials(username, password))
    await asyncio.wait_for(credential_store.upsert_finished.wait(), timeout=1)
    await gate._lock.acquire()
    try:
        credential_store.return_release.set()
        await asyncio.sleep(0)
        command.cancel()
        await asyncio.sleep(0)
    finally:
        gate._lock.release()
    with pytest.raises(asyncio.CancelledError):
        await command

    try:
        result = await asyncio.wait_for(asyncio.shield(gated), timeout=1)
    except TimeoutError:
        await gate.cancel()
        await asyncio.gather(gated, return_exceptions=True)
        raise
    assert result.metadata == {"sign_in_status": "saved"}
    assert await publisher.next_event(after=1) == ("running", None, {})
    saved = credential_store.credentials_for_origin(JOB_ORIGIN)
    assert [(item.username, item.password) for item in saved] == [
        (username, password)
    ]
    assert gate._credential_command_task is None


def test_human_gate_does_not_retain_domain_scoped_sensitive_data() -> None:
    gate = HumanGate(
        job_url=JOB_URL,
        private_values=make_candidate().direct_fields.values(),
        user_info_store=FakeUserInfoStore(),
        approved_origins=[JOB_ORIGIN],
        publish=EventPublisher(),
    )

    assert not hasattr(gate, "sensitive_data")
    assert not hasattr(gate, "placeholder_values")


def test_public_redaction_and_result_sanitization_remove_direct_values() -> None:
    direct_values = dict(make_candidate().direct_fields)
    assert (
        redact_public_text(
            "Candidate Ada%20Secret-Value uses private-person@example.test",
            direct_values.values(),
        )
        == "Candidate [redacted] uses [redacted]"
    )



    result = ReviewApplicationResult.model_validate(
        {
            **make_result().model_dump(),
            "company": "Ada Secret-Value",
            "role": "private-person@example.test",
            "job_url": (
                "https://jobs.example/Ada%20Secret-Value/42"
                "?tracking=private-person@example.test"
            ),
            "final_url": (
                "https://ats.example/apply/private-person@example.test"
                "#Ada%20Secret-Value"
            ),
            "fields_filled": [
                {
                    "label": "Email private-person@example.test",
                    "field_type": "text",
                    "value_present": True,
                    "note": "private-person@example.test",
                }
            ],
            "files_attached": ["candidate-resume.pdf"],
            "warnings": [
                "Confirm the work authorization answer before submitting.",
                "Ada%20Secret-Value needs review",
            ],
        }
    )

    sanitized = sanitize_application_result(
        result,
        direct_values.values(),
        revision_count=4,
    )

    assert sanitized.status == "ready_for_submission"
    assert sanitized.company == "[redacted]"
    assert sanitized.role == "[redacted]"
    assert sanitized.job_url == "https://jobs.example/[redacted]/42"
    assert sanitized.final_url == "https://ats.example/apply/[redacted]"
    assert sanitized.fields_filled[0].label == "Email [redacted]"
    assert sanitized.fields_filled[0].note == "Filled"
    assert sanitized.files_attached == ["resume.pdf"]
    assert sanitized.warnings == [
        "Confirm the work authorization answer before submitting.",
        "[redacted] needs review",
    ]
    serialized = sanitized.model_dump_json()
    assert all(value not in serialized for value in direct_values.values())
    assert "Ada%20Secret-Value" not in serialized
    assert sanitized.revision_count == 4
    assert sanitized.submit_attempted is False


def test_public_redaction_respects_maximum_after_expansion() -> None:
    private_value = "x"
    source = private_value * 100

    redacted = redact_public_text(
        source,
        [private_value],
        max_length=len(source),
    )

    assert redacted is not None
    assert len(redacted) == len(source)
    assert private_value not in redacted
    assert redacted.endswith("…")


def make_result(
    *,
    status: str = "ready_for_submission",
    job_url: str = JOB_URL,
    final_url: str = JOB_URL,
) -> ReviewApplicationResult:
    return ReviewApplicationResult.model_validate(
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

@pytest.mark.asyncio
async def test_interrupt_releases_every_pending_human_tool_gate(
    tmp_path: Path,
) -> None:
    async def assert_interrupted(
        gate: HumanGate,
        publisher: EventPublisher,
        task: asyncio.Task[Any],
        kind: str,
    ) -> None:
        await publisher.next_event()
        assert gate.pending_kind == kind
        assert await gate.interrupt() is True
        result = await asyncio.wait_for(task, timeout=1)
        assert result.interrupted is True
        assert result.extracted_content == '{"type":"interrupted"}'
        assert publisher.events[-1] == ("running", None, {})
        assert await gate.interrupt() is False

    navigation_gate, navigation_publisher = make_gate()
    navigation_task = asyncio.create_task(
        navigation_gate.request_human_navigation(
            "Complete the public checkpoint.",
            FakeRuntime(),
        )
    )
    await assert_interrupted(
        navigation_gate,
        navigation_publisher,
        navigation_task,
        "navigation",
    )

    credentials_gate, credentials_publisher = make_gate()
    credentials_task = asyncio.create_task(
        credentials_gate.request_sign_in(
            username_ref="e1",
            password_ref="e2",
            submit_ref="e3",
            runtime=CredentialRuntime(),
            credential_store=CredentialStore(tmp_path / "credentials.json"),
        )
    )
    await assert_interrupted(
        credentials_gate,
        credentials_publisher,
        credentials_task,
        "credentials",
    )

    question = AdditionalInfoTextQuestion.model_validate(
        {
            "id": "availability",
            "key": "availability.start_date",
            "scope": "global",
            "question": "When can you start?",
            "answer_type": "text",
        }
    )
    additional_gate, additional_publisher = make_gate()
    additional_task = asyncio.create_task(
        additional_gate.request_additional_info([question], FakeRuntime())
    )
    await assert_interrupted(
        additional_gate,
        additional_publisher,
        additional_task,
        "additional_info",
    )

    review_gate, review_publisher = make_gate()
    review_task = asyncio.create_task(
        review_gate.request_human_review(make_result(), FakeRuntime())
    )
    await assert_interrupted(
        review_gate,
        review_publisher,
        review_task,
        "review",
    )


def make_request(
    tmp_path: Path,
    *,
    opportunity_kind: OpportunityKind = "job",
) -> ApplicationRunRequest:
    session_directory = tmp_path / "session"
    session_directory.mkdir()
    resume = session_directory / "resume.pdf"
    resume.write_bytes(b"%PDF-test")
    resume_source = session_directory / "resume.tex"
    resume_source.write_text("Built a deterministic data service.", encoding="utf-8")
    artifacts = UploadedArtifacts(
        session_directory=session_directory,
        personal_information=session_directory / "profile.md",
        resume=resume,
        resume_source=resume_source,
    )
    session = SessionCreateRequest(
        session_id=SESSION_ID,
        job_url=JOB_URL,
        opportunity_kind=opportunity_kind,
        approved_origins=(JOB_ORIGIN,),
        auto_submit=False,
        artifacts=artifacts,
    )
    return ApplicationRunRequest(
        session=session,
        candidate=make_candidate(),
        resume_display_name="resume.pdf",
        resume_source_display_name="resume.tex",
        user_info=UserInfoStore(tmp_path / "empty-user-info.json").snapshot(JOB_URL),
    )


def assert_conflict(error: BaseException) -> None:
    assert isinstance(error, HarnessServiceError)
    assert error.status_code == 409
    assert error.code == "command_conflict"


@pytest.mark.asyncio
async def test_navigation_suspends_guard_before_gate_and_reinstalls_it_afterward() -> None:
    gate, publisher = make_gate()
    runtime = FakeRuntime()
    pending = asyncio.create_task(
        gate.request_human_navigation("Complete CAPTCHA and return.", runtime)
    )

    assert await publisher.next_event() == (
        "awaiting_human_navigation",
        "human_navigation_required",
        {"instruction": "Complete CAPTCHA and return."},
    )
    assert runtime.calls == [("suspend_navigation_guard", None)]
    assert gate.pending_kind == "navigation"
    await gate.continue_navigation()
    result = await pending

    assert result.is_done is False
    assert result.extracted_content == "Human navigation completed."
    assert publisher.events[-1] == ("running", None, {})
    assert runtime.calls == [
        ("suspend_navigation_guard", None),
        ("get_current_page_url", None),
        ("set_approved_origins", (JOB_ORIGIN,)),
    ]
    assert runtime.approved_origin_sets == [(JOB_ORIGIN,)]
    assert gate.pending_kind is None


@pytest.mark.asyncio
async def test_navigation_waits_until_explicit_cancellation() -> None:
    private_values = tuple(make_candidate().direct_fields.values())
    publisher = EventPublisher()
    gate = HumanGate(
        job_url=(
            "https://jobs.example/Ada%20Secret-Value/42"
            "?source=private-person@example.test"
        ),
        private_values=private_values,
        user_info_store=FakeUserInfoStore(),
        approved_origins=[JOB_ORIGIN],
        publish=publisher,
    )
    runtime = FakeRuntime(
        "https://jobs.example/apply/private-person@example.test"
        "?secret=Ada%20Secret-Value#fragment"
    )
    pending = asyncio.create_task(gate.request_human_navigation("Log in.", runtime))
    await publisher.next_event()
    await asyncio.sleep(0.01)
    assert pending.done() is False

    await gate.cancel()
    cancelled = await pending
    payload = CancelledApplicationResult.model_validate_json(cancelled.extracted_content)

    assert cancelled.is_done is True
    assert cancelled.success is False
    assert payload.status == "cancelled"
    assert payload.job_url == "https://jobs.example/[redacted]/42"
    assert payload.final_url == "https://jobs.example/apply/[redacted]"
    assert all(value not in cancelled.extracted_content for value in private_values)
    assert payload.submit_attempted is False
    with pytest.raises(HarnessServiceError) as error:
        await gate.continue_navigation()
    assert_conflict(error.value)


@pytest.mark.asyncio
async def test_post_navigation_origin_is_registered_without_manual_approval() -> None:
    runtime = FakeRuntime("https://ats.example/apply?token=private")
    gate, publisher = make_gate()
    pending = asyncio.create_task(
        gate.request_human_navigation("Complete the ATS login.", runtime)
    )

    assert await publisher.next_event(0) == (
        "awaiting_human_navigation",
        "human_navigation_required",
        {"instruction": "Complete the ATS login."},
    )
    assert runtime.calls == [("suspend_navigation_guard", None)]
    await gate.continue_navigation()
    result = await pending

    assert result.is_done is False
    assert gate.pending_kind is None
    assert gate.approved_origins == (JOB_ORIGIN, ATS_ORIGIN)
    assert runtime.calls == [
        ("suspend_navigation_guard", None),
        ("get_current_page_url", None),
        ("set_approved_origins", (JOB_ORIGIN, ATS_ORIGIN)),
        ("get_current_page_url", None),
        ("set_approved_origins", (JOB_ORIGIN, ATS_ORIGIN)),
    ]
    assert runtime.approved_origin_sets == [
        (JOB_ORIGIN, ATS_ORIGIN),
        (JOB_ORIGIN, ATS_ORIGIN),
    ]
    assert publisher.events == [
        (
            "awaiting_human_navigation",
            "human_navigation_required",
            {"instruction": "Complete the ATS login."},
        ),
        ("running", None, {}),
    ]




@pytest.mark.asyncio
async def test_origin_registration_installs_the_exact_expanded_origin_set() -> None:
    gate, publisher = make_gate()
    runtime = FakeRuntime()

    approved = await gate.register_origin(ATS_ORIGIN, runtime)

    assert approved.extracted_content == "Origin approved."
    assert gate.pending_kind is None
    assert gate.approved_origins == (JOB_ORIGIN, ATS_ORIGIN)
    assert runtime.calls == [
        ("set_approved_origins", (JOB_ORIGIN, ATS_ORIGIN)),
        ("get_current_page_url", None),
    ]
    assert runtime.approved_origin_sets == [(JOB_ORIGIN, ATS_ORIGIN)]
    assert publisher.events == [("running", None, {})]
    with pytest.raises(HarnessServiceError) as disabled:
        await gate.approve_origin(ATS_ORIGIN)
    assert_conflict(disabled.value)



@pytest.mark.asyncio
async def test_origin_registration_does_not_commit_a_failed_guard_update() -> None:
    class FailingRuntime(FakeRuntime):
        async def set_approved_origins(self, origins: Sequence[str]) -> None:
            await super().set_approved_origins(origins)
            raise RuntimeError("guard update failed")

    gate, publisher = make_gate()
    runtime = FailingRuntime()

    with pytest.raises(RuntimeError, match="guard update failed"):
        await gate.register_origin(ATS_ORIGIN, runtime)

    assert gate.approved_origins == (JOB_ORIGIN,)
    assert runtime.approved_origin_sets == [(JOB_ORIGIN, ATS_ORIGIN)]
    assert publisher.events == []

@pytest.mark.asyncio
async def test_origin_registration_rechecks_and_registers_the_live_origin() -> None:
    second_origin = "https://second-ats.example"
    runtime = FakeRuntime(f"{second_origin}/apply")
    gate, publisher = make_gate()

    result = await gate.register_origin(ATS_ORIGIN, runtime)

    assert result.extracted_content == "Origin approved."
    assert gate.pending_kind is None
    assert gate.approved_origins == (JOB_ORIGIN, ATS_ORIGIN, second_origin)
    assert runtime.calls == [
        ("set_approved_origins", (JOB_ORIGIN, ATS_ORIGIN)),
        ("get_current_page_url", None),
        (
            "set_approved_origins",
            (JOB_ORIGIN, ATS_ORIGIN, second_origin),
        ),
        ("get_current_page_url", None),
    ]
    assert runtime.approved_origin_sets == [
        (JOB_ORIGIN, ATS_ORIGIN),
        (JOB_ORIGIN, ATS_ORIGIN, second_origin),
    ]
    assert publisher.events == [("running", None, {})]


@pytest.mark.asyncio
async def test_origin_cap_existing_origin_and_cancel_are_deterministic() -> None:
    origins = [f"https://approved-{index}.example" for index in range(20)]
    runtime = FakeRuntime()
    gate, publisher = make_gate(approved_origins=origins)

    existing = await gate.register_origin(origins[5], runtime)
    assert existing.is_done is False
    assert existing.extracted_content == "Origin is already approved."
    capped = await gate.register_origin("https://twenty-first.example", runtime)
    payload = CancelledApplicationResult.model_validate_json(capped.extracted_content)
    assert capped.is_done is True
    assert capped.success is False
    assert payload.status == "cancelled"
    assert len(gate.approved_origins) == 20
    assert runtime.approved_origin_sets == []
    assert publisher.events == []


@pytest.mark.asyncio
async def test_duplicate_and_wrong_state_commands_conflict_without_changing_gate() -> None:
    gate, publisher = make_gate()
    runtime = FakeRuntime()

    for command in (
        gate.continue_navigation,
        lambda: gate.approve_origin(ATS_ORIGIN),
        lambda: gate.revise("correction"),
        gate.submit,
    ):
        with pytest.raises(HarnessServiceError) as error:
            await command()
        assert_conflict(error.value)

    pending = asyncio.create_task(gate.request_human_navigation("Continue.", runtime))
    await publisher.next_event()
    await gate.continue_navigation()
    with pytest.raises(HarnessServiceError) as duplicate:
        await gate.continue_navigation()
    assert_conflict(duplicate.value)
    await pending

    await gate.cancel()
    cancelled_after_cancel = await gate.request_human_navigation("Never blocks.", runtime)
    assert cancelled_after_cancel.is_done is True
    assert cancelled_after_cancel.success is False


@pytest.mark.asyncio
async def test_manual_review_waits_and_supports_revise_then_submit() -> None:
    gate, publisher = make_gate()
    runtime = FakeRuntime()

    first_review = asyncio.create_task(gate.request_human_review(make_result(), runtime))
    await publisher.next_event()
    assert not first_review.done()
    assert gate.pending_kind == "review"
    await gate.revise("  Correct only the years-of-experience field.  ")
    first = await first_review

    assert first.is_done is False
    assert first.long_term_memory == "Correct only the years-of-experience field."
    assert first.metadata == {"revision_count": 1}
    assert gate.submission_approved is False

    second_review = asyncio.create_task(gate.request_human_review(make_result(), runtime))
    await publisher.next_event(2)
    assert not second_review.done()
    await gate.submit()
    approved = await second_review
    approved_payload = ReviewApplicationResult.model_validate_json(
        approved.extracted_content
    )

    assert approved.is_done is False
    assert approved_payload.status == "ready_for_submission"
    assert approved_payload.submit_attempted is False
    assert approved_payload.revision_count == 1
    assert gate.submission_approved is True
    assert gate.pending_kind is None


@pytest.mark.asyncio
async def test_auto_review_immediately_authorizes_only_fully_resolved_applications() -> None:
    snapshots: list[ReviewApplicationResult] = []

    async def capture_snapshot(result: ReviewApplicationResult) -> None:
        snapshots.append(result)

    gate, publisher = make_gate(
        auto_submit=True,
        review_snapshot=capture_snapshot,
    )
    runtime = FakeRuntime("https://jobs.example/apply?secret=yes")

    approved = await asyncio.wait_for(
        gate.request_human_review(make_result(), runtime),
        timeout=0.1,
    )
    approved_payload = ReviewApplicationResult.model_validate_json(
        approved.extracted_content
    )

    assert approved.is_done is False
    assert approved_payload.status == "ready_for_submission"
    assert approved_payload.submit_attempted is False
    assert approved_payload.revision_count == 0
    assert snapshots == [approved_payload]
    assert gate.submission_approved is True
    assert gate.pending_kind is None
    assert publisher.events == []

    with pytest.raises(HarnessServiceError) as replay:
        await gate.submit()
    assert_conflict(replay.value)

    unresolved_snapshots: list[ReviewApplicationResult] = []

    async def capture_unresolved_snapshot(result: ReviewApplicationResult) -> None:
        unresolved_snapshots.append(result)

    unresolved_gate, unresolved_publisher = make_gate(
        auto_submit=True,
        review_snapshot=capture_unresolved_snapshot,
    )
    unresolved = ReviewApplicationResult.model_validate(
        {
            **make_result().model_dump(),
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
        await unresolved_gate.request_human_review(unresolved, runtime)

    assert rejected.value.status_code == 422
    assert rejected.value.code == "invalid_request"
    assert unresolved_gate.submission_approved is False
    assert unresolved_gate.pending_kind is None
    assert unresolved_publisher.events == []
    assert len(unresolved_snapshots) == 1
    assert unresolved_snapshots[0].fields_needing_human[0].note == "Needs human review"

@pytest.mark.asyncio
async def test_manual_review_after_cancellation_returns_terminal_json() -> None:
    gate, publisher = make_gate()
    runtime = FakeRuntime("https://jobs.example/apply?secret=yes")
    await gate.cancel()

    cancelled = await gate.request_human_review(make_result(), runtime)
    cancelled_payload = CancelledApplicationResult.model_validate_json(
        cancelled.extracted_content
    )

    assert cancelled.is_done is True
    assert cancelled.success is False
    assert cancelled_payload.status == "cancelled"
    assert cancelled_payload.final_url == "https://jobs.example/apply"
    assert cancelled_payload.submit_attempted is False
    assert cancelled_payload.submission_confirmation is None
    assert gate.submission_approved is False
    assert gate.pending_kind is None
    assert publisher.events == []




@pytest.mark.asyncio
async def test_additional_info_gate_publishes_complete_questions_and_persists_redacted_source(
    tmp_path: Path,
) -> None:
    store = UserInfoStore(tmp_path / "user-info.json")
    gate, publisher = make_gate(user_info_store=store)
    runtime = FakeRuntime()
    questions = (
        AdditionalInfoTextQuestion(
            id="availability",
            key="availability.summer_2027",
            scope="global",
            question="When is Ada Secret-Value available?",
            answer_type="text",
        ),
        AdditionalInfoSingleSelectQuestion(
            id="referral",
            key="referral.source",
            scope="application",
            question="Who referred private-person@example.test?",
            answer_type="single_select",
            options=[
                AdditionalInfoOption(
                    id="name",
                    label="Ada Secret-Value choice",
                ),
                AdditionalInfoOption(
                    id="email",
                    label="private-person@example.test choice",
                ),
            ],
        ),
    )
    pending = asyncio.create_task(gate.request_additional_info(questions, runtime))

    state, event, detail = await publisher.next_event()
    assert (state, event) == (
        "awaiting_additional_info",
        "additional_info_required",
    )
    public_questions = detail["questions"]
    assert isinstance(public_questions, list)
    assert public_questions[0].question == "When is Ada Secret-Value available?"
    assert public_questions[1].question == "Who referred private-person@example.test?"
    assert public_questions[1].options[0].label == "Ada Secret-Value choice"
    assert (
        public_questions[1].options[1].label
        == "private-person@example.test choice"
    )
    assert [option.id for option in public_questions[1].options] == [
        "name",
        "email",
    ]
    assert gate.pending_kind == "additional_info"

    await gate.provide_additional_info(
        (
            AdditionalInfoTextCommandAnswer(
                id="availability",
                status="answered",
                raw_value="free june through august",
                value="June through August 2027",
            ),
            AdditionalInfoSingleSelectCommandAnswer(
                id="referral",
                status="answered",
                option_id="email",
            ),
        )
    )
    result = await pending

    assert json.loads(result.extracted_content) == {
        "type": "additional_info",
        "answers": [
            {
                "id": "availability",
                "key": "availability.summer_2027",
                "scope": "global",
                "answer_type": "text",
                "status": "answered",
                "value": "June through August 2027",
            },
            {
                "id": "referral",
                "key": "referral.source",
                "scope": "application",
                "answer_type": "single_select",
                "status": "answered",
                "value": "private-person@example.test choice",
            },
        ],
    }
    assert publisher.events[-1] == (
        "running",
        "additional_info_saved",
        {"count": 2},
    )
    assert "free june through august" in gate.redaction_values
    assert "June through August 2027" in gate.redaction_values
    assert "private-person@example.test choice" in gate.redaction_values
    disk = json.loads((tmp_path / "user-info.json").read_text(encoding="utf-8"))
    assert (
        disk["applications"][JOB_URL]["referral.source"]["value"]
        == "private-person@example.test choice"
    )
    assert disk["global"]["availability.summer_2027"]["raw_value"] == (
        "free june through august"
    )
    assert disk["global"]["availability.summer_2027"]["sanitized_value"] == (
        "June through August 2027"
    )
    assert "free june through august" not in result.extracted_content
    assert (
        disk["applications"][JOB_URL]["referral.source"]["question"]
        == "Who referred [redacted]?"
    )


@pytest.mark.asyncio
async def test_additional_info_continue_resumes_without_persisting_answers(
    tmp_path: Path,
) -> None:
    class TrackingUserInfoStore(UserInfoStore):
        def __init__(self, path: Path) -> None:
            super().__init__(path)
            self.merge_calls = 0

        async def merge(self, *args: Any, **kwargs: Any) -> tuple[Any, ...]:
            self.merge_calls += 1
            return await super().merge(*args, **kwargs)

    store_path = tmp_path / "user-info.json"
    store = TrackingUserInfoStore(store_path)
    before_store = store_path.read_bytes()
    before_facts = store.snapshot(JOB_URL).as_task_payload()
    gate, publisher = make_gate(user_info_store=store)
    runtime = FakeRuntime()
    questions = (
        AdditionalInfoTextQuestion(
            id="availability",
            key="availability.summer_2027",
            scope="global",
            question="What dates are you available?",
            answer_type="text",
        ),
        AdditionalInfoSingleSelectQuestion(
            id="referral",
            key="referral.source",
            scope="application",
            question="How did you hear about this position?",
            answer_type="single_select",
            options=[
                AdditionalInfoOption(id="friend", label="A friend"),
                AdditionalInfoOption(id="board", label="Job board"),
            ],
        ),
    )
    pending = asyncio.create_task(gate.request_additional_info(questions, runtime))

    assert (await publisher.next_event())[:2] == (
        "awaiting_additional_info",
        "additional_info_required",
    )
    await gate.continue_without_additional_info()
    with pytest.raises(HarnessServiceError) as repeated:
        await gate.continue_without_additional_info()
    result = await pending

    assert_conflict(repeated.value)
    assert json.loads(result.extracted_content) == {
        "type": "continue_without_additional_info"
    }
    assert result.is_done is False
    assert result.success is True
    assert gate.pending_kind is None
    assert publisher.events[-1] == ("running", None, {})
    assert all(event != "additional_info_saved" for _state, event, _detail in publisher.events)
    assert store.merge_calls == 0
    assert store_path.read_bytes() == before_store
    assert store.snapshot(JOB_URL).as_task_payload() == before_facts


@pytest.mark.asyncio
async def test_additional_info_continue_conflicts_in_wrong_pending_state() -> None:
    gate, publisher = make_gate()
    runtime = FakeRuntime()

    with pytest.raises(HarnessServiceError) as without_gate:
        await gate.continue_without_additional_info()
    assert_conflict(without_gate.value)

    navigation = asyncio.create_task(
        gate.request_human_navigation("Complete navigation.", runtime)
    )
    await publisher.next_event()
    with pytest.raises(HarnessServiceError) as wrong_gate:
        await gate.continue_without_additional_info()

    assert_conflict(wrong_gate.value)
    assert gate.pending_kind == "navigation"
    assert publisher.events == [
        (
            "awaiting_human_navigation",
            "human_navigation_required",
            {"instruction": "Complete navigation."},
        )
    ]
    await gate.continue_navigation()
    await navigation


@pytest.mark.asyncio
async def test_additional_info_invalid_and_failed_commands_leave_gate_pending(
    tmp_path: Path,
) -> None:
    class FailingStore:
        async def merge(
            self,
            job_url: str,
            questions: Any,
            answers: Any,
        ) -> tuple[Any, ...]:
            raise HarnessServiceError(500, "internal_error", "Request failed")

    gate, publisher = make_gate(user_info_store=FailingStore())
    runtime = FakeRuntime()
    questions = (
        AdditionalInfoTextQuestion(
            id="first",
            key="first.answer",
            scope="global",
            question="First answer?",
            answer_type="text",
        ),
        AdditionalInfoTextQuestion(
            id="second",
            key="second.answer",
            scope="application",
            question="Second answer?",
            answer_type="text",
        ),
    )
    pending = asyncio.create_task(gate.request_additional_info(questions, runtime))
    await publisher.next_event()

    with pytest.raises(HarnessServiceError) as partial:
        await gate.provide_additional_info(
            (
                AdditionalInfoTextCommandAnswer(
                    id="first",
                    status="answered",
                    raw_value="first raw private value",
                    value="first private value",
                ),
            )
        )
    assert_conflict(partial.value)
    assert gate.pending_kind == "additional_info"
    assert {
        "first raw private value",
        "first private value",
    } <= gate.redaction_values

    answers = (
        AdditionalInfoTextCommandAnswer(
            id="first",
            status="answered",
            raw_value="first raw private value",
            value="first private value",
        ),
        AdditionalInfoTextCommandAnswer(
            id="second",
            status="answered",
            raw_value="second raw private value",
            value="second private value",
        ),
    )
    with pytest.raises(HarnessServiceError) as failed:
        await gate.provide_additional_info(answers)
    assert failed.value.code == "internal_error"
    assert gate.pending_kind == "additional_info"
    assert {
        "first raw private value",
        "first private value",
        "second raw private value",
        "second private value",
    } <= gate.redaction_values

    await gate.cancel()
    cancelled = await pending
    assert cancelled.is_done is True


@pytest.mark.asyncio
async def test_additional_info_complete_public_wire_limits_and_bounded_persisted_redaction(
    tmp_path: Path,
) -> None:
    store = UserInfoStore(tmp_path / "user-info.json")
    publisher = EventPublisher()
    gate = HumanGate(
        job_url=JOB_URL,
        private_values=["x"],
        user_info_store=store,
        approved_origins=[JOB_ORIGIN],
        publish=publisher,
    )
    runtime = FakeRuntime()
    pending = asyncio.create_task(
        gate.request_additional_info(
            (
                AdditionalInfoSingleSelectQuestion(
                    id="bounded",
                    key="bounded.answer",
                    scope="global",
                    question="x" * 500,
                    answer_type="single_select",
                    options=[
                        AdditionalInfoOption(id="first", label="x" * 200),
                        AdditionalInfoOption(id="second", label="safe"),
                    ],
                ),
            ),
            runtime,
        )
    )

    _state, _event, detail = await publisher.next_event()
    question = detail["questions"][0]
    assert question.question == "x" * 500
    assert question.options[0].label == "x" * 200
    assert question.options[1].label == "safe"

    await gate.provide_additional_info(
        (
            AdditionalInfoSingleSelectCommandAnswer(
                id="bounded",
                status="answered",
                option_id="first",
            ),
        )
    )
    await pending

    disk = json.loads((tmp_path / "user-info.json").read_text(encoding="utf-8"))
    persisted_question = disk["global"]["bounded.answer"]["question"]
    assert len(persisted_question) == 500
    assert persisted_question.startswith("[redacted]")
    assert persisted_question.endswith("…")

def test_task_is_exact_compact_data_envelope_for_current_application(
    tmp_path: Path,
) -> None:
    base_request = make_request(tmp_path)
    resolved_resume_path = "/sandbox/session/uploads/resume.pdf"
    store_path = tmp_path / "saved-user-info.json"
    store_path.write_text(
        json.dumps(
            {
                "version": 1,
                "global": {
                    "availability.summer_2027": {
                        "answer_type": "text",
                        "status": "answered",
                        "question": "When are you available?",
                        "value": "June through August 2027",
                        "updated_at": "2026-07-19T12:34:56.000Z",
                    }
                },
                "applications": {
                    JOB_URL: {
                        "referral.source": {
                            "answer_type": "single_select",
                            "status": "declined",
                            "question": "How did you hear about this role?",
                            "updated_at": "2026-07-19T12:34:56.000Z",
                        }
                    },
                    "https://jobs.example/openings/other": {
                        "other.private": {
                            "answer_type": "boolean",
                            "status": "answered",
                            "question": "Other application?",
                            "value": True,
                            "updated_at": "2026-07-19T12:34:56.000Z",
                        }
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    request = ApplicationRunRequest(
        session=base_request.session.model_copy(
            update={"approved_origins": (JOB_ORIGIN, ATS_ORIGIN)}
        ),
        candidate=base_request.candidate,
        resume_display_name=base_request.resume_display_name,
        resume_source_display_name=base_request.resume_source_display_name,
        user_info=UserInfoStore(store_path).snapshot(JOB_URL),
        resume_upload_path=resolved_resume_path,
    )

    task = build_application_task(request)

    assert task == json.dumps(
        {
            "job": {
                "url": JOB_URL,
                "opportunity_kind": "job",
                "approved_origins": [JOB_ORIGIN, ATS_ORIGIN],
                "resume": {
                    "display_name": "resume.pdf",
                    "path": resolved_resume_path,
                },
            },
            "user_info": {
                "explicit": {
                    "full_name": "Ada Secret-Value",
                    "email": "private-person@example.test",
                    "work_authorization": "Explicit authorization fact",
                },
                "saved_global": {
                    "availability.summer_2027": {
                        "answer_type": "text",
                        "status": "answered",
                        "value": "June through August 2027",
                    }
                },
                "saved_application": {
                    "referral.source": {
                        "answer_type": "single_select",
                        "status": "declined",
                    }
                },
            },
            "evidence": [
                {
                    "category": "resume",
                    "name": "resume.tex",
                    "text": "Built a deterministic data service for Example Corp.",
                },
                {
                    "category": "profile",
                    "name": "profile.md",
                    "text": "Prefers infrastructure roles and careful operational work.",
                },
                {
                    "category": "context",
                    "name": "background.md",
                    "text": "The candidate maintained an internal deployment platform.",
                },
                {
                    "category": "anecdote",
                    "name": "incident.md",
                    "text": "Resolved a relevant production incident without inventing metrics.",
                },
                {
                    "category": "anecdote",
                    "name": "irrelevant.md",
                    "text": "An unrelated volunteer story.",
                },
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    assert "other.private" not in task
    assert "updated_at" not in task
    assert '"question"' not in task
    assert "workflow" not in task.lower()


@pytest.mark.parametrize(
    "opportunity_kind",
    ["job", "hackathon", "competition", "event", "networking_event"],
)
def test_task_carries_every_opportunity_kind_inside_private_job_envelope(
    tmp_path: Path,
    opportunity_kind: OpportunityKind,
) -> None:
    request = make_request(tmp_path, opportunity_kind=opportunity_kind)

    task = json.loads(build_application_task(request))

    assert task["job"]["opportunity_kind"] == opportunity_kind
