from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi import UploadFile
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from fixtures.local_application import LocalApplicationFixture
from jobhunter_browser_harness.playwright_cli import (
    PlaywrightCliRuntime,
    ResolvedBrowserLaunch,
)
from jobhunter_browser_harness.models import (
    AdditionalInfoBooleanCommandAnswer,
    AdditionalInfoBooleanQuestion,
    AdditionalInfoDeclinedCommandAnswer,
    AdditionalInfoMultiSelectCommandAnswer,
    AdditionalInfoMultiSelectQuestion,
    AdditionalInfoOption,
    AdditionalInfoRuntimeActionResponse,
    AdditionalInfoSingleSelectCommandAnswer,
    AdditionalInfoSingleSelectQuestion,
    AdditionalInfoTextCommandAnswer,
    AdditionalInfoTextQuestion,
    ApplicationRunResult,
    ReviewApplicationResult,
    SubmittedApplicationResult,
    PlaywrightCliResultRuntimeActionResponse,
    PlaywrightCliCommand,
    PlaywrightCliRuntimeAction,
    ContinueCommand,
    ContinueRuntimeActionResponse,
    HarnessConfig,
    ProvideAdditionalInfoCommand,
    SubmitRuntimeActionResponse,
    RequestAdditionalInfoRuntimeAction,
    RequestHumanNavigationRuntimeAction,
    RequestHumanReviewRuntimeAction,
)
from jobhunter_browser_harness.sessions import ApplicationSessionManager

_RELEVANT_ANSWER = (
    "I stabilized a production deployment incident by coordinating rollback, "
    "verifying service health, and documenting the follow-up."
)
_IRRELEVANT_FACT = "community garden fundraiser"
_INITIAL_REVIEW_REPLY = "Initial human reply: emphasize production reliability."
_SUMMER_AVAILABILITY = "June through August 2027"
_REFERRAL_SOURCE = "Employee referral"
_CALLER_SESSION_ID = UUID("1f017bcb-f6cd-4329-a78a-6e920522ca9d")


