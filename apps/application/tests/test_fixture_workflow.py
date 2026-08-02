from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from browser_use import Browser
from fastapi import UploadFile
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from fixtures.local_application import LocalApplicationFixture
from jobhunter_browser_harness.browser import ResolvedBrowserLaunch
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
    ApproveOriginCommand,
    ApproveRuntimeActionResponse,
    BrowserUseResultRuntimeActionResponse,
    BrowserUseRuntimeAction,
    ContinueCommand,
    ContinueRuntimeActionResponse,
    HarnessConfig,
    ProvideAdditionalInfoCommand,
    SubmitRuntimeActionResponse,
    RequestAdditionalInfoRuntimeAction,
    RequestHumanNavigationRuntimeAction,
    RequestHumanReviewRuntimeAction,
    RequestOriginApprovalRuntimeAction,
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


async def _human_click(browser: Browser, element_id: str) -> None:
    state = await browser.get_browser_state_summary(
        include_screenshot=False,
        cached=False,
    )
    assert state.dom_state is not None
    index = await browser.get_index_by_id(element_id)
    assert index is not None, f"Browser Use did not index human control #{element_id}"
    node = state.dom_state.selector_map[index]
    page = await browser.must_get_current_page()
    element = await page.get_element(node.backend_node_id)
    await element.click()


async def _page_values(browser: Browser) -> dict[str, Any]:
    page = await browser.must_get_current_page()
    serialized = await page.evaluate(
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
    )
    return json.loads(serialized)


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


def _fill_form_code(form_url: str, resume_path: str) -> str:
    values = {
        "full-name": "Ada Fixture",
        "email": "ada.fixture@example.test",
        "incident-answer": _RELEVANT_ANSWER,
        "work-style": "remote",
        "years": "7",
        "keypress-target": "armed",
    }
    script = f"""(() => {{
  const values = {json.dumps(values)};
  const setValue = (id, value) => {{
    const element = document.getElementById(id);
    element.value = value;
    element.dispatchEvent(new Event('input', {{bubbles: true}}));
    element.dispatchEvent(new Event('change', {{bubbles: true}}));
  }};
  Object.entries(values).forEach(([id, value]) => setValue(id, value));
  document.getElementById('focus-deployment').click();
  document.getElementById('truthful').click();
  document.getElementById('intermediate-click').click();
  const checkpoint = document.getElementById('keypress-target');
  checkpoint.dispatchEvent(new KeyboardEvent(
    'keydown',
    {{key: 'Enter', bubbles: true, cancelable: true}}
  ));
  window.setCustomWidget('evaluation-set');
  return document.title;
}})()"""
    return (
        f"new_tab({form_url!r})\n"
        "wait_for_load()\n"
        f"script = {script!r}\n"
        "print(js(script))\n"
        "document = cdp('DOM.getDocument', depth=0)\n"
        "resume = cdp("
        "'DOM.querySelector', "
        "nodeId=document['root']['nodeId'], "
        "selector='#resume'"
        ")\n"
        f"cdp('DOM.setFileInputFiles', files=[{resume_path!r}], "
        "nodeId=resume['nodeId'])\n"
        "js(\"document.getElementById('resume').dispatchEvent("
        "new Event('change', {bubbles: true}))\")\n"
        "print(page_info())"
    )


def _fill_additional_info_code(
    summer_availability: str,
    referral_source: str,
) -> str:
    values = {
        "summer-availability": summer_availability,
        "referral-source": referral_source,
    }
    script = f"""(() => {{
  const values = {json.dumps(values)};
  for (const [id, value] of Object.entries(values)) {{
    const element = document.getElementById(id);
    element.value = value;
    element.dispatchEvent(new Event('input', {{bubbles: true}}));
    element.dispatchEvent(new Event('change', {{bubbles: true}}));
  }}
}})()"""
    return f"js({script!r})\nprint(page_info())"


def _set_review_code(value: str) -> str:
    script = (
        "(() => { "
        "const element = document.getElementById('review-answer'); "
        f"element.value = {json.dumps(value)}; "
        "element.dispatchEvent(new Event('input', {bubbles: true})); "
        "})()"
    )
    return f"js({script!r})\nprint(page_info())"




