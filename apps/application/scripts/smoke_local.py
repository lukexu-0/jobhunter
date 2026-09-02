#!/usr/bin/env python3
"""Headed, live local smoke test for the Browser Harness workflow.

This script intentionally requires a running pipeline, a connected OpenAI Codex
OAuth account, and a running headed browser-harness service. It drives only the
loopback fixture and harness APIs; the explicitly labelled Human Next browser click
remains manual.
"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import os
import sys
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

_BROWSER_HARNESS_ROOT = Path(__file__).resolve().parents[1]
_TESTS_ROOT = _BROWSER_HARNESS_ROOT / "tests"
if str(_TESTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TESTS_ROOT))

from fixtures.local_application import LocalApplicationFixture  # noqa: E402


MODEL_PROVIDER = "openai-codex"
MODEL_NAME = "gpt-5.6-sol"
MODEL_REASONING = "high"
GATEWAY_PATH = "/v1/internal/application-agent"
FULL_NAME = "Ada Smokequill"
EMAIL = "ada.smokequill@example.test"
PROFILE_NARRATIVE = (
    "Synthetic smoke candidate. Use only the attributed evidence supplied with "
    "this local fixture application."
)
RESUME_EVIDENCE = (
    "Ada Smokequill has exactly seven years of reliability engineering experience "
    "operating deployment systems."
)
CONTEXT_EVIDENCE = (
    "For this synthetic fixture, the candidate explicitly prefers Remote work "
    "and confirms that the supplied application answers are truthful."
)
RELEVANT_ANECDOTE = (
    "Quartz rollback incident: during a production deployment incident, the candidate "
    "coordinated a rollback, verified service health, and documented the follow-up."
)
IRRELEVANT_ANECDOTE = (
    "Orchid garden anecdote: the candidate organized an unrelated community garden "
    "fundraiser."
)
REVISION = (
    "For the Review emphasis field, replace its contents with exactly: "
    "Human revision: emphasize careful incident ownership."
)
REVISION_VALUE = "Human revision: emphasize careful incident ownership."
RESUME_NAME = "smoke-resume.pdf"
SUMMER_AVAILABILITY = "June through August 2027"
REFERRAL_SOURCE = "Employee referral"
REVIEW_EMPHASIS_REPLY = "Initial human reply: emphasize production reliability."

REQUEST_TIMEOUT = httpx.Timeout(connect=5.0, read=35.0, write=35.0, pool=5.0)
EVENT_WAIT_SECONDS = 1_800.0
FIXTURE_WAIT_SECONDS = 120.0


class SmokeFailure(RuntimeError):
    """A fixed, operator-actionable smoke assertion failure."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def loopback_base_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise argparse.ArgumentTypeError("URL must be a valid loopback HTTP origin") from error
    hostname = (parsed.hostname or "").rstrip(".").lower()
    try:
        loopback = hostname == "localhost" or ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        loopback = hostname == "localhost"
    if (
        parsed.scheme.lower() != "http"
        or not loopback
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise argparse.ArgumentTypeError(
            "URL must be a loopback HTTP origin with an explicit port and no path"
        )
    host = f"[{hostname}]" if ":" in hostname else hostname
    return f"http://{host}:{port}"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the live headed Browser Harness workflow against the dual-origin "
            "loopback fixture."
        )
    )
    parser.add_argument(
        "--harness-url",
        type=loopback_base_url,
        default="http://127.0.0.1:8765",
        help="running browser-harness loopback origin (default: %(default)s)",
    )
    parser.add_argument(
        "--pipeline-url",
        type=loopback_base_url,
        default="http://127.0.0.1:3457",
        help="running pipeline loopback origin (default: %(default)s)",
    )
    parser.add_argument(
        "--user-info-json",
        type=lambda value: Path(value).expanduser().resolve(),
        default=(Path(tempfile.gettempdir()) / "user-info.json").resolve(),
        help=(
            "private user-info store configured on the running harness "
            "(default: %(default)s)"
        ),
    )
    return parser.parse_args(argv)


def bearer_token() -> str:
    token = os.environ.get("JOBHUNTER_HARNESS_TOKEN")
    if token is None or len(token) < 32:
        raise SmokeFailure(
            "Set JOBHUNTER_HARNESS_TOKEN to the same value used by pipeline and harness (minimum 32 characters)"
        )
    return token


