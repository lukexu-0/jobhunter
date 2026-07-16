from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from pathlib import Path
from types import MappingProxyType
from typing import Any
from uuid import UUID

os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
os.environ.setdefault("BROWSER_USE_ACTION_TIMEOUT_S", "60")

import pytest
from browser_use import Browser
from browser_use.llm.messages import BaseMessage
from browser_use.llm.views import ChatInvokeCompletion, ChatInvokeUsage
from browser_use.tools.service import Tools

from fixtures.local_application import LocalApplicationFixture
from jobhunter_browser_harness.agent import (
    ApplicationRunRequest,
    run_application,
)
from jobhunter_browser_harness.context import AttributedSource, CandidateContext
from jobhunter_browser_harness.models import SessionCreateRequest, UploadedArtifacts
from jobhunter_browser_harness.tools import (
    DEFAULT_ACTIONS_0_13_4,
    HumanGate,
    create_unfiltered_tools,
)

_SESSION_ID = UUID("27b3e3bb-d2a0-45e8-8422-16d29c8b8fc1")
_RELEVANT_ANSWER = (
    "I stabilized a production deployment incident by coordinating rollback, "
    "verifying service health, and documenting the follow-up."
)
_IRRELEVANT_FACT = "community garden fundraiser"
_REVISION = "Human revision: emphasize careful incident ownership."
_CUSTOM_ACTIONS = {
    "request_human_navigation",
    "request_origin_approval",
    "report_application_mismatch",
    "request_human_review",
}


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
            candidates.extend(root.glob("chromium_headless_shell-*/chrome-linux*/headless_shell"))
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
        pytest.skip(f"Chromium cannot start because its executable/library prerequisite is unavailable: {reason}")
    return executable


class _Events:
    def __init__(self) -> None:
        self.items: list[tuple[str, str | None, dict[str, object]]] = []

    async def __call__(
        self,
        state: str,
        event: str | None,
        detail: dict[str, object],
    ) -> None:
        self.items.append((state, event, dict(detail)))


