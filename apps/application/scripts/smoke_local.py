#!/usr/bin/env python3
"""Headed, live local smoke test for the Browser Harness workflow.

This script intentionally requires a running pipeline, a connected OpenAI Codex
OAuth account, and a running headed browser-harness service. It drives only the
loopback fixture and harness APIs; the two explicitly labelled browser clicks
remain manual.
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
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

_BROWSER_HARNESS_ROOT = Path(__file__).resolve().parents[1]
_TESTS_ROOT = _BROWSER_HARNESS_ROOT / "tests"
if str(_TESTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_TESTS_ROOT))

from fixtures.local_application import LocalApplicationFixture  # noqa: E402


MODEL_PROVIDER = "openai-codex"
MODEL_NAME = "gpt-5.6-sol"
MODEL_REASONING = "high"
GATEWAY_PATH = "/v1/internal/browser-harness/codex"
MODEL_MARKER = "JOBHUNTER_LIVE_MODEL_SMOKE_OK"
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
    "For this synthetic fixture, the candidate explicitly prefers Remote work, "
    "is available Immediately, and confirms that the supplied application answers "
    "are truthful."
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

REQUEST_TIMEOUT = httpx.Timeout(connect=5.0, read=35.0, write=35.0, pool=5.0)
MODEL_TIMEOUT = httpx.Timeout(connect=5.0, read=310.0, write=30.0, pool=5.0)
EVENT_WAIT_SECONDS = 900.0
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
    context = root / "smoke-context.md"
    relevant = root / "quartz-incident.md"
    irrelevant = root / "orchid-garden.md"
    profile.write_text(
        "---\n"
        f'full_name: "{FULL_NAME}"\n'
        f'email: "{EMAIL}"\n'
        'start_date: "Immediately"\n'
        "---\n\n"
        f"{PROFILE_NARRATIVE}\n",
        encoding="utf-8",
    )
    resume.write_bytes(make_pdf(RESUME_EVIDENCE))
    context.write_text(f"# Synthetic application context\n\n{CONTEXT_EVIDENCE}\n", encoding="utf-8")
    extracted = " ".join((page.extract_text() or "") for page in PdfReader(resume).pages)
    require(RESUME_EVIDENCE in extracted, "Synthetic resume PDF was not text-extractable")
    relevant.write_text(f"# Relevant incident\n\n{RELEVANT_ANECDOTE}\n", encoding="utf-8")
    irrelevant.write_text(f"# Unrelated anecdote\n\n{IRRELEVANT_ANECDOTE}\n", encoding="utf-8")
    return {
        "profile": profile,
        "resume": resume,
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
        async with self._client.stream("GET", self._url, headers=self._headers) as response:
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
                            raise SmokeFailure("Harness SSE emitted invalid JSON data") from error
                        require(isinstance(payload, dict), "Harness SSE data was not a JSON object")
                        require(payload.get("event") == event_name, "Harness SSE event name disagreed with its data")
                        require(str(payload.get("id")) == event_id, "Harness SSE event id disagreed with its data")
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
                        raise SmokeFailure("Harness session failed before the expected workflow gate")
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
    command: dict[str, str],
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
        data={"job_url": fixture.posting_url, "max_steps": "100"},
        files=multipart(inputs),
    )
    payload = response_json_object(capture, response, "Harness session create response was not JSON")
    return response, payload


def assert_gateway_completion(payload: dict[str, Any]) -> None:
    require(
        set(payload) == {"modelProvider", "model", "reasoning", "output", "usage"},
        "Live gateway completion returned an unexpected response shape",
    )
    require(payload.get("modelProvider") == MODEL_PROVIDER, "Live gateway used the wrong provider")
    require(payload.get("model") == MODEL_NAME, "Live gateway used the wrong model")
    require(payload.get("reasoning") == MODEL_REASONING, "Live gateway used the wrong reasoning level")
    output = payload.get("output")
    require(isinstance(output, dict), "Live gateway completion output was missing")
    require(set(output) == {"type", "text"}, "Live gateway text output had an unexpected shape")
    require(output.get("type") == "text", "Live gateway did not return unstructured text")
    require(output.get("text", "").strip() == MODEL_MARKER, "Live gateway did not return the smoke marker")
    usage = payload.get("usage")
    require(isinstance(usage, dict), "Live gateway usage metadata was missing")
    require(
        set(usage) == {"inputTokens", "outputTokens", "totalTokens"}
        and all(isinstance(usage[key], int) and usage[key] >= 0 for key in usage),
        "Live gateway usage metadata was invalid",
    )


def assert_subsequence(actual: list[str], expected: list[str]) -> None:
    cursor = 0
    for value in actual:
        if cursor < len(expected) and value == expected[cursor]:
            cursor += 1
    require(cursor == len(expected), "Harness events did not follow the required gate/revision/ready sequence")


def assert_snapshot(
    snapshot: dict[str, Any],
    session_id: str,
    fixture: LocalApplicationFixture,
) -> None:
    require(snapshot.get("session_id") == session_id, "Final snapshot returned the wrong session id")
    require(snapshot.get("state") == "ready_for_human_submit", "Session did not reach ready_for_human_submit")
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
    require(isinstance(fields, list) and len(fields) >= 10, "Snapshot did not report all fixture fields")
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
    require(snapshot.get("error") is None, "Ready snapshot unexpectedly contained an error")


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
            require(submission.get("full_name") == FULL_NAME, "Submitted fixture name changed after ready")
            require(submission.get("email") == EMAIL, "Submitted fixture email changed after ready")
            require(submission.get("review_answer") == REVISION_VALUE, "Submitted fixture revision changed after ready")
            require(submission.get("resume") == RESUME_NAME, "Submitted fixture resume changed after ready")
            serialized = json.dumps(submission, sort_keys=True).lower()
            require(
                "orchid" not in serialized and "community garden" not in serialized and "fundraiser" not in serialized,
                "Final fixture submission imported the irrelevant anecdote",
            )
            return
        await asyncio.sleep(0.1)
    raise SmokeFailure("Timed out waiting for the one manual final Submit click")


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
    event_stream: EventStream | None = None
    fixture: LocalApplicationFixture | None = None
    client = httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=False)
    model_client = httpx.AsyncClient(timeout=MODEL_TIMEOUT, follow_redirects=False)

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

            live_response = await model_client.post(
                f"{args.pipeline_url}{GATEWAY_PATH}",
                headers={**headers, "Content-Type": "application/json"},
                json={
                    "sessionId": str(uuid4()),
                    "systemPrompt": f"Return exactly {MODEL_MARKER} and no other text.",
                    "transcript": "User: Return the requested local smoke marker now.",
                },
            )
            live_completion = response_json_object(
                capture,
                live_response,
                "Live pipeline gateway response was not JSON",
            )
            require_status(live_response, 200, "Live pipeline model call failed")
            assert_gateway_completion(live_completion)

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

            concurrent_response, concurrent = await create_session(
                client, capture, args.harness_url, headers, fixture, inputs
            )
            require_status(concurrent_response, 409, "Concurrent session create did not return 409")
            require(
                concurrent == {"code": "session_active", "session_id": active_session_id},
                "Concurrent session create did not identify the active singleton",
            )

            await event_stream.wait_for("session_started")
            approval = await event_stream.wait_for("origin_approval_required")
            require(
                approval.get("detail") == {"origin": fixture.form_origin},
                "Harness requested approval for an origin other than the exact fixture form origin",
            )
            await post_command(
                client,
                capture,
                commands_url,
                headers,
                {"type": "approve_origin", "origin": fixture.form_origin},
                "Harness rejected exact dynamic form-origin approval",
            )

            navigation = await event_stream.wait_for(
                "human_navigation_required", after_id=int(approval["id"])
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

            first_review = await event_stream.wait_for(
                "review_required", after_id=int(navigation["id"])
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
            await post_command(
                client,
                capture,
                commands_url,
                headers,
                {"type": "ready"},
                "Harness rejected ready on the second review",
            )
            ready = await event_stream.wait_for(
                "ready_for_human_submit", after_id=int(second_review["id"])
            )

            event_names = [event["event"] for event in event_stream.events]
            assert_subsequence(
                event_names,
                [
                    "session_started",
                    "origin_approval_required",
                    "human_navigation_required",
                    "review_required",
                    "revision_applied",
                    "review_required",
                    "ready_for_human_submit",
                ],
            )
            expected_states = {
                "session_started": "running",
                "origin_approval_required": "awaiting_origin_approval",
                "human_navigation_required": "awaiting_human_navigation",
                "review_required": "awaiting_human_review",
                "revision_applied": "running",
                "ready_for_human_submit": "ready_for_human_submit",
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
            require(ready.get("session") == snapshot, "Ready SSE snapshot disagreed with the GET snapshot")

            progress = await wait_fixture_progress(fixture)
            assert_fixture_progress(progress)
            before_submit = await asyncio.to_thread(fixture.submit_snapshot)
            require(before_submit.get("submit_count") == 0, "Configured workflow submitted before human handoff")
            require(before_submit.get("last_submission") is None, "Fixture retained a submission before human handoff")

            print('In headed Chrome, inspect the form and click "Submit application" exactly once, then press Enter here.')
            await asyncio.to_thread(input)
            await wait_for_one_submit(fixture)

            delete_response = await client.delete(
                f"{args.harness_url}/v1/sessions/{active_session_id}", headers=headers
            )
            capture.response(delete_response)
            require_status(delete_response, 204, "DELETE did not close and clean the ready session")
            require(delete_response.content == b"", "DELETE 204 unexpectedly contained a body")
            await event_stream.wait_for("closed", after_id=int(ready["id"]), timeout=60)

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

            cleanup_create_response, cleanup_created = await create_session(
                client, capture, args.harness_url, headers, fixture, inputs
            )
            require_status(
                cleanup_create_response,
                202,
                "A new session could not start after ordered cleanup released the singleton",
            )
            cleanup_session_id = str(cleanup_created.get("session_id"))
            try:
                UUID(cleanup_session_id)
            except (ValueError, TypeError, AttributeError):
                raise SmokeFailure("Cleanup-proof create returned an invalid session id") from None
            active_session_id = cleanup_session_id
            cleanup_delete = await client.delete(
                f"{args.harness_url}/v1/sessions/{cleanup_session_id}", headers=headers
            )
            capture.response(cleanup_delete)
            require_status(cleanup_delete, 204, "Cleanup-proof session DELETE failed")
            require(cleanup_delete.content == b"", "Cleanup-proof DELETE 204 unexpectedly contained a body")
            cleanup_snapshot_response = await client.get(
                f"{args.harness_url}/v1/sessions/{cleanup_session_id}", headers=headers
            )
            cleanup_snapshot = response_json_object(
                capture,
                cleanup_snapshot_response,
                "Cleanup-proof closed snapshot was not JSON",
            )
            require_status(cleanup_snapshot_response, 200, "Cleanup-proof closed tombstone was unavailable")
            require(cleanup_snapshot.get("state") == "closed", "Cleanup-proof session was not closed")
            active_session_id = None
            final_submit = await asyncio.to_thread(fixture.submit_snapshot)
            require(final_submit.get("submit_count") == 1, "Cleanup changed the one-submit fixture invariant")
        finally:
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
            await model_client.aclose()
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
    print("Live headed browser-harness smoke passed; OAuth/model/API/gates/manual submit/cleanup verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