@pytest.mark.skipif(
    sys.platform != "linux",
    reason="Bubblewrap namespace execution requires Linux",
)
@pytest.mark.asyncio
async def test_real_fixture_submits_once_after_automatic_review_approval(
    tmp_path: Path,
) -> None:
    executable = _chromium_executable()
    profile = tmp_path / "chromium-profile"
    profile.mkdir(mode=0o700)
    agent = _BlockingApplicationAgent()

    with LocalApplicationFixture() as fixture:
        manager = ApplicationSessionManager(
            HarnessConfig(
                bearer_token="fixture-token-0123456789abcdef-0123456789",
                session_timeout=120,
                browser_skill_workspace=tmp_path / "browser-skill" / "agent-workspace",
                bubblewrap_executable=Path("/usr/bin/bwrap"),
                user_info_json=tmp_path / "user-info.json",
            ),
            artifacts_root=tmp_path / "sessions",
            browser_launch=ResolvedBrowserLaunch(
                cdp_url=None,
                executable_path=executable,
                user_data_dir=profile,
            ),
            model_factory=lambda *_args: agent,
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
            allow_domains=[],
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
            assert record is not None and isinstance(record.browser, Browser)
            assert record.stored is not None
            initial_snapshot = manager.get_snapshot(created.session_id)
            assert (
                initial_snapshot.expires_at - initial_snapshot.created_at
            ).total_seconds() == 120

            posting = await manager.runtime_action(
                created.session_id,
                BrowserUseRuntimeAction(
                    type="browser_use",
                    code=(
                        f"new_tab({fixture.posting_url!r})\n"
                        "wait_for_load()\n"
                        "print(page_info())"
                    ),
                ),
            )
            assert isinstance(posting, BrowserUseResultRuntimeActionResponse)
            assert posting.exit_code == 0
            assert posting.observation.url == fixture.posting_url
            assert "Reliability Engineer" in posting.observation.dom
            assert posting.observation.screenshot is not None

            approval_task = asyncio.create_task(
                manager.runtime_action(
                    created.session_id,
                    RequestOriginApprovalRuntimeAction(
                        type="request_origin_approval",
                        origin=fixture.form_origin,
                    ),
                )
            )
            await _wait_for_state(
                manager,
                created.session_id,
                "awaiting_origin_approval",
            )
            origin_pending = manager.get_snapshot(created.session_id).pending_action
            assert origin_pending is not None
            assert origin_pending.model_dump(mode="json") == {
                "type": "origin_approval",
                "origin": fixture.form_origin,
            }
            await manager.command(
                created.session_id,
                ApproveOriginCommand(
                    type="approve_origin",
                    origin=fixture.form_origin,
                ),
            )
            approval = await approval_task
            assert isinstance(approval, ApproveRuntimeActionResponse)
            assert approval.approved_origins == [
                fixture.posting_origin,
                fixture.form_origin,
            ]

            fill = await manager.runtime_action(
                created.session_id,
                BrowserUseRuntimeAction(
                    type="browser_use",
                    code=_fill_form_code(
                        fixture.form_url,
                        str(record.stored.resume.path),
                    ),
                ),
            )
            assert isinstance(fill, BrowserUseResultRuntimeActionResponse)
            assert fill.exit_code == 0, fill.stderr
            assert fill.observation.url == fixture.form_url
            assert "Human Next" in fill.observation.dom

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
            assert stored_user_info["version"] == 1
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
                "value"
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

            applied_info = await manager.runtime_action(
                created.session_id,
                BrowserUseRuntimeAction(
                    type="browser_use",
                    code=_fill_additional_info_code(
                        str(additional_info.answers[0].value),
                        str(additional_info.answers[1].value),
                    ),
                ),
            )
            assert isinstance(applied_info, BrowserUseResultRuntimeActionResponse)
            assert applied_info.exit_code == 0, applied_info.stderr
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
            await _human_click(record.browser, "human-next")
            await manager.command(
                created.session_id,
                ContinueCommand(type="continue"),
            )
            continued = await navigation_task
            assert isinstance(continued, ContinueRuntimeActionResponse)
            inspected_review = await manager.runtime_action(
                created.session_id,
                BrowserUseRuntimeAction(
                    type="browser_use",
                    code="result = page_info()",
                ),
            )
            assert isinstance(
                inspected_review,
                BrowserUseResultRuntimeActionResponse,
            )
            assert inspected_review.exit_code == 0, inspected_review.stderr
            assert (await _page_values(record.browser))["review"] == (
                "Initial perspective"
            )
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
                            value=_INITIAL_REVIEW_REPLY,
                        )
                    ],
                ),
            )
            late_info = await late_info_task
            assert isinstance(late_info, AdditionalInfoRuntimeActionResponse)
            assert len(late_info.answers) == 1
            assert late_info.answers[0].value == _INITIAL_REVIEW_REPLY
            applied_late_info = await manager.runtime_action(
                created.session_id,
                BrowserUseRuntimeAction(
                    type="browser_use",
                    code=_set_review_code(_INITIAL_REVIEW_REPLY),
                ),
            )
            assert isinstance(
                applied_late_info,
                BrowserUseResultRuntimeActionResponse,
            )
            assert applied_late_info.exit_code == 0, applied_late_info.stderr
            assert (await _page_values(record.browser))["review"] == (
                _INITIAL_REVIEW_REPLY
            )


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

            submission = await manager.runtime_action(
                created.session_id,
                BrowserUseRuntimeAction(
                    type="browser_use",
                    code=(
                        "js(\"document.getElementById('final-submit').click()\")\n"
                        "wait(0.5)\n"
                        "wait_for_load(timeout=15.0)\n"
                        "wait_for_network_idle(timeout=10.0, idle_ms=500)\n"
                        "print(page_info())"
                    ),
                ),
            )
            assert isinstance(submission, BrowserUseResultRuntimeActionResponse)
            assert submission.exit_code == 0, submission.stderr
            assert submission.timed_out is False
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

            values = await _page_values(record.browser)
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
