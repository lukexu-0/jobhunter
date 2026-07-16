from __future__ import annotations

import asyncio
import json
import logging
import multiprocessing as mp
from dataclasses import dataclass
from pathlib import Path
from multiprocessing.connection import Connection
from types import MappingProxyType
from typing import Literal, Mapping

from pypdf import PdfReader
import pypdf.filters as pypdf_filters

from .artifacts import StoredCandidateArtifacts, StoredUpload
from .models import HarnessServiceError, validate_approved_origin, validate_sanitized_basename

MAX_SOURCE_CHARACTERS = 100_000
MAX_COMBINED_NARRATIVE_CHARACTERS = 250_000
MAX_PDF_STREAM_BYTES = 2 * 1024 * 1024

SourceCategory = Literal["profile", "context", "anecdote"]


@dataclass(frozen=True, slots=True)
class AttributedSource:
    name: str
    category: SourceCategory
    text: str

    def __post_init__(self) -> None:
        validate_sanitized_basename(self.name)
        if len(self.text) > MAX_SOURCE_CHARACTERS:
            raise ValueError("candidate source exceeds the character limit")


@dataclass(frozen=True, slots=True)
class CandidateContext:
    direct_fields: Mapping[str, str]
    resume_text: str
    profile_narrative: AttributedSource
    context_sources: tuple[AttributedSource, ...]
    anecdotes: tuple[AttributedSource, ...]



def _invalid_context() -> HarnessServiceError:
    return HarnessServiceError(422, "invalid_request", "Candidate context is invalid")


def _read_utf8(upload: StoredUpload) -> str:
    try:
        text = upload.path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise _invalid_context() from None
    if len(text) > MAX_SOURCE_CHARACTERS:
        raise _invalid_context()
    return text


def _extract_resume_text(path: Path) -> str:
    limit_names = (
        "MAX_ARRAY_BASED_STREAM_OUTPUT_LENGTH",
        "JBIG2_MAX_OUTPUT_LENGTH",
        "LZW_MAX_OUTPUT_LENGTH",
        "RUN_LENGTH_MAX_OUTPUT_LENGTH",
        "ZLIB_MAX_OUTPUT_LENGTH",
    )
    previous_limits = {name: getattr(pypdf_filters, name) for name in limit_names}
    pypdf_logger = logging.getLogger("pypdf")
    logger_was_disabled = pypdf_logger.disabled
    logger_level = pypdf_logger.level
    try:
        pypdf_logger.disabled = True
        pypdf_logger.setLevel(logging.CRITICAL + 1)
        for name in limit_names:
            setattr(pypdf_filters, name, MAX_PDF_STREAM_BYTES)
        reader = PdfReader(path)
        if reader.is_encrypted and reader.decrypt("") == 0:
            raise _invalid_context()
        page_text: list[str] = []
        character_count = 0
        for page in reader.pages:
            extracted = (page.extract_text() or "").strip()
            character_count += len(extracted) + (2 if page_text and extracted else 0)
            if character_count > MAX_SOURCE_CHARACTERS:
                raise _invalid_context()
            if extracted:
                page_text.append(extracted)
        text = "\n\n".join(page_text)
    except HarnessServiceError:
        raise
    except Exception:
        raise _invalid_context() from None
    finally:
        pypdf_logger.disabled = logger_was_disabled
        pypdf_logger.setLevel(logger_level)
        for name, value in previous_limits.items():
            setattr(pypdf_filters, name, value)
    if not text:
        raise _invalid_context()
    return text


def load_candidate_context(artifacts: StoredCandidateArtifacts) -> CandidateContext:
    """Extract bounded, attributed evidence without placing direct fields in prompt text."""

    try:
        resume_text = _extract_resume_text(artifacts.resume.path)
        profile = AttributedSource(
            name=artifacts.personal_upload.display_name,
            category="profile",
            text=artifacts.personal.narrative,
        )
        contexts = tuple(
            AttributedSource(name=upload.display_name, category="context", text=_read_utf8(upload))
            for upload in artifacts.contexts
        )
        anecdotes = tuple(
            AttributedSource(name=upload.display_name, category="anecdote", text=_read_utf8(upload))
            for upload in artifacts.anecdotes
        )
        combined_length = (
            len(resume_text)
            + len(profile.text)
            + sum(len(source.text) for source in contexts)
            + sum(len(source.text) for source in anecdotes)
        )
        if combined_length > MAX_COMBINED_NARRATIVE_CHARACTERS:
            raise _invalid_context()
        direct_fields = MappingProxyType(dict(artifacts.personal.direct_fields))
        return CandidateContext(
            direct_fields=direct_fields,
            resume_text=resume_text,
            profile_narrative=profile,
            context_sources=contexts,
            anecdotes=anecdotes,
        )
    except HarnessServiceError:
        raise
    except (OSError, UnicodeError, ValueError):
        raise _invalid_context() from None