class _ScriptedApplicationModel:
    _verified_api_keys = True
    model = "fixture-script"

    def __init__(
        self,
        browser: Browser,
        fixture: LocalApplicationFixture,
        resume: Path,
    ) -> None:
        self.browser = browser
        self.fixture = fixture
        self.resume = resume
        self.phase = 0
        self.action_names: list[str] = []
        self.saw_posting = False
        self.saw_form = False

    @property
    def provider(self) -> str:
        return "fixture"

    @property
    def name(self) -> str:
        return self.model

    @property
    def model_name(self) -> str:
        return self.model

    async def ainvoke(
        self,
        messages: list[BaseMessage],
        output_format: type[Any] | None = None,
        **_kwargs: Any,
    ) -> ChatInvokeCompletion[Any]:
        assert messages
        assert output_format is not None
        action_name, params = await self._next_action()
        self.action_names.append(action_name)
        output = output_format.model_validate(
            {
                "evaluation_previous_goal": "The deterministic prior action completed.",
                "memory": f"Fixture phase {self.phase} is complete.",
                "next_goal": action_name,
                "action": [{action_name: params}],
            }
        )
        return ChatInvokeCompletion(
            completion=output,
            usage=ChatInvokeUsage(
                prompt_tokens=0,
                prompt_cached_tokens=None,
                prompt_cache_creation_tokens=None,
                prompt_image_tokens=None,
                completion_tokens=0,
                total_tokens=0,
            ),
        )

    async def _next_action(self) -> tuple[str, dict[str, Any]]:
        phase = self.phase
        self.phase += 1
        if phase == 0:
            return "navigate", {"url": self.fixture.posting_url, "new_tab": False}
        if phase == 1:
            text = await self._body_text()
            self.saw_posting = all(
                value in text
                for value in (
                    "Example Systems",
                    "Reliability Engineer",
                    "production incident",
                )
            )
            assert self.saw_posting
            return "request_origin_approval", {"origin": self.fixture.form_origin}
        if phase == 2:
            return "click", {"index": await self._index("apply-link")}

        if phase == 3:
            text = await self._body_text()
            self.saw_form = all(
                value in text
                for value in (
                    "Example Systems",
                    "Reliability Engineer application",
                    "deployment reliability",
                )
            )
            assert self.saw_form
            return "input", {
                "index": await self._index("full-name"),
                "text": "<secret>full_name</secret>",
                "clear": True,
            }
        if phase == 4:
            return "input", {
                "index": await self._index("email"),
                "text": "<secret>email</secret>",
                "clear": True,
            }
        if phase == 5:
            return "input", {
                "index": await self._index("incident-answer"),
                "text": _RELEVANT_ANSWER,
                "clear": True,
            }
        if phase == 6:
            return "select_dropdown", {
                "index": await self._index("work-style"),
                "text": "Remote",
            }
        if phase == 7:
            return "click", {"index": await self._index("focus-deployment")}
        if phase == 8:
            return "click", {"index": await self._index("truthful")}
        if phase == 9:
            return "input", {
                "index": await self._index("years"),
                "text": "7",
                "clear": True,
            }
        if phase == 10:
            return "upload_file", {
                "index": await self._index("resume"),
                "path": str(self.resume),
            }
        if phase == 11:
            return "click", {"index": await self._index("intermediate-click")}
        if phase == 12:
            return "input", {
                "index": await self._index("keypress-target"),
                "text": "armed",
                "clear": True,
            }
        if phase == 13:
            return "send_keys", {"keys": "Enter"}
        if phase == 14:
            return "evaluate", {"code": "window.setCustomWidget('evaluation-set')"}
        if phase == 15:
            return "request_human_navigation", {
                "instruction": "Please inspect the completed first page and click Human Next."
            }
        if phase == 16:
            return "request_human_review", self._review_result(revision_count=0)
        if phase == 17:
            return "input", {
                "index": await self._index("review-answer"),
                "text": _REVISION,
                "clear": True,
            }
        if phase == 18:
            return "request_human_review", self._review_result(revision_count=1)
        raise AssertionError(f"scripted model received unexpected phase {phase}")

    async def _index(self, element_id: str) -> int:
        await self.browser.get_browser_state_summary(
            include_screenshot=False,
            cached=False,
        )
        index = await self.browser.get_index_by_id(element_id)
        assert index is not None, f"Browser Use did not index #{element_id}"
        return index

    async def _body_text(self) -> str:
        page = await self.browser.must_get_current_page()
        return await page.evaluate("() => document.body.innerText")

    def _review_result(self, *, revision_count: int) -> dict[str, Any]:
        field_types = (
            ("Full name", "text"),
            ("Email", "text"),
            ("Relevant incident", "textarea"),
            ("Preferred work style", "select"),
            ("Availability", "radio"),
            ("Truthfulness", "checkbox"),
            ("Years of relevant experience", "number"),
            ("Résumé", "file"),
            ("Custom widget", "unknown"),
            ("Review emphasis", "textarea"),
        )
        return {
            "status": "ready_for_human_submit",
            "company": "Example Systems",
            "role": "Reliability Engineer",
            "job_url": self.fixture.posting_url,
            "final_url": self.fixture.form_url,
            "fields_filled": [
                {
                    "label": label,
                    "field_type": field_type,
                    "value_present": True,
                    "note": "Filled from fixture-authorized evidence.",
                }
                for label, field_type in field_types
            ],
            "fields_needing_human": [],
            "files_attached": [self.resume.name],
            "warnings": [],
            "revision_count": revision_count,
            "submit_attempted": False,
        }