def make_pdf(text: str) -> bytes:
    require(text.isascii(), "Synthetic resume text must remain ASCII for deterministic PDF generation")
    destination = BytesIO()
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
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
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    contents = DecodedStreamObject()
    contents.set_data(f"BT /F1 11 Tf 54 720 Td ({escaped}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(contents)
    writer.write(destination)
    return destination.getvalue()


def create_inputs(root: Path) -> dict[str, Path]:
    profile = root / "smoke-profile.md"
    resume = root / RESUME_NAME
    resume_source = root / "Alex_Example_Resume.tex"
    context = root / "smoke-context.md"
    relevant = root / "quartz-incident.md"
    irrelevant = root / "orchid-garden.md"
    profile.write_text(
        "---\n"
        f'full_name: "{FULL_NAME}"\n'
        f'email: "{EMAIL}"\n'
        "---\n\n"
        f"{PROFILE_NARRATIVE}\n",
        encoding="utf-8",
    )
    resume.write_bytes(make_pdf(RESUME_EVIDENCE))
    resume_source.write_text(
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        f"{RESUME_EVIDENCE}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    context.write_text(f"# Synthetic application context\n\n{CONTEXT_EVIDENCE}\n", encoding="utf-8")
    relevant.write_text(f"# Relevant incident\n\n{RELEVANT_ANECDOTE}\n", encoding="utf-8")
    irrelevant.write_text(f"# Unrelated anecdote\n\n{IRRELEVANT_ANECDOTE}\n", encoding="utf-8")
    return {
        "profile": profile,
        "resume": resume,
        "resume_source": resume_source,
        "context": context,
        "relevant": relevant,
        "irrelevant": irrelevant,
    }


def multipart(inputs: dict[str, Path]) -> list[tuple[str, tuple[str, bytes, str]]]:
    return [
        (
            "personal_information",
            (inputs["profile"].name, inputs["profile"].read_bytes(), "text/markdown"),
        ),
        ("resume", (inputs["resume"].name, inputs["resume"].read_bytes(), "application/pdf")),
        (
            "resume_source",
            (
                inputs["resume_source"].name,
                inputs["resume_source"].read_bytes(),
                "text/x-tex",
            ),
        ),
        ("context", (inputs["context"].name, inputs["context"].read_bytes(), "text/markdown")),
        (
            "anecdote",
            (inputs["relevant"].name, inputs["relevant"].read_bytes(), "text/markdown"),
        ),
        (
            "anecdote",
            (inputs["irrelevant"].name, inputs["irrelevant"].read_bytes(), "text/markdown"),
        ),
    ]


class Capture:
    def __init__(self) -> None:
        self.bodies: list[str] = []

    def response(self, response: httpx.Response) -> None:
        self.bodies.append(response.content.decode("utf-8", errors="replace"))

    def sse(self, frame: str) -> None:
        self.bodies.append(frame)

    def json(self, response: httpx.Response, failure: str) -> Any:
        self.response(response)
        try:
            return response.json()
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            raise SmokeFailure(failure) from error


def require_status(response: httpx.Response, status: int, message: str) -> None:
    require(response.status_code == status, message)


class EventStream:
    def __init__(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers: dict[str, str],
        capture: Capture,
    ) -> None:
        self._client = client
        self._url = url
        self._headers = headers
        self._capture = capture
        self._condition = asyncio.Condition()
        self.events: list[dict[str, Any]] = []
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        require(self._task is None, "SSE stream was started twice")
        self._task = asyncio.create_task(self._run(), name="browser-harness-smoke-sse")

    async def _run(self) -> None:
        while True:
            headers = dict(self._headers)
            if self.events:
                headers["Last-Event-ID"] = str(self.events[-1]["id"])
            async with self._client.stream("GET", self._url, headers=headers) as response:
                if response.status_code != 200:
                    await response.aread()
                    self._capture.response(response)
                    raise SmokeFailure("Harness SSE endpoint did not return 200")
                event_name: str | None = None
                event_id: str | None = None
                data_lines: list[str] = []
                frame_lines: list[str] = []
                async for line in response.aiter_lines():
                    if line == "":
                        if frame_lines:
                            self._capture.sse("\n".join(frame_lines) + "\n\n")
                        if data_lines:
                            try:
                                payload = json.loads("\n".join(data_lines))
                            except (json.JSONDecodeError, ValueError) as error:
                                raise SmokeFailure(
                                    "Harness SSE emitted invalid JSON data"
                                ) from error
                            require(
                                isinstance(payload, dict),
                                "Harness SSE data was not a JSON object",
                            )
                            require(
                                payload.get("event") == event_name,
                                "Harness SSE event name disagreed with its data",
                            )
                            require(
                                str(payload.get("id")) == event_id,
                                "Harness SSE event id disagreed with its data",
                            )
                            async with self._condition:
                                if self.events:
                                    require(
                                        isinstance(payload.get("id"), int)
                                        and payload["id"] > self.events[-1]["id"],
                                        "Harness SSE event ids were not strictly monotonic",
                                    )
                                self.events.append(payload)
                                self._condition.notify_all()
                        event_name = None
                        event_id = None
                        data_lines = []
                        frame_lines = []
                        continue
                    if line.startswith(":"):
                        continue
                    frame_lines.append(line)
                    field, _, value = line.partition(":")
                    value = value[1:] if value.startswith(" ") else value
                    if field == "event":
                        event_name = value
                    elif field == "id":
                        event_id = value
                    elif field == "data":
                        data_lines.append(value)
            await asyncio.sleep(0.1)

    async def wait_for(
        self,
        event_name: str,
        *,
        after_id: int = 0,
        timeout: float = EVENT_WAIT_SECONDS,
    ) -> dict[str, Any]:
        async def wait() -> dict[str, Any]:
            while True:
                async with self._condition:
                    for event in self.events:
                        if event.get("id", 0) > after_id and event.get("event") == event_name:
                            return event
                    failed = next(
                        (
                            event
                            for event in self.events
                            if event.get("id", 0) > after_id and event.get("event") == "failed"
                        ),
                        None,
                    )
                    if failed is not None and event_name != "failed":
                        session = failed.get("session")
                        public_error = session.get("error") if isinstance(session, dict) else None
                        raise SmokeFailure(
                            "Harness session failed before the expected workflow gate: "
                            f"{json.dumps(public_error, sort_keys=True)}"
                        )
                    terminal = next(
                        (
                            event
                            for event in self.events
                            if event.get("id", 0) > after_id
                            and event.get("event") in {"cancelled", "closed"}
                            and event.get("event") != event_name
                        ),
                        None,
                    )
                    if terminal is not None:
                        raise SmokeFailure(
                            "Harness session ended before the expected workflow gate: "
                            f"{terminal.get('event')}"
                        )
                    task = self._task
                    require(task is not None, "Harness SSE task was not started")
                    if task.done():
                        if task.cancelled():
                            raise SmokeFailure("Harness SSE stream stopped before the expected event")
                        error = task.exception()
                        if error is not None:
                            if isinstance(error, SmokeFailure):
                                raise error
                            raise SmokeFailure("Harness SSE stream failed before the expected event") from None
                        raise SmokeFailure("Harness SSE stream ended before the expected event")
                    try:
                        await asyncio.wait_for(self._condition.wait(), timeout=0.5)
                    except TimeoutError:
                        pass

        try:
            async with asyncio.timeout(timeout):
                return await wait()
        except TimeoutError:
            raise SmokeFailure(f"Timed out waiting for harness event: {event_name}") from None

    async def wait_for_one_of(
        self,
        event_names: tuple[str, ...],
        *,
        after_id: int = 0,
    ) -> dict[str, Any]:
        tasks = [
            asyncio.create_task(self.wait_for(name, after_id=after_id))
            for name in event_names
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        return next(iter(done)).result()

    async def close(self) -> None:
        if self._task is None:
            return
        if not self._task.done():
            self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)


def response_json_object(capture: Capture, response: httpx.Response, failure: str) -> dict[str, Any]:
    payload = capture.json(response, failure)
    require(isinstance(payload, dict), failure)
    return payload


async def post_command(
    client: httpx.AsyncClient,
    capture: Capture,
    url: str,
    headers: dict[str, str],
    command: dict[str, Any],
    failure: str,
) -> None:
    response = await client.post(url, headers=headers, json=command)
    capture.response(response)
    require_status(response, 202, failure)
    require(response.content == b"", "Harness command response unexpectedly contained a body")


async def create_session(
    client: httpx.AsyncClient,
    capture: Capture,
    harness_url: str,
    headers: dict[str, str],
    fixture: LocalApplicationFixture,
    inputs: dict[str, Path],
) -> tuple[httpx.Response, dict[str, Any]]:
    response = await client.post(
        f"{harness_url}/v1/sessions",
        headers=headers,
        data={"job_url": fixture.posting_url, "opportunity_kind": "job"},
        files=multipart(inputs),
    )
    payload = response_json_object(capture, response, "Harness session create response was not JSON")
    return response, payload


def read_user_info(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"Configured user-info store is unavailable: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SmokeFailure("Configured user-info store is not valid UTF-8 JSON") from error
    require(isinstance(value, dict), "Configured user-info store was not a JSON object")
    return value


def assert_empty_user_info(path: Path) -> None:
    require(
        read_user_info(path) == {"version": 2, "global": {}, "applications": {}},
        "Smoke requires a fresh empty user-info store",
    )


def assert_saved_user_info(
    path: Path,
    job_url: str,
    global_fact_key: str,
    application_fact_key: str,
    review_fact_key: str | None = None,
) -> None:
    document = read_user_info(path)
    require(set(document) == {"version", "global", "applications"}, "User-info document shape changed")
    require(document.get("version") == 2, "User-info document version changed")
    global_facts = document.get("global")
    applications = document.get("applications")
    require(
        isinstance(global_facts, dict) and set(global_facts) == {global_fact_key},
        "User-info store did not contain exactly the expected global fact",
    )
    require(
        isinstance(applications, dict) and set(applications) == {job_url},
        "User-info store contained a cross-application bucket",
    )
    application_facts = applications[job_url]
    expected_application_keys = {application_fact_key}
    if review_fact_key is not None:
        expected_application_keys.add(review_fact_key)
    require(
        isinstance(application_facts, dict)
        and set(application_facts) == expected_application_keys,
        "User-info store did not contain exactly the expected application facts",
    )
    expected_records = [
        (global_facts[global_fact_key], "text", SUMMER_AVAILABILITY),
        (application_facts[application_fact_key], "single_select", REFERRAL_SOURCE),
    ]
    if review_fact_key is not None:
        expected_records.append(
            (application_facts[review_fact_key], "text", REVIEW_EMPHASIS_REPLY)
        )
    for record, answer_type, expected_value in expected_records:
        require(isinstance(record, dict), "User-info fact was not an object")
        common_fields = {"answer_type", "status", "question", "updated_at"}
        expected_fields = (
            common_fields | {"raw_value", "sanitized_value"}
            if answer_type == "text"
            else common_fields | {"value"}
        )
        require(set(record) == expected_fields, "User-info fact shape changed")
        require(record.get("answer_type") == answer_type, "User-info fact answer type changed")
        require(record.get("status") == "answered", "User-info fact was not answered")
        if answer_type == "text":
            require(record.get("raw_value") == expected_value, "User-info fact persisted the wrong raw value")
            require(record.get("sanitized_value") == expected_value, "User-info fact persisted the wrong final value")
        else:
            require(record.get("value") == expected_value, "User-info fact persisted the wrong value")
        require(
            isinstance(record.get("question"), str) and bool(record["question"].strip()),
            "User-info fact omitted its source question",
        )
        require(
            isinstance(record.get("updated_at"), str) and bool(record["updated_at"]),
            "User-info fact omitted its update timestamp",
        )


def additional_info_command(
    event: dict[str, Any],
) -> tuple[dict[str, Any], str, str]:
    detail = event.get("detail")
    require(isinstance(detail, dict), "Additional-information event omitted its detail")
    questions = detail.get("questions")
    require(
        isinstance(questions, list) and len(questions) == 2,
        "Agent did not ask exactly the two fixture questions in one batch",
    )
    require(
        all(isinstance(question, dict) for question in questions),
        "Additional-information event contained an invalid question",
    )
    global_questions = [
        question
        for question in questions
        if question.get("scope") == "global"
        and question.get("answer_type") == "text"
    ]
    require(
        len(global_questions) == 1,
        "Agent requested the global fixture fact with the wrong shape",
    )
    global_question = global_questions[0]
    global_id = global_question.get("id")
    global_key = global_question.get("key")
    global_prompt = global_question.get("question")
    require(
        all(
            isinstance(value, str) and bool(value.strip())
            for value in (global_id, global_key, global_prompt)
        ),
        "Agent omitted global fixture question metadata",
    )
    normalized_global_prompt = global_prompt.casefold()
    require(
        "summer" in normalized_global_prompt
        and any(
            token in normalized_global_prompt
            for token in ("availab", "date", "when", "work")
        ),
        "Agent did not ask for the unknown summer availability",
    )
    application_questions = [
        question
        for question in questions
        if question.get("scope") == "application"
        and question.get("answer_type") == "single_select"
    ]
    require(
        len(application_questions) == 1,
        "Agent requested the application fixture fact with the wrong shape",
    )
    application_question = application_questions[0]
    application_id = application_question.get("id")
    application_key = application_question.get("key")
    application_prompt = application_question.get("question")
    require(
        all(
            isinstance(value, str) and bool(value.strip())
            for value in (application_id, application_key, application_prompt)
        ),
        "Agent omitted application fixture question metadata",
    )
    normalized_application_prompt = application_prompt.casefold()
    require(
        any(
            token in normalized_application_prompt
            for token in ("hear", "learn", "referr", "source", "find", "found", "discover")
        ),
        "Agent did not ask for the unknown referral source",
    )
    require(
        global_id != application_id,
        "Agent reused candidate-question IDs",
    )
    options = application_question.get("options")
    require(
        isinstance(options, list)
        and all(isinstance(option, dict) for option in options)
        and {option.get("label") for option in options}
        == {REFERRAL_SOURCE, "Job board"},
        "Agent did not provide the exact bounded referral-source options",
    )
    selected = next(
        (
            option
            for option in options
            if isinstance(option, dict) and option.get("label") == REFERRAL_SOURCE
        ),
        None,
    )
    require(
        isinstance(selected, dict)
        and isinstance(selected.get("id"), str)
        and bool(selected["id"].strip())
        and all(
            isinstance(option.get("id"), str) and bool(option["id"].strip())
            for option in options
        )
        and len({option["id"] for option in options}) == len(options),
        "Agent omitted unique referral-source option identifiers",
    )
    command = {
        "type": "provide_additional_info",
        "answers": [
            {
                "id": global_id,
                "status": "answered",
                "raw_value": SUMMER_AVAILABILITY,
                "value": SUMMER_AVAILABILITY,
            },
            {
                "id": application_id,
                "status": "answered",
                "option_id": selected["id"],
            },
        ],
    }
    return command, global_key, application_key


def review_emphasis_command(event: dict[str, Any]) -> tuple[dict[str, Any], str]:
    detail = event.get("detail")
    require(isinstance(detail, dict), "Review-emphasis event omitted its detail")
    questions = detail.get("questions")
    require(
        isinstance(questions, list)
        and len(questions) == 1
        and isinstance(questions[0], dict),
        "Agent did not ask exactly one late-discovered review-emphasis question",
    )
    question = questions[0]
    question_id = question.get("id")
    fact_key = question.get("key")
    prompt = question.get("question")
    require(
        question.get("scope") == "application"
        and question.get("answer_type") == "text"
        and all(
            isinstance(value, str) and bool(value.strip())
            for value in (question_id, fact_key, prompt)
        ),
        "Agent requested the review-emphasis fact with the wrong shape",
    )
    normalized_prompt = prompt.casefold()
    require(
        "review" in normalized_prompt and "emphasis" in normalized_prompt,
        "Agent did not identify the late-discovered review-emphasis question",
    )
    return (
        {
            "type": "provide_additional_info",
            "answers": [
                {
                    "id": question_id,
                    "status": "answered",
                    "raw_value": REVIEW_EMPHASIS_REPLY,
                    "value": REVIEW_EMPHASIS_REPLY,
                }
            ],
        },
        fact_key,
    )


async def wait_fixture_values(
    fixture: LocalApplicationFixture,
    expected: dict[str, Any],
    failure: str,
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + FIXTURE_WAIT_SECONDS
    latest_progress: dict[str, Any] = {}
    while asyncio.get_running_loop().time() < deadline:
        snapshot = await asyncio.to_thread(fixture.progress_snapshot)
        progress = snapshot.get("progress")
        if isinstance(progress, dict):
            latest_progress = progress
        if isinstance(progress, dict) and all(
            progress.get(key) == value for key, value in expected.items()
        ):
            return progress
        await asyncio.sleep(0.1)
    mismatched = sorted(
        key for key, value in expected.items() if latest_progress.get(key) != value
    )
    raise SmokeFailure(f"{failure}; mismatched fields: {', '.join(mismatched)}")




def assert_subsequence(actual: list[str], expected: list[str]) -> None:
    cursor = 0
    for value in actual:
        if cursor < len(expected) and value == expected[cursor]:
            cursor += 1
    require(cursor == len(expected), "Harness events did not follow the required gate/revision/submission sequence")


def assert_snapshot(
    snapshot: dict[str, Any],
    session_id: str,
    fixture: LocalApplicationFixture,
) -> None:
    require(snapshot.get("session_id") == session_id, "Final snapshot returned the wrong session id")
    require(snapshot.get("state") == "submitted", "Session did not reach submitted")
    require(snapshot.get("model_provider") == MODEL_PROVIDER, "Snapshot used the wrong provider")
    require(snapshot.get("model") == MODEL_NAME, "Snapshot used the wrong model")
    require(snapshot.get("reasoning") == MODEL_REASONING, "Snapshot used the wrong reasoning level")
    require(snapshot.get("company") == "Example Systems", "Snapshot did not identify the fixture company")
    require(snapshot.get("role") == "Reliability Engineer", "Snapshot did not identify the fixture role")
    require(snapshot.get("revision_count") == 1, "Snapshot did not record exactly one revision")
    require(
        snapshot.get("approved_origins") == [fixture.posting_origin, fixture.form_origin],
        "Snapshot did not retain the exact posting and dynamically approved form origins",
    )
    require(snapshot.get("files_attached") == ["resume.pdf"], "Snapshot did not record the sanitized resume")
    require(snapshot.get("fields_needing_human") == [], "Snapshot still reported fields needing human input")
    fields = snapshot.get("fields_filled")
    require(isinstance(fields, list) and len(fields) >= 12, "Snapshot did not report all fixture fields")
    require(
        all(
            isinstance(field, dict)
            and field.get("value_present") is True
            and isinstance(field.get("label"), str)
            and bool(field["label"].strip())
            for field in fields
        ),
        "Snapshot field metadata was incomplete or exposed an unfilled field",
    )
    require(
        {"text", "textarea", "select", "radio", "checkbox", "number", "file", "unknown"}
        <= {field.get("field_type") for field in fields},
        "Snapshot did not cover every fixture field type",
    )
    require(snapshot.get("error") is None, "Submitted snapshot unexpectedly contained an error")


async def wait_fixture_progress(fixture: LocalApplicationFixture) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + FIXTURE_WAIT_SECONDS
    while asyncio.get_running_loop().time() < deadline:
        snapshot = await asyncio.to_thread(fixture.progress_snapshot)
        progress = snapshot.get("progress")
        if isinstance(progress, dict) and progress.get("review") == REVISION_VALUE:
            return progress
        await asyncio.sleep(0.1)
    raise SmokeFailure("Fixture progress did not reflect the same-run revision")


def assert_fixture_progress(progress: dict[str, Any]) -> None:
    require(progress.get("fullName") == FULL_NAME, "Fixture full name did not come from explicit profile data")
    require(progress.get("email") == EMAIL, "Fixture email did not come from explicit profile data")
    incident = progress.get("incident")
    require(isinstance(incident, str) and bool(incident.strip()), "Fixture incident answer was empty")
    incident_lower = incident.lower()
    require(
        "rollback" in incident_lower and "service health" in incident_lower,
        "Fixture incident answer did not use the JD-relevant Quartz incident evidence",
    )
    require(
        "orchid" not in incident_lower and "community garden" not in incident_lower and "fundraiser" not in incident_lower,
        "Fixture incident answer imported facts from the irrelevant anecdote",
    )
    expected = {
        "workStyle": "remote",
        "focus": "deployment-systems",
        "truthful": True,
        "years": "7",
        "summerAvailability": SUMMER_AVAILABILITY,
        "referralSource": REFERRAL_SOURCE,
        "resume": RESUME_NAME,
        "intermediateClick": "true",
        "intermediateEnter": "true",
        "custom": "evaluation-set",
        "humanNext": "true",
        "review": REVISION_VALUE,
        "reviewVisible": True,
    }
    for key, value in expected.items():
        require(progress.get(key) == value, f"Fixture progress check failed for {key}")


async def wait_for_one_submit(fixture: LocalApplicationFixture) -> None:
    deadline = asyncio.get_running_loop().time() + FIXTURE_WAIT_SECONDS
    while asyncio.get_running_loop().time() < deadline:
        snapshot = await asyncio.to_thread(fixture.submit_snapshot)
        count = snapshot.get("submit_count")
        require(isinstance(count, int), "Fixture submit counter returned invalid data")
        require(count <= 1, "Fixture recorded more than one final submission")
        if count == 1:
            submission = snapshot.get("last_submission")
            require(isinstance(submission, dict), "Fixture did not retain the single submission")
            require(submission.get("full_name") == FULL_NAME, "Submitted fixture name changed after approval")
            require(submission.get("email") == EMAIL, "Submitted fixture email changed after approval")
            require(submission.get("review_answer") == REVISION_VALUE, "Submitted fixture revision changed after approval")
            require(
                submission.get("summer_availability") == SUMMER_AVAILABILITY,
                "Submitted fixture global answer changed after approval",
            )
            require(
                submission.get("referral_source") == REFERRAL_SOURCE,
                "Submitted fixture application answer changed after approval",
            )
            require(submission.get("resume") == RESUME_NAME, "Submitted fixture resume changed after approval")
            serialized = json.dumps(submission, sort_keys=True).lower()
            require(
                "orchid" not in serialized and "community garden" not in serialized and "fundraiser" not in serialized,
                "Final fixture submission imported the irrelevant anecdote",
            )
            return
        await asyncio.sleep(0.1)
    raise SmokeFailure("Timed out waiting for the agent's one final submission")


def inspect_json_privacy(value: Any) -> None:
    if isinstance(value, dict):
        forbidden_keys = {
            "access_token",
            "refresh_token",
            "id_token",
            "oauth_token",
            "provider_error",
            "provider_error_body",
            "reasoning_summary",
            "reasoningsummary",
        }
        for key, child in value.items():
            require(key.lower() not in forbidden_keys, "Captured API data contained a forbidden private field")
            if key.lower() == "error":
                require(child is None, "Captured API/SSE data contained a non-null provider or session error")
            if key.lower() == "reasoning":
                require(child == MODEL_REASONING, "Captured API/SSE data contained a reasoning summary")
            inspect_json_privacy(child)
    elif isinstance(value, list):
        for child in value:
            inspect_json_privacy(child)


def privacy_scan(capture: Capture, token: str) -> None:
    corpus = "\n".join(capture.bodies)
    forbidden_values = (
        token,
        FULL_NAME,
        EMAIL,
        PROFILE_NARRATIVE,
        RESUME_EVIDENCE,
        CONTEXT_EVIDENCE,
        RELEVANT_ANECDOTE,
        IRRELEVANT_ANECDOTE,
        REVISION,
        REVISION_VALUE,
        SUMMER_AVAILABILITY,
        REVIEW_EMPHASIS_REPLY,
    )
    for value in forbidden_values:
        require(value not in corpus, "Captured API/SSE data failed the privacy scan")
    lowered = corpus.lower()
    for marker in (
        "authorization: bearer",
        '"access_token"',
        '"refresh_token"',
        '"id_token"',
        '"provider_error"',
        '"provider_error_body"',
        '"reasoning_summary"',
        '"reasoningsummary"',
        "<secret>",
        "attributed candidate evidence",
    ):
        require(marker not in lowered, "Captured API/SSE data contained forbidden private metadata")
    for body in capture.bodies:
        stripped = body.strip()
        if not stripped:
            continue
        candidates = [line[6:] for line in stripped.splitlines() if line.startswith("data: ")]
        if not candidates and stripped.startswith(("{", "[")):
            candidates = [stripped]
        for candidate in candidates:
            try:
                inspect_json_privacy(json.loads(candidate))
            except json.JSONDecodeError:
                continue


async def workflow(args: argparse.Namespace, token: str, capture: Capture) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    active_session_id: str | None = None
    capacity_session_ids: list[str] = []
    event_stream: EventStream | None = None
    fixture: LocalApplicationFixture | None = None
    client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=False)

    with tempfile.TemporaryDirectory(prefix="jobhunter-browser-harness-smoke-") as temporary:
        inputs = create_inputs(Path(temporary))
        try:
            fixture = LocalApplicationFixture().start()

            unauthenticated = await client.get(f"{args.harness_url}/v1/sessions/{uuid4()}")
            unauthenticated_body = response_json_object(
                capture,
                unauthenticated,
                "Unauthenticated harness response was not JSON",
            )
            require_status(unauthenticated, 401, "Harness did not reject an unauthenticated /v1 request with 401")
            require(
                unauthenticated_body == {"code": "unauthorized", "message": "Unauthorized"},
                "Harness unauthenticated response was not the fixed undifferentiated error",
            )

            status_response = await client.get(
                f"{args.pipeline_url}{GATEWAY_PATH}",
                headers=headers,
            )
            status = response_json_object(capture, status_response, "Pipeline status response was not JSON")
            require_status(status_response, 200, "Pipeline model status was not ready; connect OpenAI Codex in Provider access")
            require(
                status
                == {
                    "modelProvider": MODEL_PROVIDER,
                    "model": MODEL_NAME,
                    "reasoning": MODEL_REASONING,
                    "oauth": "connected",
                },
                "Pipeline model status metadata was not exact",
            )
            assert_empty_user_info(args.user_info_json)


            create_response, created = await create_session(
                client, capture, args.harness_url, headers, fixture, inputs
            )
            require_status(create_response, 202, "Harness did not accept the multipart session")
            require(created.get("state") == "starting", "Harness create response did not report starting")
            try:
                active_session_id = str(UUID(str(created.get("session_id"))))
            except (ValueError, TypeError, AttributeError):
                raise SmokeFailure("Harness create response did not contain a UUID session id") from None
            expected_base = f"/v1/sessions/{active_session_id}"
            events_url = created.get("events_url")
            commands_url = created.get("commands_url")
            require(isinstance(events_url, str), "Harness create response omitted events_url")
            require(isinstance(commands_url, str), "Harness create response omitted commands_url")
            require(urlsplit(events_url).path == f"{expected_base}/events", "Harness returned the wrong events_url")
            require(urlsplit(commands_url).path == f"{expected_base}/commands", "Harness returned the wrong commands_url")
            require(loopback_base_url(f"{urlsplit(events_url).scheme}://{urlsplit(events_url).netloc}"), "Harness events_url was not loopback")
            require(loopback_base_url(f"{urlsplit(commands_url).scheme}://{urlsplit(commands_url).netloc}"), "Harness commands_url was not loopback")

            event_stream = EventStream(client, events_url, headers, capture)
            event_stream.start()

            for _ in range(2):
                capacity_response, capacity = await create_session(
                    client, capture, args.harness_url, headers, fixture, inputs
                )
                require_status(
                    capacity_response,
                    202,
                    "Harness did not admit all three application sessions",
                )
                try:
                    capacity_session_ids.append(
                        str(UUID(str(capacity.get("session_id"))))
                    )
                except (ValueError, TypeError, AttributeError):
                    raise SmokeFailure(
                        "Harness capacity response did not contain a UUID session id"
                    ) from None

            concurrent_response, concurrent = await create_session(
                client, capture, args.harness_url, headers, fixture, inputs
            )
            require_status(
                concurrent_response, 409, "Fourth concurrent session create did not return 409"
            )
            require(
                concurrent.get("code") == "session_active"
                and concurrent.get("session_id")
                in {active_session_id, *capacity_session_ids},
                "Fourth concurrent session create did not identify an occupying session",
            )
            for capacity_session_id in capacity_session_ids:
                capacity_delete = await client.delete(
                    f"{args.harness_url}/v1/sessions/{capacity_session_id}",
                    headers=headers,
                )
                capture.response(capacity_delete)
                require_status(
                    capacity_delete, 204, "Capacity probe session DELETE failed"
                )
            capacity_session_ids.clear()

            started = await event_stream.wait_for("session_started")
            additional_info = await event_stream.wait_for(
                "additional_info_required", after_id=int(started["id"])
            )
            require(
                fixture.form_origin
                in additional_info.get("session", {}).get("approved_origins", []),
                "Harness did not automatically register the exact fixture form origin",
            )
            initial_progress = await wait_fixture_values(
                fixture,
                {
                    "fullName": FULL_NAME,
                    "email": EMAIL,
                    "workStyle": "remote",
                    "focus": "deployment-systems",
                    "truthful": True,
                    "years": "7",
                    "resume": RESUME_NAME,
                    "summerAvailability": "",
                    "referralSource": "",
                },
                "Agent requested additional information before filling fields supported by initial data",
            )
            initial_incident = initial_progress.get("incident")
            require(
                isinstance(initial_incident, str)
                and "rollback" in initial_incident.lower()
                and "service health" in initial_incident.lower(),
                "Agent requested additional information before applying initial incident evidence",
            )
            info_command, global_fact_key, application_fact_key = (
                additional_info_command(additional_info)
            )
            await post_command(
                client,
                capture,
                commands_url,
                headers,
                info_command,
                "Harness rejected the complete additional-information batch",
            )
            saved_info = await event_stream.wait_for(
                "additional_info_saved", after_id=int(additional_info["id"])
            )
            require(
                saved_info.get("detail") == {"count": 2},
                "Harness did not report both saved information answers",
            )
            assert_saved_user_info(
                args.user_info_json,
                fixture.posting_url,
                global_fact_key,
                application_fact_key,
            )

            navigation = await event_stream.wait_for(
                "human_navigation_required", after_id=int(saved_info["id"])
            )
            await wait_fixture_values(
                fixture,
                {
                    "summerAvailability": SUMMER_AVAILABILITY,
                    "referralSource": REFERRAL_SOURCE,
                    "intermediateClick": "true",
                    "intermediateEnter": "true",
                    "custom": "evaluation-set",
                    "humanNext": "",
                    "reviewVisible": False,
                },
                "Agent did not apply the accepted answers and complete every machine-actionable control",
            )
            before_navigation_submit = await asyncio.to_thread(fixture.submit_snapshot)
            require(
                before_navigation_submit.get("submit_count") == 0,
                "Agent submitted while applying additional information",
            )
            print('In headed Chrome, click "Human Next" on the fixture, then press Enter here.')
            await asyncio.to_thread(input)
            await post_command(
                client,
                capture,
                commands_url,
                headers,
                {"type": "continue"},
                "Harness rejected continue after the manual Human Next click",
            )

            post_navigation_info = await event_stream.wait_for(
                "additional_info_required",
                after_id=int(navigation["id"]),
            )
            review_info_command, review_fact_key = review_emphasis_command(
                post_navigation_info
            )
            await post_command(
                client,
                capture,
                commands_url,
                headers,
                review_info_command,
                "Harness rejected the late-discovered review-emphasis answer",
            )
            review_info_saved = await event_stream.wait_for(
                "additional_info_saved", after_id=int(post_navigation_info["id"])
            )
            require(
                review_info_saved.get("detail") == {"count": 1},
                "Harness did not report the saved review-emphasis answer",
            )
            first_review = await event_stream.wait_for(
                "review_required", after_id=int(review_info_saved["id"])
            )
            await post_command(
                client,
                capture,
                commands_url,
                headers,
                {"type": "revise", "context": REVISION},
                "Harness rejected the one same-run revision",
            )
            revision = await event_stream.wait_for(
                "revision_applied", after_id=int(first_review["id"])
            )
            require(
                revision.get("detail") == {"revision_count": 1},
                "Harness did not report revision_count 1",
            )
            second_review = await event_stream.wait_for(
                "review_required", after_id=int(revision["id"])
            )
            progress = await wait_fixture_progress(fixture)
            assert_fixture_progress(progress)
            before_submit = await asyncio.to_thread(fixture.submit_snapshot)
            require(
                before_submit.get("submit_count") == 0,
                "Configured workflow submitted before final human approval",
            )
            require(
                before_submit.get("last_submission") is None,
                "Fixture retained a submission before final human approval",
            )

            await post_command(
                client,
                capture,
                commands_url,
                headers,
                {"type": "submit"},
                "Harness rejected submit approval on the second review",
            )
            submission_started = await event_stream.wait_for(
                "submission_started", after_id=int(second_review["id"])
            )
            submitted = await event_stream.wait_for_one_of(
                ("application_submitted", "submission_uncertain"),
                after_id=int(submission_started["id"]),
            )
            if submitted.get("event") != "application_submitted":
                print(
                    "Agent submission became uncertain. Inspect headed Chrome, "
                    "then press Enter here to close the smoke session."
                )
                try:
                    await asyncio.to_thread(input)
                except (KeyboardInterrupt, EOFError):
                    raise SmokeFailure(
                        "Agent submission became uncertain; browser inspection was interrupted"
                    ) from None
                raise SmokeFailure("Agent submission became uncertain")
            await wait_for_one_submit(fixture)

            event_names = [event["event"] for event in event_stream.events]
            assert_subsequence(
                event_names,
                [
                    "session_started",
                    "additional_info_required",
                    "additional_info_saved",
                    "human_navigation_required",
                    "review_required",
                    "revision_applied",
                    "review_required",
                    "submission_started",
                    "application_submitted",
                ],
            )
            require(
                "origin_approval_required" not in event_names,
                "Harness unexpectedly paused for manual origin approval",
            )
            expected_states = {
                "session_started": "running",
                "additional_info_required": "awaiting_additional_info",
                "additional_info_saved": "running",
                "human_navigation_required": "awaiting_human_navigation",
                "review_required": "awaiting_human_review",
                "revision_applied": "running",
                "submission_started": "submitting",
                "application_submitted": "submitted",
            }
            for event in event_stream.events:
                expected_state = expected_states.get(event.get("event"))
                if expected_state is not None:
                    require(
                        event.get("session", {}).get("state") == expected_state,
                        "Harness event carried the wrong session state",
                    )

            snapshot_response = await client.get(
                f"{args.harness_url}/v1/sessions/{active_session_id}", headers=headers
            )
            snapshot = response_json_object(capture, snapshot_response, "Final snapshot was not JSON")
            require_status(snapshot_response, 200, "Final session snapshot was unavailable")
            assert_snapshot(snapshot, active_session_id, fixture)
            require(
                submitted.get("session") == snapshot,
                "Submitted SSE snapshot disagreed with the GET snapshot",
            )

            delete_response = await client.delete(
                f"{args.harness_url}/v1/sessions/{active_session_id}", headers=headers
            )
            capture.response(delete_response)
            require_status(delete_response, 204, "DELETE did not close and clean the submitted session")
            require(delete_response.content == b"", "DELETE 204 unexpectedly contained a body")
            await event_stream.wait_for("closed", after_id=int(submitted["id"]), timeout=60)

            closed_response = await client.get(
                f"{args.harness_url}/v1/sessions/{active_session_id}", headers=headers
            )
            closed = response_json_object(capture, closed_response, "Closed snapshot was not JSON")
            require_status(closed_response, 200, "Closed session tombstone was unavailable")
            require(closed.get("state") == "closed", "DELETE did not publish a closed tombstone")
            require(closed.get("error") is None, "Closed tombstone unexpectedly retained an error")
            active_session_id = None
            await event_stream.close()
            event_stream = None

            followup_create_response, followup_created = await create_session(
                client, capture, args.harness_url, headers, fixture, inputs
            )
            require_status(
                followup_create_response,
                202,
                "A fresh session could not start after ordered cleanup released capacity",
            )
            try:
                followup_session_id = str(UUID(str(followup_created.get("session_id"))))
            except (ValueError, TypeError, AttributeError):
                raise SmokeFailure("Follow-up create returned an invalid session id") from None
            active_session_id = followup_session_id
            followup_events_url = followup_created.get("events_url")
            require(
                isinstance(followup_events_url, str),
                "Follow-up create omitted its events URL",
            )
            event_stream = EventStream(client, followup_events_url, headers, capture)
            event_stream.start()
            followup_started = await event_stream.wait_for("session_started")
            followup_gate = await event_stream.wait_for_one_of(
                ("human_navigation_required", "additional_info_required"),
                after_id=int(followup_started["id"]),
            )
            require(
                followup_gate.get("event") == "human_navigation_required",
                "Follow-up session repeated an already answered information gate",
            )
            await wait_fixture_values(
                fixture,
                {
                    "fullName": FULL_NAME,
                    "email": EMAIL,
                    "summerAvailability": SUMMER_AVAILABILITY,
                    "referralSource": REFERRAL_SOURCE,
                    "humanNext": "",
                    "reviewVisible": False,
                },
                "Follow-up session did not apply both scoped saved facts",
            )
            require(
                "additional_info_required"
                not in [event.get("event") for event in event_stream.events],
                "Follow-up event history contained a repeated information gate",
            )
            assert_saved_user_info(
                args.user_info_json,
                fixture.posting_url,
                global_fact_key,
                application_fact_key,
                review_fact_key,
            )

            followup_delete = await client.delete(
                f"{args.harness_url}/v1/sessions/{followup_session_id}", headers=headers
            )
            capture.response(followup_delete)
            require_status(followup_delete, 204, "Follow-up session DELETE failed")
            require(followup_delete.content == b"", "Follow-up DELETE 204 unexpectedly contained a body")
            await event_stream.wait_for(
                "closed", after_id=int(followup_gate["id"]), timeout=60
            )
            await event_stream.close()
            event_stream = None
            followup_snapshot_response = await client.get(
                f"{args.harness_url}/v1/sessions/{followup_session_id}", headers=headers
            )
            followup_snapshot = response_json_object(
                capture,
                followup_snapshot_response,
                "Follow-up closed snapshot was not JSON",
            )
            require_status(
                followup_snapshot_response,
                200,
                "Follow-up closed tombstone was unavailable",
            )
            require(
                followup_snapshot.get("state") == "closed",
                "Follow-up session was not closed",
            )
            active_session_id = None
            final_submit = await asyncio.to_thread(fixture.submit_snapshot)
            require(final_submit.get("submit_count") == 1, "Cleanup changed the one-submit fixture invariant")
        finally:
            for capacity_session_id in capacity_session_ids:
                try:
                    response = await client.delete(
                        f"{args.harness_url}/v1/sessions/{capacity_session_id}",
                        headers=headers,
                    )
                    capture.response(response)
                except Exception:
                    pass
            if active_session_id is not None:
                try:
                    response = await client.delete(
                        f"{args.harness_url}/v1/sessions/{active_session_id}",
                        headers=headers,
                    )
                    capture.response(response)
                except Exception:
                    pass
            if event_stream is not None:
                await event_stream.close()
            if fixture is not None:
                await asyncio.to_thread(fixture.close)
            await client.aclose()


async def run(args: argparse.Namespace) -> None:
    token = bearer_token()
    capture = Capture()
    failure: BaseException | None = None
    try:
        await workflow(args, token, capture)
    except (KeyboardInterrupt, EOFError):
        failure = SmokeFailure("Smoke interrupted while waiting for a required manual click")
    except BaseException as error:
        failure = error
    try:
        privacy_scan(capture, token)
    except BaseException as error:
        if failure is None:
            failure = error
    if failure is not None:
        if isinstance(failure, SmokeFailure):
            raise failure
        raise SmokeFailure("Smoke failed because a local service or fixture operation failed") from None


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        asyncio.run(run(args))
    except SmokeFailure as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print("Live headed browser-harness smoke passed; OAuth/model/API/gates/approved agent submission/cleanup verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