def _render_source(category: str, name: str, text: str) -> str:
    safe_name = validate_sanitized_basename(name)
    return json.dumps(
        {"category": category, "name": safe_name, "text": text},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def render_candidate_evidence(candidate: CandidateContext, resume_name: str) -> str:
    """Render attributed narrative evidence; explicit direct values are intentionally excluded."""

    sections = [_render_source("resume", resume_name, candidate.resume_text)]
    if candidate.profile_narrative.text:
        sections.append(
            _render_source(
                candidate.profile_narrative.category,
                candidate.profile_narrative.name,
                candidate.profile_narrative.text,
            )
        )
    sections.extend(_render_source(source.category, source.name, source.text) for source in candidate.context_sources)
    sections.extend(_render_source(source.category, source.name, source.text) for source in candidate.anecdotes)
    return "Candidate evidence sources (one JSON object per line):\n" + "\n".join(sections)


def build_sensitive_data(
    candidate: CandidateContext,
    approved_origins: tuple[str, ...] | list[str],
) -> dict[str, dict[str, str]]:
    """Build Browser Use's domain-scoped placeholder map from explicit front matter only."""

    origins = [validate_approved_origin(origin) for origin in approved_origins]
    if len(set(origins)) != len(origins):
        raise ValueError("approved origins must be unique")
    values = dict(candidate.direct_fields)
    return {origin: dict(values) for origin in origins}


def sensitive_placeholder_instruction(candidate: CandidateContext) -> str:
    names = sorted(candidate.direct_fields)
    if not names:
        return "No explicit personal-data placeholders are available."
    placeholders = ", ".join(f"<secret>{name}</secret>" for name in names)
    return f"Use only these placeholders for explicit personal data: {placeholders}."


def _serialize_candidate_context(candidate: CandidateContext) -> dict[str, object]:
    def source(value: AttributedSource) -> dict[str, str]:
        return {
            "name": value.name,
            "category": value.category,
            "text": value.text,
        }

    return {
        "ok": True,
        "direct_fields": list(candidate.direct_fields.items()),
        "resume_text": candidate.resume_text,
        "profile_narrative": source(candidate.profile_narrative),
        "context_sources": [source(value) for value in candidate.context_sources],
        "anecdotes": [source(value) for value in candidate.anecdotes],
    }


def _candidate_context_worker(
    artifacts: StoredCandidateArtifacts,
    sender: Connection,
) -> None:
    try:
        try:
            payload = _serialize_candidate_context(load_candidate_context(artifacts))
        except Exception:
            payload = {"ok": False}
        sender.send(payload)
    finally:
        sender.close()


def _source_from_payload(value: object) -> AttributedSource:
    if not isinstance(value, dict):
        raise _invalid_context()
    try:
        return AttributedSource(
            name=value["name"],
            category=value["category"],
            text=value["text"],
        )
    except (KeyError, TypeError, ValueError):
        raise _invalid_context() from None


def _candidate_from_payload(payload: object) -> CandidateContext:
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise _invalid_context()
    try:
        direct_items = payload["direct_fields"]
        if not isinstance(direct_items, list):
            raise TypeError
        direct_fields = dict(direct_items)
        if any(
            not isinstance(name, str) or not isinstance(value, str)
            for name, value in direct_fields.items()
        ):
            raise TypeError
        resume_text = payload["resume_text"]
        context_values = payload["context_sources"]
        anecdote_values = payload["anecdotes"]
        if (
            not isinstance(resume_text, str)
            or not isinstance(context_values, list)
            or not isinstance(anecdote_values, list)
        ):
            raise TypeError
        return CandidateContext(
            direct_fields=MappingProxyType(direct_fields),
            resume_text=resume_text,
            profile_narrative=_source_from_payload(payload["profile_narrative"]),
            context_sources=tuple(
                _source_from_payload(value) for value in context_values
            ),
            anecdotes=tuple(
                _source_from_payload(value) for value in anecdote_values
            ),
        )
    except (HarnessServiceError, KeyError, TypeError, ValueError):
        raise _invalid_context() from None


class CandidateContextProcess:
    """Extract candidate evidence in a killable subprocess."""

    def __init__(self, artifacts: StoredCandidateArtifacts) -> None:
        context = mp.get_context("spawn")
        receiver, sender = context.Pipe(duplex=False)
        process = context.Process(
            target=_candidate_context_worker,
            args=(artifacts, sender),
            name="jobhunter-candidate-context",
            daemon=True,
        )
        try:
            process.start()
        except Exception:
            receiver.close()
            sender.close()
            raise _invalid_context() from None
        sender.close()
        self._receiver = receiver
        self._process = process
        self._receive_task: asyncio.Task[object] | None = None
        self._closed = False

    async def result(self) -> CandidateContext:
        if self._closed:
            raise _invalid_context()
        if self._receive_task is None:
            self._receive_task = asyncio.create_task(
                asyncio.to_thread(self._receiver.recv)
            )
        try:
            payload = await asyncio.shield(self._receive_task)
        except (EOFError, OSError):
            raise _invalid_context() from None
        await self._join_or_terminate()
        return _candidate_from_payload(payload)

    async def terminate(self) -> None:
        if self._closed:
            return
        if self._process.is_alive():
            self._process.terminate()
        self._receiver.close()
        if self._receive_task is not None:
            try:
                await asyncio.shield(self._receive_task)
            except (EOFError, OSError):
                pass
        await self._join_or_terminate()

    async def _join_or_terminate(self) -> None:
        if self._closed:
            return
        await asyncio.to_thread(self._process.join, 5)
        if self._process.is_alive():
            self._process.kill()
            await asyncio.to_thread(self._process.join, 5)
        self._receiver.close()
        self._process.close()
        self._closed = True