async def _wait_for_gate(gate: HumanGate, kind: str, timeout: float = 30) -> None:
    async with asyncio.timeout(timeout):
        while gate.pending_kind != kind:
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
          resume: document.querySelector('#resume').files[0]?.name || '',
          intermediateClick: document.querySelector('#intermediate-click').dataset.completed || '',
          intermediateEnter: document.querySelector('#keypress-target').dataset.completed || '',
          custom: document.querySelector('#custom-value').value,
          humanNext: document.querySelector('#human-next').dataset.completed || '',
          review: document.querySelector('#review-answer').value,
          reviewVisible: !document.querySelector('#review-panel').hidden
        })"""
    )
    import json

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


def _candidate() -> CandidateContext:
    return CandidateContext(
        direct_fields=MappingProxyType(
            {
                "full_name": "Ada Fixture",
                "email": "ada.fixture@example.test",
            }
        ),
        resume_text="Seven years operating reliable deployment systems.",
        profile_narrative=AttributedSource(
            name="profile.md",
            category="profile",
            text="Prefers careful, truthful infrastructure work.",
        ),
        context_sources=(),
        anecdotes=(
            AttributedSource(
                name="incident.md",
                category="anecdote",
                text=_RELEVANT_ANSWER,
            ),
            AttributedSource(
                name="garden.md",
                category="anecdote",
                text=f"Led an unrelated {_IRRELEVANT_FACT}.",
            ),
        ),
    )


def _action(tools: Tools, name: str, params: dict[str, Any]) -> Any:
    model = tools.registry.create_action_model(include_actions=[name])
    return model(**{name: params})


@pytest.mark.asyncio
async def test_real_browser_use_fixture_workflow_stops_for_human_submit(
    tmp_path: Path,
) -> None:
    executable = _chromium_executable()
    session_directory = tmp_path / "session"
    session_directory.mkdir(mode=0o700)
    profile = tmp_path / "chromium-profile"
    profile.mkdir(mode=0o700)
    downloads = session_directory / "downloads"
    downloads.mkdir(mode=0o700)
    resume = session_directory / "resume.pdf"
    resume.write_bytes(b"%PDF-1.4\n% deterministic fixture upload\n")
    personal = session_directory / "profile.md"
    personal.write_text("Fixture profile", encoding="utf-8")

    with LocalApplicationFixture() as fixture:
        browser = Browser(
            executable_path=executable,
            user_data_dir=profile,
            headless=True,
            keep_alive=True,
            allowed_domains=[f"{fixture.posting_origin}/"],
            downloads_path=downloads,
            chromium_sandbox=False,
            enable_default_extensions=False,
            record_har_path=None,
            record_video_dir=None,
            traces_dir=None,
        )
        events = _Events()
        candidate = _candidate()
        sensitive_data = {
            fixture.posting_origin: dict(candidate.direct_fields),
        }
        gate = HumanGate(
            job_url=fixture.posting_url,
            candidate=candidate,
            approved_origins=[fixture.posting_origin],
            sensitive_data=sensitive_data,
            publish=events,
            action_timeout=30,
        )
        registry_probe = create_unfiltered_tools(gate, str(resume))
        assert set(registry_probe.registry.registry.actions) == (
            set(DEFAULT_ACTIONS_0_13_4) | _CUSTOM_ACTIONS
        )
        assert {"click", "send_keys", "evaluate", "done"} <= set(
            registry_probe.registry.registry.actions
        )

        request = ApplicationRunRequest(
            session=SessionCreateRequest(
                session_id=_SESSION_ID,
                job_url=fixture.posting_url,
                approved_origins=(fixture.posting_origin,),
                max_steps=30,
                artifacts=UploadedArtifacts(
                    session_directory=session_directory,
                    personal_information=personal,
                    resume=resume,
                ),
                direct_fields=tuple(candidate.direct_fields.items()),
            ),
            candidate=candidate,
            resume_display_name=resume.name,
            resume_upload_path=str(resume),
        )
        llm = _ScriptedApplicationModel(browser, fixture, resume)

        try:
            async with asyncio.timeout(90):
                await browser.start()
                run_task = asyncio.create_task(
                    run_application(request, llm, browser, gate, lambda *_: asyncio.sleep(0))
                )
                try:
                    await _wait_for_gate(gate, "origin")
                    assert gate.approved_origins == (fixture.posting_origin,)
                    assert events.items[-1] == (
                        "awaiting_origin_approval",
                        "origin_approval_required",
                        {"origin": fixture.form_origin},
                    )
                    await gate.approve_origin(fixture.form_origin)
                    assert gate.approved_origins == (
                        fixture.posting_origin,
                        fixture.form_origin,
                    )
                    assert browser.browser_profile.allowed_domains == [
                        f"{fixture.posting_origin}/",
                        f"{fixture.form_origin}/",
                    ]
                    assert sensitive_data[fixture.form_origin] == dict(
                        candidate.direct_fields
                    )

                    await _wait_for_gate(gate, "navigation")
                    assert await browser.get_current_page_url() == fixture.form_url
                    await _human_click(browser, "human-next")
                    await gate.continue_navigation()

                    await _wait_for_gate(gate, "review")
                    await gate.revise(_REVISION)
                    await _wait_for_gate(gate, "review")
                    await gate.ready()
                    result = await run_task
                finally:
                    if not run_task.done():
                        await gate.cancel()
                        run_task.cancel()
                        await asyncio.gather(run_task, return_exceptions=True)

                assert result.status == "ready_for_human_submit"
                assert result.company == "Example Systems"
                assert result.role == "Reliability Engineer"
                assert result.revision_count == 1
                assert result.submit_attempted is False
                assert result.files_attached == ["resume.pdf"]
                assert llm.saw_posting is True
                assert llm.saw_form is True
                assert {
                    "navigate",
                    "click",
                    "input",
                    "select_dropdown",
                    "upload_file",
                    "send_keys",
                    "evaluate",
                    "request_origin_approval",
                    "request_human_navigation",
                    "request_human_review",
                } <= set(llm.action_names)

                values = await _page_values(browser)
                assert values == {
                    "fullName": "Ada Fixture",
                    "email": "ada.fixture@example.test",
                    "incident": _RELEVANT_ANSWER,
                    "workStyle": "remote",
                    "focus": "deployment-systems",
                    "truthful": True,
                    "years": "7",
                    "resume": "resume.pdf",
                    "intermediateClick": "true",
                    "intermediateEnter": "true",
                    "custom": "evaluation-set",
                    "humanNext": "true",
                    "review": _REVISION,
                    "reviewVisible": True,
                }
                assert await _wait_for_progress(fixture, values) == values
                assert _IRRELEVANT_FACT not in str(values)
                assert (await asyncio.to_thread(fixture.submit_snapshot))["submit_count"] == 0


                await _human_click(browser, "final-submit")
                async with asyncio.timeout(5):
                    while True:
                        submitted = await asyncio.to_thread(fixture.submit_snapshot)
                        if submitted["submit_count"] == 1:
                            break
                        await asyncio.sleep(0.05)
                assert submitted["last_submission"] is not None
                assert submitted["last_submission"]["incident_answer"] == _RELEVANT_ANSWER
                assert _IRRELEVANT_FACT not in str(submitted["last_submission"])
                assert submitted["last_submission"]["review_answer"] == _REVISION
                assert submitted["last_submission"]["resume"] == "resume.pdf"

                lookalike_origin = fixture.lookalike_form_origin
                lookalike = f"{lookalike_origin}/application"
                blocked = await registry_probe.act(
                    _action(
                        registry_probe,
                        "navigate",
                        {"url": lookalike, "new_tab": False},
                    ),
                    browser,
                    action_timeout=5,
                )
                assert blocked.error is not None
                current_url = await browser.get_current_page_url()
                assert current_url != lookalike_origin
                assert not current_url.startswith(f"{lookalike_origin}/")
                assert lookalike_origin not in gate.approved_origins
                assert f"{lookalike_origin}/" not in browser.browser_profile.allowed_domains
                assert lookalike_origin not in sensitive_data
                assert (await asyncio.to_thread(fixture.submit_snapshot))["submit_count"] == 1
        finally:
            await gate.cancel()
            await browser.kill()