def _chromium_executable() -> Path:
    configured = os.environ.get("JOBHUNTER_TEST_CHROMIUM_EXECUTABLE")
    if configured:
        candidate = Path(configured).expanduser()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate.resolve()
        pytest.skip(
            "JOBHUNTER_TEST_CHROMIUM_EXECUTABLE does not name an executable Chromium binary"
        )

    roots: list[Path] = []
    playwright_root = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if playwright_root and playwright_root != "0":
        roots.append(Path(playwright_root).expanduser())
    roots.append(Path.home() / ".cache" / "ms-playwright")
    candidates: list[Path] = []
    for root in roots:
        if root.is_dir():
            candidates.extend(root.glob("chromium-*/chrome-linux*/chrome"))
            candidates.extend(
                root.glob("chromium_headless_shell-*/chrome-linux*/headless_shell")
            )
    for command in (
        "chromium",
        "chromium-browser",
        "google-chrome",
        "google-chrome-stable",
    ):
        resolved = shutil.which(command)
        if resolved:
            candidates.append(Path(resolved))
    executable = next(
        (
            candidate.resolve()
            for candidate in sorted(candidates, reverse=True)
            if candidate.is_file() and os.access(candidate, os.X_OK)
        ),
        None,
    )
    if executable is None:
        pytest.skip(
            "real Chromium executable unavailable; install Playwright Chromium or set "
            "JOBHUNTER_TEST_CHROMIUM_EXECUTABLE"
        )
    version = subprocess.run(
        [str(executable), "--version"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if version.returncode != 0:
        detail = (version.stderr or version.stdout).strip().splitlines()
        reason = detail[0] if detail else f"exit status {version.returncode}"
        pytest.skip(
            "Chromium cannot start because its executable/library prerequisite is "
            f"unavailable: {reason}"
        )
    return executable


def _node_executable() -> Path:
    configured = os.environ.get("JOBHUNTER_TEST_NODE_EXECUTABLE")
    resolved = configured or shutil.which("node")
    if resolved is None:
        pytest.skip("Node.js is unavailable")
    candidate = Path(resolved).expanduser()
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        pytest.skip("JOBHUNTER_TEST_NODE_EXECUTABLE does not name an executable file")
    return candidate.resolve()


def _playwright_cli_script() -> Path:
    configured = os.environ.get("JOBHUNTER_TEST_PLAYWRIGHT_CLI_SCRIPT")
    candidate = (
        Path(configured).expanduser()
        if configured
        else Path(__file__).resolve().parents[2]
        / "node_modules"
        / "@playwright"
        / "cli"
        / "playwright-cli.js"
    )
    if not candidate.is_file():
        pytest.skip("The Playwright CLI script is unavailable")
    return candidate.resolve()


def _upload(filename: str, content: bytes) -> UploadFile:
    return UploadFile(file=BytesIO(content), filename=filename)


def _pdf_bytes(text: str) -> bytes:
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


class _BlockingApplicationAgent:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self._result: asyncio.Future[ApplicationRunResult] = (
            asyncio.get_running_loop().create_future()
        )

    async def check_ready(self) -> None:
        return

    async def run(self, **_kwargs: Any) -> ApplicationRunResult:
        self.started.set()
        return await asyncio.shield(self._result)

    def finish(self, result: ApplicationRunResult) -> None:
        if not self._result.done():
            self._result.set_result(result)

    async def aclose(self) -> None:
        if not self._result.done():
            self._result.cancel()


async def _wait_for_state(
    manager: ApplicationSessionManager,
    session_id: Any,
    state: str,
    *,
    timeout: float = 30,
) -> None:
    async with asyncio.timeout(timeout):
        while manager.get_snapshot(session_id).state != state:
            await asyncio.sleep(0.02)


def _element_ref(dom: str, accessible_name: str) -> str:
    for line in dom.splitlines():
        if f'"{accessible_name}"' not in line:
            continue
        match = re.search(r"\[ref=((?:f\d+)?e\d+)\]", line)
        if match is not None:
            return match.group(1)
    raise AssertionError(f"No CLI element reference for {accessible_name!r} in:\n{dom}")


async def _cli(
    manager: ApplicationSessionManager,
    session_id: UUID,
    command: PlaywrightCliCommand,
    *args: str,
) -> PlaywrightCliResultRuntimeActionResponse:
    response = await manager.runtime_action(
        session_id,
        PlaywrightCliRuntimeAction(
            type="playwright_cli",
            command=command,
            args=list(args),
        ),
    )
    assert isinstance(response, PlaywrightCliResultRuntimeActionResponse)
    assert response.exit_code == 0, response.stderr
    assert response.timed_out is False
    return response


async def _human_click(runtime: PlaywrightCliRuntime, element_ref: str) -> None:
    result = await runtime._invoke("click", [element_ref], timeout=120)
    assert result.exit_code == 0, result.stderr
    assert result.timed_out is False
    assert runtime._reported_cli_error(result) is False


async def _page_values(runtime: PlaywrightCliRuntime) -> dict[str, Any]:
    result = await runtime.execute(
        "eval",
        [
            """() => JSON.stringify({
              fullName: document.querySelector('#full-name').value,
              email: document.querySelector('#email').value,
              incident: document.querySelector('#incident-answer').value,
              workStyle: document.querySelector('#work-style').value,
              focus: document.querySelector('input[name=focus]:checked')?.value || '',
              truthful: document.querySelector('#truthful').checked,
              years: document.querySelector('#years').value,
              summerAvailability: document.querySelector('#summer-availability').value,
              referralSource: document.querySelector('#referral-source').value,
              resume: document.querySelector('#resume').files[0]?.name || '',
              intermediateClick: document.querySelector('#intermediate-click').dataset.completed || '',
              intermediateEnter: document.querySelector('#keypress-target').dataset.completed || '',
              custom: document.querySelector('#custom-value').value,
              humanNext: document.querySelector('#human-next').dataset.completed || '',
              review: document.querySelector('#review-answer').value,
              reviewVisible: !document.querySelector('#review-panel').hidden
            })"""
        ],
    )
    assert result.exit_code == 0, result.stderr
    payload = json.loads(result.stdout)
    serialized: object = payload["result"]
    for _ in range(3):
        if not isinstance(serialized, str):
            break
        serialized = json.loads(serialized)
    assert isinstance(serialized, dict)
    return serialized


async def _wait_for_progress(
    fixture: LocalApplicationFixture,
    expected: dict[str, Any],
    timeout: float = 5,
) -> dict[str, Any]:
    async with asyncio.timeout(timeout):
        while True:
            progress = (await asyncio.to_thread(fixture.progress_snapshot))["progress"]
            if progress == expected:
                return progress
            await asyncio.sleep(0.05)


def _review_result(
    fixture: LocalApplicationFixture,
    resume_name: str,
    *,
    revision_count: int,
) -> ReviewApplicationResult:
    field_types = (
        ("Full name", "text"),
        ("Email", "text"),
        ("Relevant incident", "textarea"),
        ("Preferred work style", "select"),
        ("Availability", "radio"),
        ("Truthfulness", "checkbox"),
        ("Years of relevant experience", "number"),
        ("Summer 2027 availability", "text"),
        ("Referral source", "select"),
        ("Résumé", "file"),
        ("Custom widget", "unknown"),
        ("Review emphasis", "textarea"),
    )
    return ReviewApplicationResult(
        status="ready_for_submission",
        company="Example Systems",
        role="Reliability Engineer",
        job_url=fixture.posting_url,
        final_url=fixture.form_url,
        fields_filled=[
            {
                "label": label,
                "field_type": field_type,
                "value_present": True,
                "note": "Filled from fixture-authorized evidence.",
            }
            for label, field_type in field_types
        ],
        fields_needing_human=[],
        files_attached=[resume_name],
        warnings=[],
        revision_count=revision_count,
        submit_attempted=False,
    )


@pytest.mark.asyncio
async def test_real_fixture_submits_once_after_automatic_review_approval(
    tmp_path: Path,
) -> None:
    executable = _chromium_executable()
    node_executable = _node_executable()
    playwright_cli_script = _playwright_cli_script()
    profile = tmp_path / "chromium-profile"
    profile.mkdir(mode=0o700)
    agent = _BlockingApplicationAgent()
    runtimes: list[PlaywrightCliRuntime] = []

    def runtime_factory(**kwargs: Any) -> PlaywrightCliRuntime:
        runtime = PlaywrightCliRuntime(**kwargs)
        runtimes.append(runtime)
        return runtime

    with LocalApplicationFixture() as fixture:
        manager = ApplicationSessionManager(
            HarnessConfig(
                bearer_token="fixture-token-0123456789abcdef-0123456789",
                session_timeout=240,
                node_executable=node_executable,
                playwright_cli_script=playwright_cli_script,
                user_info_json=tmp_path / "user-info.json",
            ),
            artifacts_root=tmp_path / "sessions",
            browser_launch=ResolvedBrowserLaunch(
                cdp_url=None,
                executable_path=executable,
                user_data_dir=profile,
            ),
            model_factory=lambda *_args: agent,
            runtime_factory=runtime_factory,
        )
        personal = _upload(
            "profile.md",
            (
                "---\n"
                "full_name: Ada Fixture\n"
                "email: ada.fixture@example.test\n"
                "---\n"
                "Prefers careful, truthful infrastructure work.\n"
            ).encode(),
        )
        resume = _upload(
            "resume.pdf",
            _pdf_bytes("Seven years operating reliable deployment systems."),
        )
        created = await manager.create_session(
            session_id=_CALLER_SESSION_ID,
            job_url=fixture.posting_url,
            allow_domains=[fixture.form_origin],
            auto_submit=True,
            max_steps=20,
            personal_information=personal,
            resume=resume,
            context=[],
            anecdotes=[
                _upload("incident.md", _RELEVANT_ANSWER.encode()),
                _upload(
                    "garden.md",
                    f"Led an unrelated {_IRRELEVANT_FACT}.".encode(),
                ),
            ],
        )

        try:
            assert created.session_id == _CALLER_SESSION_ID
            await _wait_for_state(manager, created.session_id, "running")
            await asyncio.wait_for(agent.started.wait(), timeout=5)
            record = manager._active
            assert record is not None
            assert len(runtimes) == 1
            runtime = record.playwright_runtime
            assert runtime is runtimes[0]
            assert record.stored is not None
            initial_snapshot = manager.get_snapshot(created.session_id)
            assert (
                initial_snapshot.expires_at - initial_snapshot.created_at
            ).total_seconds() == 240

            posting = await _cli(manager, created.session_id, "snapshot")
            assert posting.observation.url == fixture.posting_url
            assert (
                await runtime.get_current_page_url()
                == fixture.posting_url
            )
            assert "Reliability Engineer" in posting.observation.dom
            assert posting.observation.screenshot is not None


            form = await _cli(
                manager,
                created.session_id,
                "goto",
                fixture.form_url,
            )
            assert form.observation.url == fixture.form_url
            assert "Human Next" in form.observation.dom
            form_dom = form.observation.dom
            await _cli(
                manager,
                created.session_id,
                "fill",
                _element_ref(form_dom, "Full name"),
                "Ada Fixture",
            )
            await _cli(
                manager,
                created.session_id,
                "fill",
                _element_ref(form_dom, "Email"),
                "ada.fixture@example.test",
            )
            await _cli(
                manager,
                created.session_id,
                "fill",
                _element_ref(form_dom, "Relevant incident"),
                _RELEVANT_ANSWER,
            )
            await _cli(
                manager,
                created.session_id,
                "select",
                _element_ref(form_dom, "Preferred work style"),
                "remote",
            )
            await _cli(
                manager,
                created.session_id,
                "check",
                _element_ref(form_dom, "Deployment systems"),
            )
            await _cli(
                manager,
                created.session_id,
                "check",
                _element_ref(form_dom, "I confirm these answers are truthful"),
            )
            await _cli(
                manager,
                created.session_id,
                "fill",
                _element_ref(form_dom, "Years of relevant experience"),
                "7",
            )
            revealed_checkpoint = await _cli(
                manager,
                created.session_id,
                "click",
                _element_ref(form_dom, "Enable keyboard checkpoint"),
            )
            await _cli(
                manager,
                created.session_id,
                "fill",
                _element_ref(
                    revealed_checkpoint.observation.dom,
                    "Keyboard checkpoint",
                ),
                "armed",
            )
            await _cli(manager, created.session_id, "press", "Enter")
            await _cli(
                manager,
                created.session_id,
                "eval",
                "() => window.setCustomWidget('evaluation-set')",
            )
            resume_path = record.stored.resume.path.resolve()
            assert resume_path.is_absolute()
            await _cli(
                manager,
                created.session_id,
                "click",
                _element_ref(form_dom, "Résumé"),
            )
            fill = await _cli(
                manager,
                created.session_id,
                "upload",
                str(resume_path),
            )
            assert fill.observation.url == fixture.form_url

            before_additional_info = {
                "fullName": "Ada Fixture",
                "email": "ada.fixture@example.test",
                "incident": _RELEVANT_ANSWER,
                "workStyle": "remote",
                "focus": "deployment-systems",
                "truthful": True,
                "years": "7",
                "summerAvailability": "",
                "referralSource": "",
                "resume": "resume.pdf",
                "intermediateClick": "true",
                "intermediateEnter": "true",
                "custom": "evaluation-set",
                "humanNext": "",
                "review": "Initial perspective",
                "reviewVisible": False,
            }
            assert (
                await _wait_for_progress(fixture, before_additional_info)
                == before_additional_info
            )
            assert (await asyncio.to_thread(fixture.submit_snapshot))["submit_count"] == 0

            additional_info_task = asyncio.create_task(
                manager.runtime_action(
                    created.session_id,
                    RequestAdditionalInfoRuntimeAction(
                        type="request_additional_info",
                        questions=[
                            AdditionalInfoTextQuestion(
                                id="summer_availability",
                                key="availability.summer_2027",
                                scope="global",
                                question="When are you available during summer 2027?",
                                answer_type="text",
                            ),
                            AdditionalInfoSingleSelectQuestion(
                                id="referral_source",
                                key="referral.source",
                                scope="application",
                                question="How did you hear about this role?",
                                answer_type="single_select",
                                options=[
                                    AdditionalInfoOption(
                                        id="employee_referral",
                                        label=_REFERRAL_SOURCE,
                                    ),
                                    AdditionalInfoOption(
                                        id="job_board",
                                        label="Job board",
                                    ),
                                ],
                            ),
                            AdditionalInfoBooleanQuestion(
                                id="relocation",
                                key="relocation.willing",
                                scope="global",
                                question="Are you willing to relocate?",
                                answer_type="boolean",
                            ),
                            AdditionalInfoMultiSelectQuestion(
                                id="work_modes",
                                key="preferences.work_modes",
                                scope="application",
                                question="Which work modes are acceptable?",
                                answer_type="multi_select",
                                options=[
                                    AdditionalInfoOption(
                                        id="remote",
                                        label="Remote",
                                    ),
                                    AdditionalInfoOption(
                                        id="hybrid",
                                        label="Hybrid",
                                    ),
                                    AdditionalInfoOption(
                                        id="office",
                                        label="Office",
                                    ),
                                ],
                            ),
                            AdditionalInfoTextQuestion(
                                id="compensation",
                                key="compensation.expectation",
                                scope="application",
                                question="What compensation do you expect?",
                                answer_type="text",
                            ),
                        ],
                    ),
                )
            )
            await _wait_for_state(
                manager,
                created.session_id,
                "awaiting_additional_info",
            )
            additional_pending = manager.get_snapshot(
                created.session_id
            ).pending_action
            assert additional_pending is not None
            additional_pending_json = additional_pending.model_dump(mode="json")
            assert additional_pending_json["type"] == "additional_info"
            assert [
                question["answer_type"]
                for question in additional_pending_json["questions"]
            ] == [
                "text",
                "single_select",
                "boolean",
                "multi_select",
                "text",
            ]
            assert "value" not in json.dumps(additional_pending_json)
            await manager.command(
                created.session_id,
                ProvideAdditionalInfoCommand(
                    type="provide_additional_info",
                    answers=[
                        AdditionalInfoTextCommandAnswer(
                            id="summer_availability",
                            status="answered",
                            raw_value=_SUMMER_AVAILABILITY,
                            value=_SUMMER_AVAILABILITY,
                        ),
                        AdditionalInfoSingleSelectCommandAnswer(
                            id="referral_source",
                            status="answered",
                            option_id="employee_referral",
                        ),
                        AdditionalInfoBooleanCommandAnswer(
                            id="relocation",
                            status="answered",
                            value=False,
                        ),
                        AdditionalInfoMultiSelectCommandAnswer(
                            id="work_modes",
                            status="answered",
                            option_ids=["remote", "hybrid"],
                        ),
                        AdditionalInfoDeclinedCommandAnswer(
                            id="compensation",
                            status="declined",
                        ),
                    ],
                ),
            )
            additional_info = await additional_info_task
            assert isinstance(additional_info, AdditionalInfoRuntimeActionResponse)
            assert [answer.value for answer in additional_info.answers] == [
                _SUMMER_AVAILABILITY,
                _REFERRAL_SOURCE,
                False,
                ["Remote", "Hybrid"],
                None,
            ]
            assert manager.get_snapshot(created.session_id).pending_action is None
            stored_user_info = json.loads(
                (tmp_path / "user-info.json").read_text(encoding="utf-8")
            )
            assert stored_user_info["version"] == 2
            assert set(stored_user_info["global"]) == {
                "availability.summer_2027",
                "relocation.willing",
            }
            assert set(stored_user_info["applications"]) == {
                fixture.posting_url,
            }
            application_facts = stored_user_info["applications"][
                fixture.posting_url
            ]
            assert set(application_facts) == {
                "referral.source",
                "preferences.work_modes",
                "compensation.expectation",
            }
            assert stored_user_info["global"]["availability.summer_2027"][
                "raw_value"
            ] == _SUMMER_AVAILABILITY
            assert stored_user_info["global"]["availability.summer_2027"][
                "sanitized_value"
            ] == _SUMMER_AVAILABILITY
            assert stored_user_info["global"]["relocation.willing"]["value"] is False
            assert application_facts["referral.source"]["value"] == _REFERRAL_SOURCE
            assert application_facts["preferences.work_modes"]["value"] == [
                "Remote",
                "Hybrid",
            ]
            assert application_facts["compensation.expectation"][
                "status"
            ] == "declined"
            assert "value" not in application_facts["compensation.expectation"]

            await _cli(
                manager,
                created.session_id,
                "fill",
                _element_ref(form_dom, "Summer 2027 availability"),
                str(additional_info.answers[0].value),
            )
            applied_info = await _cli(
                manager,
                created.session_id,
                "select",
                _element_ref(form_dom, "Referral source"),
                str(additional_info.answers[1].value),
            )
            before_human = before_additional_info | {
                "summerAvailability": _SUMMER_AVAILABILITY,
                "referralSource": _REFERRAL_SOURCE,
            }
            assert await _wait_for_progress(fixture, before_human) == before_human

            navigation_task = asyncio.create_task(
                manager.runtime_action(
                    created.session_id,
                    RequestHumanNavigationRuntimeAction(
                        type="request_human_navigation",
                        instruction=(
                            "Please inspect the completed first page and click Human Next."
                        ),
                    ),
                )
            )
            await _wait_for_state(
                manager,
                created.session_id,
                "awaiting_human_navigation",
            )
            navigation_pending = manager.get_snapshot(
                created.session_id
            ).pending_action
            assert navigation_pending is not None
            assert navigation_pending.model_dump(mode="json") == {
                "type": "human_navigation",
                "instruction": (
                    "Please inspect the completed first page and click Human Next."
                ),
            }
            await _human_click(
                runtime,
                _element_ref(form_dom, "Human Next"),
            )
            assert (
                await runtime.get_current_page_url()
                == fixture.form_url
            )
            await manager.command(
                created.session_id,
                ContinueCommand(type="continue"),
            )
            continued = await navigation_task
            assert isinstance(continued, ContinueRuntimeActionResponse)
            inspected_review = await _cli(
                manager,
                created.session_id,
                "snapshot",
            )
            assert "Final review" in inspected_review.observation.dom
            assert (
                await _page_values(runtime)
            )["review"] == "Initial perspective"
            question = AdditionalInfoTextQuestion(
                id="review_emphasis",
                key="application.review_emphasis",
                scope="application",
                question="Review emphasis",
                answer_type="text",
            )

            late_info_task = asyncio.create_task(
                manager.runtime_action(
                    created.session_id,
                    RequestAdditionalInfoRuntimeAction(
                        type="request_additional_info",
                        questions=[question],
                    ),
                )
            )
            await _wait_for_state(
                manager,
                created.session_id,
                "awaiting_additional_info",
            )
            late_pending = manager.get_snapshot(
                created.session_id
            ).pending_action
            assert late_pending is not None
            assert late_pending.model_dump(mode="json") == {
                "type": "additional_info",
                "questions": [question.model_dump(mode="json")],
            }
            await manager.command(
                created.session_id,
                ProvideAdditionalInfoCommand(
                    type="provide_additional_info",
                    answers=[
                        AdditionalInfoTextCommandAnswer(
                            id=question.id,
                            status="answered",
                            raw_value=_INITIAL_REVIEW_REPLY,
                            value=_INITIAL_REVIEW_REPLY,
                        )
                    ],
                ),
            )
            late_info = await late_info_task
            assert isinstance(late_info, AdditionalInfoRuntimeActionResponse)
            assert len(late_info.answers) == 1
            assert late_info.answers[0].value == _INITIAL_REVIEW_REPLY
            applied_late_info = await _cli(
                manager,
                created.session_id,
                "fill",
                _element_ref(
                    inspected_review.observation.dom,
                    "Review emphasis",
                ),
                _INITIAL_REVIEW_REPLY,
            )
            assert (
                await _page_values(runtime)
            )["review"] == _INITIAL_REVIEW_REPLY


            approved = await manager.runtime_action(
                created.session_id,
                RequestHumanReviewRuntimeAction(
                    type="request_human_review",
                    result=_review_result(
                        fixture,
                        "resume.pdf",
                        revision_count=0,
                    ),
                ),
            )
            assert isinstance(approved, SubmitRuntimeActionResponse)
            assert approved.instruction == "You're good to submit."
            assert approved.result.revision_count == 0
            assert approved.result.submit_attempted is False
            assert manager.get_snapshot(created.session_id).pending_action is None
            assert (await asyncio.to_thread(fixture.submit_snapshot))["submit_count"] == 0

            submission = await _cli(
                manager,
                created.session_id,
                "click",
                _element_ref(
                    inspected_review.observation.dom,
                    "Submit application",
                ),
            )
            assert submission.observation.url == fixture.form_url
            assert "Submitted 1 time(s)" not in applied_late_info.observation.dom
            assert "Submitted 1 time(s)" in submission.observation.dom
            agent.finish(
                SubmittedApplicationResult.model_validate(
                    {
                        **approved.result.model_dump(),
                        "status": "submitted",
                        "final_url": submission.observation.url,
                        "submit_attempted": True,
                        "submission_confirmation": {
                            "type": "post_submit_confirmation",
                            "text": "Submitted 1 time(s)",
                        },
                    }
                )
            )
            await _wait_for_state(
                manager,
                created.session_id,
                "submitted",
            )
            submitted_snapshot = manager.get_snapshot(created.session_id)
            assert submitted_snapshot.pending_action is None
            assert submitted_snapshot.expires_at == initial_snapshot.expires_at
            assert submitted_snapshot.playwright_cli_diagnostics
            assert len(submitted_snapshot.playwright_cli_diagnostics) == (
                record.playwright_cli_action_count
            )
            assert all(
                diagnostic.status == "succeeded"
                for diagnostic in submitted_snapshot.playwright_cli_diagnostics
            )
            public_session_data = json.dumps(
                {
                    "snapshot": submitted_snapshot.model_dump(mode="json"),
                    "events": [
                        event.model_dump(mode="json")
                        for event in record.events
                    ],
                }
            )
            assert "Submitted 1 time(s)" not in public_session_data
            assert _SUMMER_AVAILABILITY not in public_session_data
            assert '"status": "answered"' not in public_session_data

            values = await _page_values(runtime)
            assert values == before_human | {
                "humanNext": "true",
                "review": _INITIAL_REVIEW_REPLY,
                "reviewVisible": True,
            }
            assert _IRRELEVANT_FACT not in str(values)
            submitted = await asyncio.to_thread(fixture.submit_snapshot)
            assert submitted["submit_count"] == 1
            assert submitted["last_submission"]["incident_answer"] == _RELEVANT_ANSWER
            assert submitted["last_submission"]["review_answer"] == _INITIAL_REVIEW_REPLY
            assert submitted["last_submission"]["resume"] == "resume.pdf"
        finally:
            await manager.delete(created.session_id)
            assert manager.get_snapshot(created.session_id).state == "closed"
