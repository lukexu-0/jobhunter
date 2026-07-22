from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
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
from jobhunter_browser_harness.models import (
    AdditionalInfoOption,
    AdditionalInfoSingleSelectCommandAnswer,
    AdditionalInfoSingleSelectQuestion,
    AdditionalInfoTextCommandAnswer,
    AdditionalInfoTextQuestion,
    CancelledApplicationResult,
    ReviewApplicationResult,
    HarnessServiceError,
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


@dataclass(slots=True)
class FakeBrowserProfile:
    allowed_domains: list[str]


class FakeBrowserSession:
    def __init__(self, url: str = JOB_URL, domains: list[str] | None = None) -> None:
        self.current_url = url
        self.browser_profile = FakeBrowserProfile(
            domains if domains is not None else [f"{JOB_ORIGIN}/"]
        )

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
    action_timeout: float = 1,
    review_snapshot: Any = None,
    user_info_store: Any = None,
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
        action_timeout=action_timeout,
    )
    return gate, publisher


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
            "warnings": ["Ada Secret-Value needs review"],
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
        "The application agent reported warnings; review all listed fields before submitting."
    ]
    assert sanitized.revision_count == 4
    assert sanitized.submit_attempted is False


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
        user_info=UserInfoStore(tmp_path / "empty-user-info.json").snapshot(JOB_URL),
    )


def assert_conflict(error: BaseException) -> None:
    assert isinstance(error, HarnessServiceError)
    assert error.status_code == 409
    assert error.code == "command_conflict"


@pytest.mark.asyncio
async def test_navigation_continue_publishes_gate_then_resumes() -> None:
    gate, publisher = make_gate()
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
    browser = FakeBrowserSession(
        "https://jobs.example/apply/private-person@example.test"
        "?secret=Ada%20Secret-Value#fragment"
    )
    pending = asyncio.create_task(gate.request_human_navigation("Log in.", browser))
    await publisher.next_event()
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

    browser.current_url = "https://jobs.example:99999/private"

    timeout_gate, timeout_publisher = make_gate(action_timeout=0.001)
    timed_out = await timeout_gate.request_human_navigation("Wait for human.", browser)
    timeout_payload = CancelledApplicationResult.model_validate_json(
        timed_out.extracted_content
    )
    assert timeout_publisher.events[0][0] == "awaiting_human_navigation"
    assert timed_out.is_done is True
    assert timed_out.success is False
    assert timeout_payload.status == "cancelled"
    assert timeout_payload.final_url == "https://jobs.example/openings/42"
    with pytest.raises(HarnessServiceError) as error:
        await timeout_gate.continue_navigation()
    assert_conflict(error.value)


@pytest.mark.asyncio
async def test_post_navigation_new_current_origin_requires_exact_approval_and_mutates_browser_state() -> None:
    domains = [f"{JOB_ORIGIN}/"]
    browser = FakeBrowserSession("https://ats.example/apply?token=private", domains)
    gate, publisher = make_gate()
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
    assert publisher.events[-1] == ("running", None, {})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wrong_origin",
    ["https://other.example", "https://ats.example.evil"],
)
async def test_pre_navigation_target_approval_rejects_mismatch_and_lookalike(
    wrong_origin: str,
) -> None:
    gate, publisher = make_gate()
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
    gate, publisher = make_gate()
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
    gate, publisher = make_gate(approved_origins=origins)

    existing = await gate.request_origin_approval(origins[5], browser)
    assert existing.is_done is False
    assert existing.extracted_content == "Origin is already approved."
    capped = await gate.request_origin_approval("https://twenty-first.example", browser)
    payload = CancelledApplicationResult.model_validate_json(capped.extracted_content)
    assert capped.is_done is True
    assert capped.success is False
    assert payload.status == "cancelled"
    assert len(gate.approved_origins) == 20
    assert len(browser.browser_profile.allowed_domains) == 20
    assert publisher.events == []


