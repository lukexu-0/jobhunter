from __future__ import annotations

import asyncio
import base64
import io
import ipaddress
import json
import hashlib
import errno
import os
import shutil
import signal
import stat
import struct
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from browser_use.browser.events import SwitchTabEvent
from PIL import Image

from .models import (
    AdditionalInfoBooleanQuestion,
    AdditionalInfoMultiSelectQuestion,
    AdditionalInfoOption,
    AdditionalInfoQuestion,
    AdditionalInfoSingleSelectQuestion,
    AdditionalInfoTextQuestion,
    BrowserObservation,
    BrowserScreenshot,
    BrowserTab,
    BrowserUseExecutionResult,
)

_MAX_FRAME_BYTES = 1024 * 1024
_MAX_SOURCE_BYTES = 65_536
_MAX_OUTPUT_CHARS = 20_000
_MAX_DOM_CHARS = 40_000
_MAX_PNG_BYTES = 8 * 1024 * 1024
_MAX_IMAGE_SIDE = 1_800
_MAX_URL_CHARS = 4_096
_MAX_TITLE_CHARS = 4_096
_MAX_TAB_ID_CHARS = 512
_MAX_TABS = 100
_MAX_CANDIDATE_CONTROLS = 200
_MAX_CANDIDATE_QUESTIONS = 20
_MAX_CANDIDATE_FRAMES = 20
_CANDIDATE_CONTROL_SCAN = r"""() => JSON.stringify((() => {
  const compact = (value, maximum) => String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  const roots = [document];
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    for (const element of roots[rootIndex].querySelectorAll("*")) {
      if (!element.shadowRoot) continue;
      if (roots.length >= 50) {
        return {controls: [], truncated: true};
      }
      roots.push(element.shadowRoot);
    }
  }
  const labelContents = (label) => {
    const copy = label.cloneNode(true);
    copy.querySelectorAll("input, textarea, select, button").forEach((node) => node.remove());
    return compact(copy.textContent, 500);
  };
  const referencedText = (element) => {
    const root = element.getRootNode();
    const getById = typeof root.getElementById === "function"
      ? (id) => root.getElementById(id)
      : (id) => document.getElementById(id);
    return compact(
      (element.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => getById(id)?.textContent || "")
        .join(" "),
      500,
    );
  };
  const controlLabel = (element) => {
    const direct = compact(element.getAttribute("aria-label"), 500);
    if (direct) return direct;
    const referenced = referencedText(element);
    if (referenced) return referenced;
    for (const label of Array.from(element.labels || [])) {
      const contents = labelContents(label);
      if (contents) return contents;
    }
    const placeholder = compact(element.getAttribute("placeholder"), 500);
    if (placeholder) return placeholder;
    return compact(
      (element.getAttribute("name") || element.id || "Application question")
        .replace(/[_-]+/g, " "),
      500,
    );
  };
  const groupLabel = (elements) => {
    const first = elements[0];
    const legend = first.closest("fieldset")?.querySelector("legend");
    const legendText = compact(legend?.textContent, 500);
    if (legendText) return legendText;
    const direct = compact(first.getAttribute("aria-label"), 500);
    if (direct) return direct;
    const referenced = referencedText(first);
    if (referenced) return referenced;
    return compact(
      (first.getAttribute("name") || first.id || "Application question")
        .replace(/[_-]+/g, " "),
      500,
    );
  };
  const readOnlyInputTypes = new Set([
    "date",
    "datetime-local",
    "email",
    "month",
    "number",
    "password",
    "search",
    "tel",
    "text",
    "time",
    "url",
    "week",
  ]);
  const visible = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = tag === "input"
      ? (element.getAttribute("type") || "text").toLowerCase()
      : tag;
    if (
      element.hidden
      || element.disabled
      || element.matches(":disabled")
      || (
        element.readOnly
        && (tag === "textarea" || readOnlyInputTypes.has(type))
      )
    ) return false;
    for (
      let ancestor = element;
      ancestor;
      ancestor = ancestor.parentElement || ancestor.getRootNode()?.host || null
    ) {
      if (ancestor.matches?.("[inert]")) return false;
    }
    if (
      typeof element.checkVisibility === "function"
      && !element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
      })
    ) return false;
    const style = getComputedStyle(element);
    if (
      style.display === "none"
      || style.visibility === "hidden"
      || Number.parseFloat(style.opacity || "1") <= 0
    ) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
  };
  const inputs = [];
  for (const root of roots) {
    for (const element of root.querySelectorAll("input, textarea, select")) {
      if (!visible(element)) continue;
      if (
        element.tagName.toLowerCase() === "input"
        && ["button", "file", "hidden", "image", "password", "reset", "submit"]
          .includes((element.getAttribute("type") || "text").toLowerCase())
      ) continue;
      inputs.push(element);
      if (inputs.length > 200) {
        return {controls: [], truncated: true};
      }
    }
  }
  const controls = [];
  const consumed = new Set();
  const page = `${location.origin}${location.pathname}`;
  const sameControlGroup = (left, right, type, name) => (
    right.tagName.toLowerCase() === "input"
    && (right.getAttribute("type") || "text").toLowerCase() === type
    && (right.getAttribute("name") || "") === name
    && right.form === left.form
    && right.getRootNode() === left.getRootNode()
  );
  const identityFor = (element, index, question, answerType, options) => {
    const tag = element.tagName.toLowerCase();
    const type = tag === "input"
      ? (element.getAttribute("type") || "text").toLowerCase()
      : tag;
    const id = element.id || "";
    const name = element.getAttribute("name") || "";
    const root = roots.indexOf(element.getRootNode());
    const form = element.form;
    const formRoot = form?.getRootNode();
    const formIndex = form && typeof formRoot?.querySelectorAll === "function"
      ? Array.from(formRoot.querySelectorAll("form")).indexOf(form)
      : -1;
    const ordinal = inputs.slice(0, index).filter((candidate) => (
      candidate.tagName.toLowerCase() === tag
      && (candidate.getAttribute("type") || candidate.tagName).toLowerCase() === type
      && (candidate.id || "") === id
      && (candidate.getAttribute("name") || "") === name
      && candidate.form === form
      && candidate.getRootNode() === element.getRootNode()
    )).length;
    return JSON.stringify({
      page,
      root,
      form: form
        ? {
            id: form.id || "",
            name: form.getAttribute("name") || "",
            ordinal: formIndex,
          }
        : null,
      tag,
      type,
      id,
      name,
      ordinal,
      question,
      answerType,
      options,
    });
  };
  for (let index = 0; index < inputs.length; index += 1) {
    const element = inputs[index];
    if (consumed.has(element)) continue;
    const tag = element.tagName.toLowerCase();
    const type = tag === "input"
      ? (element.getAttribute("type") || "text").toLowerCase()
      : tag;
    const name = element.getAttribute("name") || "";
    if ((type === "radio" || type === "checkbox") && name) {
      const group = inputs.filter((candidate) => (
        sameControlGroup(element, candidate, type, name)
      ));
      if (group.length > 1) {
        group.forEach((candidate) => consumed.add(candidate));
        if (group.length > 20) {
          return {controls: [], truncated: true};
        }
        const question = groupLabel(group);
        const options = group.map((candidate) => controlLabel(candidate)).filter(Boolean);
        if (
          !question
          || options.length !== group.length
          || options.length < 2
        ) {
          return {controls: [], truncated: true};
        }
        const answerType = type === "radio" ? "single_select" : "multi_select";
        controls.push({
          identity: identityFor(element, index, question, answerType, options),
          question,
          answer_type: answerType,
          options,
        });
        continue;
      }
    }
    consumed.add(element);
    const question = controlLabel(element);
    if (!question) {
      return {controls: [], truncated: true};
    }
    let answerType = type === "checkbox" || type === "radio" ? "boolean" : "text";
    let options = [];
    if (tag === "select") {
      options = Array.from(element.options)
        .filter((option) => !option.disabled && option.value !== "")
        .map((option) => compact(option.label || option.textContent, 200))
        .filter(Boolean);
      if (options.length >= 2 && options.length <= 20) {
        answerType = element.multiple ? "multi_select" : "single_select";
      } else {
        options = [];
      }
    }
    controls.push({
      identity: identityFor(element, index, question, answerType, options),
      question,
      answer_type: answerType,
      options,
    });
  }
  return {
    controls,
    truncated: false,
  };
})())"""
_FRAME_OWNER_VISIBILITY_SCAN = r"""function() {
  const element = this;
  if (!element || !["iframe", "frame"].includes(element.tagName?.toLowerCase())) {
    return false;
  }
  if (element.hidden) return false;
  for (
    let ancestor = element;
    ancestor;
    ancestor = ancestor.parentElement || ancestor.getRootNode()?.host || null
  ) {
    if (ancestor.matches?.("[inert]")) return false;
  }
  if (
    typeof element.checkVisibility === "function"
    && !element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
    })
  ) return false;
  const style = getComputedStyle(element);
  if (
    style.display === "none"
    || style.visibility === "hidden"
    || Number.parseFloat(style.opacity || "1") <= 0
    || style.pointerEvents === "none"
  ) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
}"""