@pytest.mark.asyncio
async def test_duplicate_and_wrong_state_commands_conflict_without_changing_gate() -> None:
    gate, publisher = make_gate()
    browser = FakeBrowserSession()

    for command in (
        gate.continue_navigation,
        lambda: gate.approve_origin(ATS_ORIGIN),
        lambda: gate.revise("correction"),
        gate.submit,
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
    gate, publisher = make_gate()
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
async def test_submit_approval_is_one_way_and_cancellation_is_terminal_json() -> None:
    gate, publisher = make_gate()
    browser = FakeBrowserSession("https://jobs.example/apply?secret=yes")
    review = asyncio.create_task(gate.request_human_review(make_result(), browser))
    await publisher.next_event()
    await gate.submit()
    approved = await review
    approved_payload = ReviewApplicationResult.model_validate_json(
        approved.extracted_content
    )

    assert approved.is_done is False
    assert approved_payload.status == "ready_for_submission"
    assert approved_payload.submit_attempted is False
    assert approved_payload.revision_count == 0
    assert gate.submission_approved is True

    with pytest.raises(HarnessServiceError) as replay:
        await gate.submit()
    assert_conflict(replay.value)
    with pytest.raises(HarnessServiceError) as post_approval_gate:
        await gate.request_human_navigation("Do not reopen a gate.", browser)
    assert_conflict(post_approval_gate.value)

    cancelled_gate, cancelled_publisher = make_gate()
    cancelled_review = asyncio.create_task(
        cancelled_gate.request_human_review(make_result(), browser)
    )
    await cancelled_publisher.next_event()
    await cancelled_gate.cancel()
    cancelled = await cancelled_review
    cancelled_payload = CancelledApplicationResult.model_validate_json(
        cancelled.extracted_content
    )
    assert cancelled.is_done is True
    assert cancelled.success is False
    assert cancelled_payload.status == "cancelled"
    assert cancelled_payload.final_url == "https://jobs.example/apply"
    assert cancelled_payload.submit_attempted is False
    assert cancelled_payload.submission_confirmation is None




@pytest.mark.asyncio
async def test_additional_info_gate_redacts_public_questions_and_persists_original_values(
    tmp_path: Path,
) -> None:
    store = UserInfoStore(tmp_path / "user-info.json")
    gate, publisher = make_gate(user_info_store=store)
    browser = FakeBrowserSession()
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
    pending = asyncio.create_task(gate.request_additional_info(questions, browser))

    state, event, detail = await publisher.next_event()
    assert (state, event) == (
        "awaiting_additional_info",
        "additional_info_required",
    )
    public_questions = detail["questions"]
    assert isinstance(public_questions, list)
    assert public_questions[0].question == "When is [redacted] available?"
    assert public_questions[1].options[0].label == "[redacted] choice"
    assert public_questions[1].options[1].label == "[redacted] choice"
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
    assert "June through August 2027" in gate.redaction_values
    assert "private-person@example.test choice" in gate.redaction_values
    disk = json.loads((tmp_path / "user-info.json").read_text(encoding="utf-8"))
    assert (
        disk["applications"][JOB_URL]["referral.source"]["value"]
        == "private-person@example.test choice"
    )
    assert (
        disk["applications"][JOB_URL]["referral.source"]["question"]
        == "Who referred [redacted]?"
    )


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
    browser = FakeBrowserSession()
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
    pending = asyncio.create_task(gate.request_additional_info(questions, browser))
    await publisher.next_event()

    with pytest.raises(HarnessServiceError) as partial:
        await gate.provide_additional_info(
            (
                AdditionalInfoTextCommandAnswer(
                    id="first",
                    status="answered",
                    value="first private value",
                ),
            )
        )
    assert_conflict(partial.value)
    assert gate.pending_kind == "additional_info"
    assert "first private value" not in gate.redaction_values

    answers = (
        AdditionalInfoTextCommandAnswer(
            id="first",
            status="answered",
            value="first private value",
        ),
        AdditionalInfoTextCommandAnswer(
            id="second",
            status="answered",
            value="second private value",
        ),
    )
    with pytest.raises(HarnessServiceError) as failed:
        await gate.provide_additional_info(answers)
    assert failed.value.code == "internal_error"
    assert gate.pending_kind == "additional_info"
    assert {"first private value", "second private value"} <= gate.redaction_values

    await gate.cancel()
    cancelled = await pending
    assert cancelled.is_done is True


@pytest.mark.asyncio
async def test_additional_info_public_redaction_respects_wire_length_limits(
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
    browser = FakeBrowserSession()
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
            browser,
        )
    )

    _state, _event, detail = await publisher.next_event()
    question = detail["questions"][0]
    assert len(question.question) == 500
    assert question.question.endswith("…")
    assert len(question.options[0].label) == 200
    assert question.options[0].label.endswith("…")
    await gate.cancel()
    await pending

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
        user_info=UserInfoStore(store_path).snapshot(JOB_URL),
        resume_upload_path=resolved_resume_path,
    )

    task = build_application_task(request)

    assert task == json.dumps(
        {
            "job": {
                "url": JOB_URL,
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
                    "name": "resume.pdf",
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