@dataclass(frozen=True, slots=True)
class _CandidateControl:
    fingerprint: str
    question: AdditionalInfoQuestion


class BrowserSkillRuntimeError(Exception):
    """A fixed runtime failure that can be mapped without exposing child output."""

    def __init__(self, code: Literal["browser_failed", "session_timeout"]) -> None:
        super().__init__(code)
        self.code = code


def _loopback_cdp_environment(value: str | None) -> tuple[str, str]:
    if not value:
        raise BrowserSkillRuntimeError("browser_failed")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError):
        raise BrowserSkillRuntimeError("browser_failed") from None
    hostname = (parsed.hostname or "").rstrip(".").lower()
    try:
        loopback = hostname == "localhost" or ipaddress.ip_address(
            hostname
        ).is_loopback
    except ValueError:
        loopback = hostname == "localhost"
    if (
        parsed.scheme not in {"http", "https", "ws", "wss"}
        or not loopback
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise BrowserSkillRuntimeError("browser_failed")
    if parsed.scheme in {"http", "https"}:
        if parsed.path not in {"", "/"}:
            raise BrowserSkillRuntimeError("browser_failed")
        return "BU_CDP_URL", value.rstrip("/")
    return "BU_CDP_WS", value


def _json_object(raw: bytes) -> dict[str, Any]:
    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def reject_constant(_value: str) -> None:
        raise ValueError("non-finite JSON number")

    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=object_pairs,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        raise BrowserSkillRuntimeError("browser_failed") from None
    if not isinstance(value, dict):
        raise BrowserSkillRuntimeError("browser_failed")
    return value


def _validate_execute_response(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("ok") is False:
        if set(value) != {"ok", "error"} or value.get("error") != "browser_failed":
            raise BrowserSkillRuntimeError("browser_failed")
        raise BrowserSkillRuntimeError("browser_failed")
    expected = {
        "ok",
        "exit_code",
        "timed_out",
        "deadline_exhausted",
        "stdout",
        "stderr",
        "stdout_truncated",
        "stderr_truncated",
        "marker",
        "cancelled",
    }
    if set(value) != expected or value.get("ok") is not True:
        raise BrowserSkillRuntimeError("browser_failed")
    if type(value["exit_code"]) is not int:
        raise BrowserSkillRuntimeError("browser_failed")
    for key in (
        "timed_out",
        "deadline_exhausted",
        "stdout_truncated",
        "stderr_truncated",
        "cancelled",
    ):
        if type(value[key]) is not bool:
            raise BrowserSkillRuntimeError("browser_failed")
    for key in ("stdout", "stderr"):
        if not isinstance(value[key], str) or len(value[key]) > _MAX_OUTPUT_CHARS:
            raise BrowserSkillRuntimeError("browser_failed")
    marker = value["marker"]
    if marker is not None:
        if type(marker) is not dict or set(marker) != {"current_tab", "page_info"}:
            raise BrowserSkillRuntimeError("browser_failed")
        current_tab = marker["current_tab"]
        page_info = marker["page_info"]
        if (
            type(current_tab) is not dict
            or set(current_tab) != {"targetId", "url", "title"}
            or not isinstance(current_tab["targetId"], str)
            or not current_tab["targetId"]
            or len(current_tab["targetId"]) > 512
            or not isinstance(current_tab["url"], str)
            or len(current_tab["url"]) > 4_096
            or not isinstance(current_tab["title"], str)
            or len(current_tab["title"]) > 4_096
            or not (isinstance(page_info, dict) or page_info is None)
        ):
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            marker_size = len(
                json.dumps(
                    marker,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                )
            )
        except (TypeError, ValueError, RecursionError):
            raise BrowserSkillRuntimeError("browser_failed") from None
        if marker_size > 16_000:
            raise BrowserSkillRuntimeError("browser_failed")

    return value




def _bounded_append(value: str, suffix: str) -> tuple[str, bool]:
    combined = f"{value.rstrip()}\n{suffix}" if value else suffix
    if len(combined) <= _MAX_OUTPUT_CHARS:
        return combined, False
    return combined[-_MAX_OUTPUT_CHARS:], True


def _png_screenshot(value: str | None) -> BrowserScreenshot | None:
    if value is None:
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise BrowserSkillRuntimeError("browser_failed") from None
    if len(raw) > _MAX_PNG_BYTES:
        raise BrowserSkillRuntimeError("browser_failed")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG":
                raise BrowserSkillRuntimeError("browser_failed")
            width, height = image.size
            if width <= 0 or height <= 0 or width * height > 100_000_000:
                raise BrowserSkillRuntimeError("browser_failed")
            image.load()
            if max(width, height) <= _MAX_IMAGE_SIDE:
                encoded = value
            else:
                image.thumbnail(
                    (_MAX_IMAGE_SIDE, _MAX_IMAGE_SIDE),
                    Image.Resampling.LANCZOS,
                )
                destination = io.BytesIO()
                image.save(destination, format="PNG", optimize=True)
                resized = destination.getvalue()
                if len(resized) > _MAX_PNG_BYTES:
                    raise BrowserSkillRuntimeError("browser_failed")
                encoded = base64.b64encode(resized).decode("ascii")
    except BrowserSkillRuntimeError:
        raise
    except Exception:
        raise BrowserSkillRuntimeError("browser_failed") from None
    return BrowserScreenshot(data=encoded)


def _bind_parent_directories(paths: tuple[Path, ...]) -> list[str]:
    directories: set[Path] = set()
    for path in paths:
        current = path.parent
        while current != Path("/"):
            directories.add(current)
            current = current.parent
    arguments: list[str] = []
    for directory in sorted(directories, key=lambda item: len(item.parts)):
        arguments.extend(("--dir", str(directory)))
    return arguments


def _python_runtime_roots() -> tuple[Path, ...]:
    roots = [Path(sys.executable).resolve().parents[1]]
    link = Path(sys.executable)
    seen: set[Path] = set()
    while link not in seen and link.is_symlink():
        seen.add(link)
        target = Path(os.readlink(link))
        if not target.is_absolute():
            target = link.parent / target
        target = target.absolute()
        roots.append(target.parents[1])
        link = target
    return tuple(dict.fromkeys(roots))


class BrowserSkillRuntime:
    def __init__(
        self,
        *,
        browser: Any,
        session_directory: Path,
        workspace: Path,
        bubblewrap_executable: Path,
        deadline: float,
    ) -> None:
        self._browser = browser
        self._session_directory = session_directory
        self._workspace = workspace
        self._bubblewrap_executable = bubblewrap_executable
        self._deadline = deadline
        self._start_lock = asyncio.Lock()
        self._operation_lock = asyncio.Lock()
        self._close_lock = asyncio.Lock()
        self._process_lock = asyncio.Lock()
        self._start_attempted = False
        self._started = False
        self._closed = False
        self._close_complete = False
        self._cdp_environment: tuple[str, str] | None = None
        self._supervisor: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._active_task: asyncio.Task[Any] | None = None
        self._quarantine_directory: Path | None = None
        self._candidate_control_fingerprints: set[str] = set()
        self._candidate_baseline_ready = False
        self._candidate_world_contexts: dict[tuple[str, str, str], int] = {}

    @staticmethod
    def _candidate_control(
        value: object,
        namespace: str = "main",
    ) -> _CandidateControl:
        if not isinstance(value, dict) or set(value) != {
            "identity",
            "question",
            "answer_type",
            "options",
        }:
            raise BrowserSkillRuntimeError("browser_failed")
        identity = value["identity"]
        question_text = value["question"]
        answer_type = value["answer_type"]
        raw_options = value["options"]
        if (
            not isinstance(identity, str)
            or not identity
            or len(identity) > 16_384
            or not isinstance(namespace, str)
            or not namespace
            or len(namespace) > 512
            or not isinstance(question_text, str)
            or not isinstance(answer_type, str)
            or not isinstance(raw_options, list)
        ):
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            question_text.encode("utf-8")
            fingerprint = hashlib.sha256(
                f"{namespace}\0{identity}".encode("utf-8")
            ).hexdigest()
            question_id = f"candidate_{fingerprint[:16]}"
            common = {
                "id": question_id,
                "key": f"form.{question_id}",
                "scope": "application",
                "question": question_text,
                "answer_type": answer_type,
            }
            if answer_type == "text" and not raw_options:
                question: AdditionalInfoQuestion = AdditionalInfoTextQuestion(
                    **common
                )
            elif answer_type == "boolean" and not raw_options:
                question = AdditionalInfoBooleanQuestion(**common)
            elif answer_type in {"single_select", "multi_select"}:
                if not 2 <= len(raw_options) <= 20 or not all(
                    isinstance(label, str) for label in raw_options
                ):
                    raise ValueError("invalid candidate question options")
                options = [
                    AdditionalInfoOption(
                        id=(
                            "option_"
                            + hashlib.sha256(
                                f"{fingerprint}\0{index}\0{label}".encode("utf-8")
                            ).hexdigest()[:16]
                        ),
                        label=label,
                    )
                    for index, label in enumerate(raw_options)
                ]
                if answer_type == "single_select":
                    question = AdditionalInfoSingleSelectQuestion(
                        **common,
                        options=options,
                    )
                else:
                    question = AdditionalInfoMultiSelectQuestion(
                        **common,
                        options=options,
                    )
            else:
                raise ValueError("invalid candidate question type")
        except (TypeError, ValueError):
            raise BrowserSkillRuntimeError("browser_failed") from None
        return _CandidateControl(fingerprint=fingerprint, question=question)

    @staticmethod
    def _candidate_frames(
        frame_tree: object,
    ) -> tuple[tuple[str, str, str, str | None], ...]:
        pending: list[tuple[object, str | None, str]] = [
            (frame_tree, None, "top")
        ]
        frames: list[tuple[str, str, str, str | None]] = []
        while pending:
            node, parent_id, namespace = pending.pop()
            if not isinstance(node, dict):
                raise BrowserSkillRuntimeError("browser_failed")
            frame = node.get("frame")
            children = node.get("childFrames", [])
            if (
                not isinstance(frame, dict)
                or not isinstance(children, list)
            ):
                raise BrowserSkillRuntimeError("browser_failed")
            frame_id = frame.get("id")
            loader_id = frame.get("loaderId")
            if (
                not isinstance(frame_id, str)
                or not frame_id
                or len(frame_id) > 512
                or not isinstance(loader_id, str)
                or not loader_id
                or len(loader_id) > 512
            ):
                raise BrowserSkillRuntimeError("browser_failed")
            frames.append((frame_id, loader_id, namespace, parent_id))
            if len(frames) > _MAX_CANDIDATE_FRAMES:
                raise BrowserSkillRuntimeError("browser_failed")
            pending.extend(
                (
                    child,
                    frame_id,
                    f"{namespace}/{index}",
                )
                for index, child in reversed(tuple(enumerate(children)))
            )
        return tuple(frames)

    @classmethod
    def _candidate_controls_from_serialized(
        cls,
        serialized: object,
        namespace: str,
    ) -> tuple[_CandidateControl, ...]:
        if not isinstance(serialized, str):
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            if len(serialized.encode("utf-8")) > _MAX_FRAME_BYTES:
                raise BrowserSkillRuntimeError("browser_failed")
            payload = json.loads(serialized)
        except BrowserSkillRuntimeError:
            raise
        except (TypeError, UnicodeError, json.JSONDecodeError, RecursionError):
            raise BrowserSkillRuntimeError("browser_failed") from None
        if (
            not isinstance(payload, dict)
            or set(payload) != {"controls", "truncated"}
            or payload.get("truncated") is not False
            or not isinstance(payload.get("controls"), list)
            or len(payload["controls"]) > _MAX_CANDIDATE_CONTROLS
        ):
            raise BrowserSkillRuntimeError("browser_failed")
        controls = tuple(
            cls._candidate_control(value, namespace)
            for value in payload["controls"]
        )
        if len({control.fingerprint for control in controls}) != len(controls):
            raise BrowserSkillRuntimeError("browser_failed")
        return controls

    async def _visible_candidate_controls(self) -> tuple[_CandidateControl, ...]:
        try:
            return await self._visible_candidate_controls_once()
        except asyncio.CancelledError:
            raise
        except BrowserSkillRuntimeError:
            self._candidate_world_contexts.clear()
        await asyncio.sleep(0)
        return await self._visible_candidate_controls_once()

    async def _visible_candidate_controls_once(
        self,
    ) -> tuple[_CandidateControl, ...]:
        try:
            target_info = await self._browser.get_current_target_info()
            if not isinstance(target_info, dict):
                raise BrowserSkillRuntimeError("browser_failed")
            target_id = target_info.get("targetId")
            if not isinstance(target_id, str) or not target_id:
                raise BrowserSkillRuntimeError("browser_failed")
            cdp_session = await self._browser.get_or_create_cdp_session(
                target_id,
                focus=False,
            )
            client = cdp_session.cdp_client
            session_id = cdp_session.session_id
            await client.send.DOM.enable(session_id=session_id)
            frame_tree_result = await client.send.Page.getFrameTree(
                session_id=session_id
            )
            if not isinstance(frame_tree_result, dict):
                raise BrowserSkillRuntimeError("browser_failed")
            frames = self._candidate_frames(
                frame_tree_result.get("frameTree")
            )
            active_world_keys = {
                (target_id, frame_id, loader_id)
                for frame_id, loader_id, _namespace, _parent_id in frames
            }
            self._candidate_world_contexts = {
                key: context_id
                for key, context_id in self._candidate_world_contexts.items()
                if key in active_world_keys
            }
            controls: list[_CandidateControl] = []
            serialized_bytes = 0
            frame_contexts: dict[str, int] = {}
            frame_visibility: dict[str, bool] = {}
            for frame_id, loader_id, namespace, parent_id in frames:
                if parent_id is not None:
                    if not frame_visibility.get(parent_id, False):
                        frame_visibility[frame_id] = False
                        continue
                    parent_context_id = frame_contexts.get(parent_id)
                    if parent_context_id is None:
                        raise BrowserSkillRuntimeError("browser_failed")
                    owner = await client.send.DOM.getFrameOwner(
                        params={"frameId": frame_id},
                        session_id=session_id,
                    )
                    if not isinstance(owner, dict):
                        raise BrowserSkillRuntimeError("browser_failed")
                    backend_node_id = owner.get("backendNodeId")
                    if not isinstance(backend_node_id, int):
                        raise BrowserSkillRuntimeError("browser_failed")
                    resolved = await client.send.DOM.resolveNode(
                        params={
                            "backendNodeId": backend_node_id,
                            "executionContextId": parent_context_id,
                        },
                        session_id=session_id,
                    )
                    remote_object = (
                        resolved.get("object")
                        if isinstance(resolved, dict)
                        else None
                    )
                    object_id = (
                        remote_object.get("objectId")
                        if isinstance(remote_object, dict)
                        else None
                    )
                    if not isinstance(object_id, str) or not object_id:
                        raise BrowserSkillRuntimeError("browser_failed")
                    try:
                        visibility = await client.send.Runtime.callFunctionOn(
                            params={
                                "functionDeclaration": (
                                    _FRAME_OWNER_VISIBILITY_SCAN
                                ),
                                "objectId": object_id,
                                "returnByValue": True,
                                "awaitPromise": True,
                            },
                            session_id=session_id,
                        )
                    finally:
                        await client.send.Runtime.releaseObject(
                            params={"objectId": object_id},
                            session_id=session_id,
                        )
                    visible = (
                        visibility.get("result", {}).get("value")
                        if isinstance(visibility, dict)
                        and isinstance(visibility.get("result"), dict)
                        and "exceptionDetails" not in visibility
                        else None
                    )
                    if type(visible) is not bool:
                        raise BrowserSkillRuntimeError("browser_failed")
                    if not visible:
                        frame_visibility[frame_id] = False
                        continue
                world_key = (target_id, frame_id, loader_id)
                context_id = self._candidate_world_contexts.get(world_key)
                if context_id is None:
                    world = await client.send.Page.createIsolatedWorld(
                        params={
                            "frameId": frame_id,
                            "worldName": "jobhunter-candidate-question-scan",
                        },
                        session_id=session_id,
                    )
                    if not isinstance(world, dict):
                        raise BrowserSkillRuntimeError("browser_failed")
                    context_id = world.get("executionContextId")
                    if not isinstance(context_id, int):
                        raise BrowserSkillRuntimeError("browser_failed")
                    self._candidate_world_contexts[world_key] = context_id
                frame_contexts[frame_id] = context_id
                frame_visibility[frame_id] = True
                result = await client.send.Runtime.callFunctionOn(
                    params={
                        "functionDeclaration": _CANDIDATE_CONTROL_SCAN,
                        "executionContextId": context_id,
                        "returnByValue": True,
                        "awaitPromise": True,
                    },
                    session_id=session_id,
                )
                if (
                    not isinstance(result, dict)
                    or "exceptionDetails" in result
                    or not isinstance(result.get("result"), dict)
                ):
                    raise BrowserSkillRuntimeError("browser_failed")
                serialized = result["result"].get("value")
                if not isinstance(serialized, str):
                    raise BrowserSkillRuntimeError("browser_failed")
                serialized_bytes += len(serialized.encode("utf-8"))
                if serialized_bytes > _MAX_FRAME_BYTES:
                    raise BrowserSkillRuntimeError("browser_failed")
                controls.extend(
                    self._candidate_controls_from_serialized(
                        serialized,
                        namespace,
                    )
                )
                if len(controls) > _MAX_CANDIDATE_CONTROLS:
                    raise BrowserSkillRuntimeError("browser_failed")
        except asyncio.CancelledError:
            raise
        except BrowserSkillRuntimeError:
            raise
        except Exception:
            raise BrowserSkillRuntimeError("browser_failed") from None
        if len({control.fingerprint for control in controls}) != len(controls):
            raise BrowserSkillRuntimeError("browser_failed")
        return tuple(controls)

    async def _candidate_questions_before_execution(
        self,
    ) -> list[AdditionalInfoQuestion]:
        controls = await self._visible_candidate_controls()
        if not self._candidate_baseline_ready:
            self._candidate_control_fingerprints.update(
                control.fingerprint for control in controls
            )
            self._candidate_baseline_ready = True
            return []
        unseen = [
            control
            for control in controls
            if control.fingerprint not in self._candidate_control_fingerprints
        ][:_MAX_CANDIDATE_QUESTIONS]
        self._candidate_control_fingerprints.update(
            control.fingerprint for control in unseen
        )
        return [control.question for control in unseen]

    async def _record_candidate_control_baseline(self) -> None:
        controls = await self._visible_candidate_controls()
        self._candidate_control_fingerprints.update(
            control.fingerprint for control in controls
        )
        self._candidate_baseline_ready = True


    def _remaining(self) -> float:
        return self._deadline - asyncio.get_running_loop().time()

    def _prepare_session_paths(self) -> None:
        quarantine: Path | None = None
        try:
            self._session_directory = self._session_directory.resolve(strict=True)
            self._workspace = self._workspace.resolve(strict=True)
            if (
                self._session_directory == self._workspace
                or self._session_directory.is_relative_to(self._workspace)
                or self._workspace.is_relative_to(self._session_directory)
                or self._quarantine_directory is not None
            ):
                raise OSError("overlapping runtime paths")
            for path in (
                self._session_directory / "browser-skill-home",
                self._session_directory / "browser-skill-runtime",
                self._session_directory / "browser-skill-tmp",
            ):
                path.mkdir(mode=0o700, exist_ok=True)
                details = path.lstat()
                if (
                    stat.S_ISLNK(details.st_mode)
                    or not stat.S_ISDIR(details.st_mode)
                    or details.st_uid != os.getuid()
                ):
                    raise OSError("unsafe runtime path")
                path.chmod(0o700)
            quarantine = Path(
                tempfile.mkdtemp(
                    prefix=".browser-skill-quarantine-",
                    dir=self._session_directory.parent,
                )
            )
            quarantine.chmod(0o700)
            details = quarantine.lstat()
            if (
                stat.S_ISLNK(details.st_mode)
                or not stat.S_ISDIR(details.st_mode)
                or details.st_uid != os.getuid()
                or stat.S_IMODE(details.st_mode) != 0o700
            ):
                raise OSError("unsafe quarantine path")
            self._quarantine_directory = quarantine
        except OSError:
            if quarantine is not None:
                try:
                    shutil.rmtree(quarantine)
                except OSError:
                    pass
            raise BrowserSkillRuntimeError("browser_failed") from None

    def _bubblewrap_command(self) -> tuple[str, ...]:
        assert self._cdp_environment is not None
        application_source = Path(__file__).resolve().parent.parent
        environment_root = Path(sys.prefix).resolve()
        read_only_custom = tuple(
            dict.fromkeys(
                (environment_root, *_python_runtime_roots(), application_source)
            )
        )
        if Path("/") in read_only_custom:
            raise BrowserSkillRuntimeError("browser_failed")
        writable = (self._session_directory, self._workspace)
        command: list[str] = [
            str(self._bubblewrap_executable),
            "--die-with-parent",
            "--new-session",
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-cgroup",
            "--share-net",
            "--tmpfs",
            "/tmp",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
        ]
        for system_path in (Path("/usr"), Path("/bin"), Path("/lib"), Path("/lib64"), Path("/etc")):
            if system_path.exists():
                command.extend(("--ro-bind", str(system_path), str(system_path)))
        command.extend(_bind_parent_directories(read_only_custom + writable))
        for path in read_only_custom:
            command.extend(("--ro-bind", str(path), str(path)))
        for path in writable:
            command.extend(("--bind", str(path), str(path)))
        sandbox_session = Path("/jobhunter-session")
        command.extend(("--bind", str(self._session_directory), str(sandbox_session)))
        home = sandbox_session / "browser-skill-home"
        runtime = sandbox_session / "browser-skill-runtime"
        temporary = sandbox_session / "browser-skill-tmp"
        environment = {
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "BROWSER_USE_CONFIG_DIR": str(home / "browser-use"),
            "BH_HOME": str(home / "browser-harness"),
            "BH_RUNTIME_DIR": str(runtime),
            "BH_TMP_DIR": str(temporary),
            "BH_AGENT_WORKSPACE": str(self._workspace),
            "BH_DOMAIN_SKILLS": "1",
            "ANONYMIZED_TELEMETRY": "false",
            "BROWSER_HARNESS_TELEMETRY": "false",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONNOUSERSITE": "1",
            "PYTHONUNBUFFERED": "1",
            "PATH": f"{environment_root / 'bin'}:/usr/bin:/bin",
            "TMPDIR": "/tmp",
            "LANG": "C.UTF-8",
            "JOBHUNTER_SESSION_DEADLINE": repr(self._deadline),
            "JOBHUNTER_SESSION_DIRECTORY": str(sandbox_session),
            self._cdp_environment[0]: self._cdp_environment[1],
        }
        command.append("--clearenv")
        for key, value in environment.items():
            command.extend(("--setenv", key, value))
        command.extend(
            (
                "--chdir",
                str(sandbox_session),
                "--",
                sys.executable,
                "-m",
                "jobhunter_browser_harness.skill_process",
                "--server",
            )
        )
        return tuple(command)

    async def _drain_supervisor_stderr(
        self, stream: asyncio.StreamReader
    ) -> None:
        retained = bytearray()
        while chunk := await stream.read(16_384):
            retained.extend(chunk)
            if len(retained) > 80_004:
                del retained[: len(retained) - 80_004]

    async def start(self) -> None:
        async with self._start_lock:
            if self._started:
                return
            if self._closed or self._start_attempted:
                raise BrowserSkillRuntimeError("browser_failed")
            self._start_attempted = True
            if self._remaining() <= 0:
                raise BrowserSkillRuntimeError("session_timeout")
            try:
                await self._browser.start()
            except asyncio.CancelledError:
                raise
            except Exception:
                raise BrowserSkillRuntimeError("browser_failed") from None
            self._cdp_environment = _loopback_cdp_environment(self._browser.cdp_url)
            self._prepare_session_paths()
            self._quarantine_workspace_entries()
            try:
                process = await asyncio.create_subprocess_exec(
                    *self._bubblewrap_command(),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                )
            except asyncio.CancelledError:
                try:
                    self._remove_quarantine_directory()
                except BrowserSkillRuntimeError:
                    pass
                raise
            except Exception:
                try:
                    self._remove_quarantine_directory()
                except BrowserSkillRuntimeError:
                    pass
                raise BrowserSkillRuntimeError("browser_failed") from None
            self._supervisor = process
            assert process.stderr is not None
            self._stderr_task = asyncio.create_task(
                self._drain_supervisor_stderr(process.stderr),
                name="browser-skill-supervisor-stderr",
            )
            try:
                await asyncio.wait_for(asyncio.shield(process.wait()), timeout=0.05)
            except TimeoutError:
                pass
            else:
                await self._terminate_supervisor()
                try:
                    self._remove_quarantine_directory()
                except BrowserSkillRuntimeError:
                    pass
                raise BrowserSkillRuntimeError("browser_failed")
            self._started = True

    async def _write_frame(self, value: dict[str, Any]) -> None:
        process = self._supervisor
        if process is None or process.returncode is not None or process.stdin is None:
            raise BrowserSkillRuntimeError("browser_failed")
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if not encoded or len(encoded) > _MAX_FRAME_BYTES:
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            process.stdin.write(struct.pack(">I", len(encoded)) + encoded)
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionError, OSError):
            raise BrowserSkillRuntimeError("browser_failed") from None

    async def _read_frame(self) -> dict[str, Any]:
        process = self._supervisor
        if process is None or process.stdout is None:
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            header = await process.stdout.readexactly(4)
            (length,) = struct.unpack(">I", header)
            if length <= 0 or length > _MAX_FRAME_BYTES:
                raise BrowserSkillRuntimeError("browser_failed")
            body = await process.stdout.readexactly(length)
        except asyncio.IncompleteReadError:
            raise BrowserSkillRuntimeError("browser_failed") from None
        return _json_object(body)

    async def _exchange(
        self,
        request: dict[str, Any],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        await self._write_frame(request)
        try:
            async with asyncio.timeout(timeout):
                return await self._read_frame()
        except TimeoutError:
            if self._remaining() <= 0:
                raise BrowserSkillRuntimeError("session_timeout") from None
            raise BrowserSkillRuntimeError("browser_failed") from None
    async def _cancel_execution(
        self,
        response_task: asyncio.Task[dict[str, Any]],
    ) -> None:
        try:
            if not response_task.done():
                await self._write_frame({"op": "cancel"})
            async with asyncio.timeout(10.0):
                response = await asyncio.shield(response_task)
            _validate_execute_response(response)
        except (BrowserSkillRuntimeError, TimeoutError, asyncio.CancelledError):
            response_task.cancel()
            await asyncio.gather(response_task, return_exceptions=True)
            await self._terminate_supervisor()

    async def _exchange_execution(
        self,
        request: dict[str, Any],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        await self._write_frame(request)
        response_task = asyncio.create_task(
            self._read_frame(),
            name="browser-skill-execution-response",
        )
        try:
            async with asyncio.timeout(timeout):
                return await asyncio.shield(response_task)
        except asyncio.CancelledError:
            cleanup_task = asyncio.create_task(
                self._cancel_execution(response_task),
                name="browser-skill-execution-cancellation",
            )
            try:
                await asyncio.shield(cleanup_task)
            except asyncio.CancelledError:
                await asyncio.shield(cleanup_task)
            raise
        except TimeoutError:
            response_task.cancel()
            await asyncio.gather(response_task, return_exceptions=True)
            if self._remaining() <= 0:
                raise BrowserSkillRuntimeError("session_timeout") from None
            raise BrowserSkillRuntimeError("browser_failed") from None


    async def _observe(
        self,
        marker: dict[str, Any] | None,
    ) -> BrowserObservation:
        remaining = self._remaining()
        if remaining <= 0:
            raise BrowserSkillRuntimeError("session_timeout")
        try:
            async with asyncio.timeout(remaining):
                return await self._observe_with_no_deadline(marker)
        except TimeoutError:
            raise BrowserSkillRuntimeError("session_timeout") from None


    async def _observe_with_no_deadline(
        self,
        marker: dict[str, Any] | None,
    ) -> BrowserObservation:
        page_info: dict[str, object] | None = None
        if marker is not None:
            current_tab = marker["current_tab"]
            assert isinstance(current_tab, dict)
            target_id = current_tab.get("targetId") or current_tab.get("target_id")
            if isinstance(target_id, str) and target_id:
                try:
                    switch_event = self._browser.event_bus.dispatch(
                        SwitchTabEvent(target_id=target_id)
                    )
                    await switch_event
                    await switch_event.event_result(
                        raise_if_any=True,
                        raise_if_none=False,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    raise BrowserSkillRuntimeError("browser_failed") from None
            raw_page_info = marker["page_info"]
            if isinstance(raw_page_info, dict):
                page_info = raw_page_info
        try:
            state = await self._browser.get_browser_state_summary(
                include_screenshot=True,
                cached=False,
            )
            dom = state.dom_state.llm_representation()[:_MAX_DOM_CHARS]
            tabs = [
                BrowserTab(
                    url=tab.url[:_MAX_URL_CHARS],
                    title=tab.title[:_MAX_TITLE_CHARS],
                    tab_id=tab.target_id[:_MAX_TAB_ID_CHARS],
                    parent_tab_id=(
                        tab.parent_target_id[:_MAX_TAB_ID_CHARS]
                        if tab.parent_target_id is not None
                        else None
                    ),
                )
                for tab in state.tabs[:_MAX_TABS]
            ]
            return BrowserObservation(
                url=state.url[:_MAX_URL_CHARS],
                title=state.title[:_MAX_TITLE_CHARS],
                tabs=tabs,
                dom=dom,
                page_info=page_info,
                screenshot=_png_screenshot(state.screenshot),
            )
        except asyncio.CancelledError:
            raise
        except BrowserSkillRuntimeError:
            raise
        except Exception:
            raise BrowserSkillRuntimeError("browser_failed") from None

    @staticmethod
    def _move_to_quarantine(
        entry: Path,
        destination: Path,
        details: os.stat_result,
    ) -> None:
        try:
            os.rename(entry, destination)
            return
        except OSError as error:
            if error.errno != errno.EXDEV:
                raise
        if stat.S_ISLNK(details.st_mode):
            os.symlink(os.readlink(entry), destination)
            entry.unlink()
            return
        if stat.S_ISREG(details.st_mode):
            source_descriptor = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                destination_descriptor = os.open(
                    destination,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                )
                try:
                    with (
                        os.fdopen(source_descriptor, "rb", closefd=False) as source,
                        os.fdopen(
                            destination_descriptor, "wb", closefd=False
                        ) as target,
                    ):
                        shutil.copyfileobj(source, target, length=64 * 1024)
                finally:
                    os.close(destination_descriptor)
            finally:
                os.close(source_descriptor)
            entry.unlink()
            return
        if stat.S_ISDIR(details.st_mode):
            shutil.copytree(entry, destination, symlinks=True)
            shutil.rmtree(entry)
            return
        entry.unlink()


    def _checked_quarantine_directory(self) -> Path:
        quarantine = self._quarantine_directory
        if quarantine is None:
            raise BrowserSkillRuntimeError("browser_failed")
        try:
            details = quarantine.lstat()
        except OSError:
            raise BrowserSkillRuntimeError("browser_failed") from None
        if (
            stat.S_ISLNK(details.st_mode)
            or not stat.S_ISDIR(details.st_mode)
            or details.st_uid != os.getuid()
            or stat.S_IMODE(details.st_mode) != 0o700
        ):
            raise BrowserSkillRuntimeError("browser_failed")
        return quarantine

    def _remove_quarantine_directory(self) -> None:
        if self._quarantine_directory is None:
            return
        quarantine = self._checked_quarantine_directory()
        try:
            shutil.rmtree(quarantine)
        except OSError:
            raise BrowserSkillRuntimeError("browser_failed") from None
        self._quarantine_directory = None

    def _quarantine_workspace_entries(self) -> None:
        quarantine = self._checked_quarantine_directory()
        try:
            for entry in tuple(self._workspace.iterdir()):
                details = entry.lstat()
                allowed = (
                    entry.name == "agent_helpers.py"
                    and stat.S_ISREG(details.st_mode)
                    and not stat.S_ISLNK(details.st_mode)
                    and details.st_nlink == 1
                ) or (
                    entry.name == "domain-skills"
                    and stat.S_ISDIR(details.st_mode)
                    and not stat.S_ISLNK(details.st_mode)
                )
                if allowed:
                    continue
                destination = quarantine / f"{uuid4().hex}-{entry.name}"
                self._move_to_quarantine(entry, destination, details)
        except OSError:
            raise BrowserSkillRuntimeError("browser_failed") from None

    async def execute(self, code: str) -> BrowserUseExecutionResult:
        if not isinstance(code, str):
            raise BrowserSkillRuntimeError("browser_failed")
        task = asyncio.current_task()
        async with self._operation_lock:
            if not self._started or self._closed:
                raise BrowserSkillRuntimeError("browser_failed")
            remaining = self._remaining()
            if remaining <= 0:
                raise BrowserSkillRuntimeError("session_timeout")
            self._active_task = task
            try:
                self._quarantine_workspace_entries()
                try:
                    encoded_code = code.encode("utf-8")
                except UnicodeEncodeError:
                    raise BrowserSkillRuntimeError("browser_failed") from None
                candidate_questions = (
                    await self._candidate_questions_before_execution()
                )
                if candidate_questions:
                    observation = await self._observe(None)
                    return BrowserUseExecutionResult(
                        exit_code=0,
                        timed_out=False,
                        stdout="",
                        stderr="",
                        stdout_truncated=False,
                        stderr_truncated=False,
                        observation=observation,
                        candidate_questions=candidate_questions,
                    )
                if len(encoded_code) > _MAX_SOURCE_BYTES:
                    observation = await self._observe(None)
                    return BrowserUseExecutionResult(
                        exit_code=2,
                        timed_out=False,
                        stdout="",
                        stderr="Browser Use code exceeds the 65,536-byte limit.",
                        stdout_truncated=False,
                        stderr_truncated=False,
                        observation=observation,
                    )
                wait_seconds = min(125.0, remaining + 0.25)
                response = _validate_execute_response(
                    await self._exchange_execution(
                        {"op": "execute", "code": code},
                        timeout=wait_seconds,
                    )
                )
                if response["cancelled"]:
                    raise BrowserSkillRuntimeError("browser_failed")
                if response["deadline_exhausted"]:
                    raise BrowserSkillRuntimeError("session_timeout")
                stdout = response["stdout"]
                marker = response["marker"]
                stderr = response["stderr"]
                stderr_truncated = response["stderr_truncated"]
                if response["timed_out"]:
                    stderr, added_truncation = _bounded_append(
                        stderr,
                        "Browser Use execution timed out after 120 seconds.",
                    )
                    stderr_truncated = stderr_truncated or added_truncation
                if marker is None:
                    stderr, added_truncation = _bounded_append(
                        stderr,
                        "Browser Use result metadata was unavailable.",
                    )
                    stderr_truncated = stderr_truncated or added_truncation
                observation = await self._observe(marker)
                if (
                    response["exit_code"] == 0
                    and not response["timed_out"]
                    and marker is not None
                ):
                    await self._record_candidate_control_baseline()
                return BrowserUseExecutionResult(
                    exit_code=response["exit_code"],
                    timed_out=response["timed_out"],
                    stdout=stdout[-_MAX_OUTPUT_CHARS:],
                    stderr=stderr,
                    stdout_truncated=(
                        response["stdout_truncated"]
                        or len(stdout) > _MAX_OUTPUT_CHARS
                    ),
                    stderr_truncated=stderr_truncated,
                    observation=observation,
                )
            except asyncio.CancelledError:
                raise
            except BrowserSkillRuntimeError:
                await self._terminate_supervisor()
                raise
            finally:
                active_exception = sys.exc_info()[0] is not None
                try:
                    self._quarantine_workspace_entries()
                except BrowserSkillRuntimeError:
                    if not active_exception:
                        raise
                if self._active_task is task:
                    self._active_task = None

    async def _terminate_supervisor(self) -> None:
        async with self._process_lock:
            process = self._supervisor
            if process is not None:
                if process.returncode is None:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        await asyncio.wait_for(process.wait(), timeout=1.0)
                    except TimeoutError:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        await process.wait()
                self._supervisor = None
            self._started = False
            stderr_task = self._stderr_task
            self._stderr_task = None
            if stderr_task is not None:
                await asyncio.gather(stderr_task, return_exceptions=True)

    async def close(self) -> None:
        async with self._close_lock:
            if self._close_complete:
                return
            self._closed = True
            active = self._active_task
            current = asyncio.current_task()
            if active is not None and active is not current and not active.done():
                active.cancel()
                await asyncio.gather(active, return_exceptions=True)
            stop_failed = False
            process = self._supervisor
            if process is not None and process.returncode is None:
                try:
                    async with self._operation_lock:
                        response = _validate_execute_response(
                            await self._exchange(
                                {"op": "stop_daemon"},
                                timeout=20.0,
                            )
                        )
                        if (
                            response["exit_code"] != 0
                            or response["timed_out"]
                            or response["deadline_exhausted"]
                            or response["cancelled"]
                            or response["stdout"]
                            or response["stderr"]
                            or response["stdout_truncated"]
                            or response["stderr_truncated"]
                        ):
                            stop_failed = True
                except (BrowserSkillRuntimeError, asyncio.CancelledError):
                    stop_failed = True
            await self._terminate_supervisor()
            try:
                self._remove_quarantine_directory()
            except BrowserSkillRuntimeError:
                stop_failed = True
            self._close_complete = True
            if stop_failed:
                raise BrowserSkillRuntimeError("browser_failed")


