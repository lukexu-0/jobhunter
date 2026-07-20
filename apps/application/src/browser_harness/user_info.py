from __future__ import annotations

import asyncio
import json
import os
import re
import stat
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final

from .browser import BrowserConfigurationError
from .models import (
    AcceptedAdditionalInfoAnswer,
    AdditionalInfoBooleanCommandAnswer,
    AdditionalInfoBooleanQuestion,
    AdditionalInfoCommandAnswer,
    AdditionalInfoDeclinedCommandAnswer,
    AdditionalInfoMultiSelectCommandAnswer,
    AdditionalInfoMultiSelectQuestion,
    AdditionalInfoQuestion,
    AdditionalInfoSingleSelectCommandAnswer,
    AdditionalInfoSingleSelectQuestion,
    AdditionalInfoTextCommandAnswer,
    AdditionalInfoTextQuestion,
    HarnessServiceError,
    validate_job_url,
)

_MAX_DOCUMENT_BYTES: Final = 8 * 1024 * 1024
_MAX_GLOBAL_FACTS: Final = 200
_MAX_APPLICATIONS: Final = 1_000
_MAX_APPLICATION_FACTS: Final = 100
_MAX_PROJECTION_BYTES: Final = 64 * 1024
_MAX_SNAPSHOT_BYTES: Final = 128 * 1024
_KEY_PATTERN: Final = re.compile(
    r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$"
)
_TIMESTAMP_PATTERN: Final = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$"
)
_EMPTY_DOCUMENT_BYTES: Final = b'{"version":1,"global":{},"applications":{}}'
_ANSWER_TYPES: Final = frozenset(
    {"text", "boolean", "single_select", "multi_select"}
)
_STATUSES: Final = frozenset({"answered", "declined"})


@dataclass(frozen=True, slots=True)
class SavedUserInfoFact:
    answer_type: str
    status: str
    value: str | bool | tuple[str, ...] | None = None

    def as_task_value(self) -> dict[str, object]:
        result: dict[str, object] = {
            "answer_type": self.answer_type,
            "status": self.status,
        }
        if self.status == "answered":
            result["value"] = list(self.value) if isinstance(self.value, tuple) else self.value
        return result


@dataclass(frozen=True, slots=True)
class UserInfoSnapshot:
    saved_global: Mapping[str, SavedUserInfoFact]
    saved_application: Mapping[str, SavedUserInfoFact]

    def as_task_payload(self) -> dict[str, dict[str, dict[str, object]]]:
        return {
            "saved_global": {
                key: fact.as_task_value() for key, fact in self.saved_global.items()
            },
            "saved_application": {
                key: fact.as_task_value()
                for key, fact in self.saved_application.items()
            },
        }


@dataclass(frozen=True, slots=True)
class _StoredFact:
    saved: SavedUserInfoFact
    question: str
    updated_at: str

    def as_disk_value(self) -> dict[str, object]:
        value = self.saved.as_task_value()
        value["question"] = self.question
        value["updated_at"] = self.updated_at
        return value


@dataclass(slots=True)
class _Document:
    global_facts: dict[str, _StoredFact]
    applications: dict[str, dict[str, _StoredFact]]

    def as_disk_value(self) -> dict[str, object]:
        return {
            "version": 1,
            "global": {
                key: fact.as_disk_value() for key, fact in self.global_facts.items()
            },
            "applications": {
                job_url: {
                    key: fact.as_disk_value() for key, fact in facts.items()
                }
                for job_url, facts in self.applications.items()
            },
        }


class UserInfoStore:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()
        self._initialize()

    def snapshot(self, job_url: str) -> UserInfoSnapshot:
        validated_job_url = validate_job_url(job_url)
        try:
            document = self._read_document()
        except Exception as error:
            if isinstance(error, HarnessServiceError):
                raise
            raise _internal_error() from None
        return UserInfoSnapshot(
            saved_global=_freeze_projection(document.global_facts),
            saved_application=_freeze_projection(
                document.applications.get(validated_job_url, {})
            ),
        )

    async def merge(
        self,
        job_url: str,
        questions: Sequence[AdditionalInfoQuestion],
        answers: Sequence[AdditionalInfoCommandAnswer],
    ) -> tuple[AcceptedAdditionalInfoAnswer, ...]:
        try:
            validated_job_url = validate_job_url(job_url)
        except (TypeError, ValueError):
            raise _conflict_error() from None
        accepted, replacements = _accept_answers(questions, answers)
        async with self._lock:
            try:
                current = self._read_document()
            except Exception:
                raise _internal_error() from None

            candidate = _copy_document(current)
            for question, stored in replacements:
                destination = (
                    candidate.global_facts
                    if question.scope == "global"
                    else candidate.applications.setdefault(validated_job_url, {})
                )
                destination[question.key] = stored
            try:
                encoded = _encode_and_validate_document(candidate)
            except (TypeError, ValueError):
                raise _conflict_error() from None
            try:
                self._replace(encoded)
            except HarnessServiceError:
                raise
            except Exception:
                raise _internal_error() from None
        return accepted

    def _initialize(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            if self._path.is_symlink():
                raise BrowserConfigurationError(
                    "The user information store must not be a symbolic link"
                )
            if not self._path.exists():
                self._create_empty_store()
            _require_regular_file(self._path)
            os.chmod(self._path, 0o600, follow_symlinks=False)
            self._read_document()
        except BrowserConfigurationError:
            raise
        except Exception:
            raise BrowserConfigurationError(
                "The user information store is invalid or unavailable"
            ) from None

    def _create_empty_store(self) -> None:
        fd = os.open(
            self._path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _no_follow_flag(),
            0o600,
        )
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb", closefd=True) as target:
                fd = -1
                target.write(_EMPTY_DOCUMENT_BYTES)
                target.flush()
                os.fsync(target.fileno())
            _fsync_directory(self._path.parent)
        finally:
            if fd >= 0:
                os.close(fd)

    def _read_document(self) -> _Document:
        if self._path.is_symlink():
            raise ValueError("symbolic link")
        _require_regular_file(self._path)
        with self._path.open("rb") as source:
            encoded = source.read(_MAX_DOCUMENT_BYTES + 1)
        if len(encoded) > _MAX_DOCUMENT_BYTES:
            raise ValueError("document is too large")
        try:
            raw = json.loads(
                encoded,
                object_pairs_hook=_unique_object,
                parse_constant=_reject_json_constant,
            )
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("document is not valid JSON") from None
        document = _parse_document(raw)
        _validate_document_bounds(document, encoded_size=len(encoded))
        return document

    def _replace(self, encoded: bytes) -> None:
        temp_path: Path | None = None
        replaced = False
        fd = -1
        try:
            fd, temp_name = tempfile.mkstemp(
                dir=self._path.parent,
                prefix=f".{self._path.name}.",
                suffix=".tmp",
            )
            temp_path = Path(temp_name)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb", closefd=True) as target:
                fd = -1
                target.write(encoded)
                target.flush()
                os.fsync(target.fileno())
            if self._path.is_symlink():
                raise OSError("user information target became a symbolic link")
            _require_regular_file(self._path)
            os.replace(temp_path, self._path)
            replaced = True
            temp_path = None
            _fsync_directory(self._path.parent)
        except Exception:
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
                fd = -1
            if temp_path is not None:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise _internal_error() from None
        finally:
            if fd >= 0:
                os.close(fd)
            if replaced:
                # The exclusive temporary file already carried this mode; enforce it
                # after replace as a defense against platform-specific umask behavior.
                try:
                    os.chmod(self._path, 0o600, follow_symlinks=False)
                except OSError:
                    pass


def _accept_answers(
    questions: Sequence[AdditionalInfoQuestion],
    answers: Sequence[AdditionalInfoCommandAnswer],
) -> tuple[
    tuple[AcceptedAdditionalInfoAnswer, ...],
    tuple[tuple[AdditionalInfoQuestion, _StoredFact], ...],
]:
    if not 1 <= len(questions) <= 20 or len(answers) != len(questions):
        raise _conflict_error()
    question_by_id: dict[str, AdditionalInfoQuestion] = {}
    scoped_keys: set[tuple[str, str]] = set()
    for question in questions:
        if question.id in question_by_id or (question.scope, question.key) in scoped_keys:
            raise _conflict_error()
        question_by_id[question.id] = question
        scoped_keys.add((question.scope, question.key))
    answer_by_id: dict[str, AdditionalInfoCommandAnswer] = {}
    for answer in answers:
        if answer.id in answer_by_id or answer.id not in question_by_id:
            raise _conflict_error()
        answer_by_id[answer.id] = answer
    if set(answer_by_id) != set(question_by_id):
        raise _conflict_error()

    timestamp = _utc_timestamp()
    accepted: list[AcceptedAdditionalInfoAnswer] = []
    replacements: list[tuple[AdditionalInfoQuestion, _StoredFact]] = []
    for question in questions:
        answer = answer_by_id[question.id]
        semantic_value = _semantic_value(question, answer)
        response_value = (
            list(semantic_value)
            if isinstance(semantic_value, tuple)
            else semantic_value
        )
        accepted_answer = AcceptedAdditionalInfoAnswer(
            id=question.id,
            key=question.key,
            scope=question.scope,
            answer_type=question.answer_type,
            status=answer.status,
            **({"value": response_value} if answer.status == "answered" else {}),
        )
        accepted.append(accepted_answer)
        replacements.append(
            (
                question,
                _StoredFact(
                    saved=SavedUserInfoFact(
                        answer_type=question.answer_type,
                        status=answer.status,
                        value=semantic_value,
                    ),
                    question=question.question,
                    updated_at=timestamp,
                ),
            )
        )
    return tuple(accepted), tuple(replacements)


def _semantic_value(
    question: AdditionalInfoQuestion,
    answer: AdditionalInfoCommandAnswer,
) -> str | bool | tuple[str, ...] | None:
    if isinstance(answer, AdditionalInfoDeclinedCommandAnswer):
        return None
    if isinstance(question, AdditionalInfoTextQuestion) and isinstance(
        answer, AdditionalInfoTextCommandAnswer
    ):
        return answer.value
    if isinstance(question, AdditionalInfoBooleanQuestion) and isinstance(
        answer, AdditionalInfoBooleanCommandAnswer
    ):
        return answer.value
    if isinstance(question, AdditionalInfoSingleSelectQuestion) and isinstance(
        answer, AdditionalInfoSingleSelectCommandAnswer
    ):
        options = {option.id: option.label for option in question.options}
        if answer.option_id not in options:
            raise _conflict_error()
        return options[answer.option_id]
    if isinstance(question, AdditionalInfoMultiSelectQuestion) and isinstance(
        answer, AdditionalInfoMultiSelectCommandAnswer
    ):
        options = {option.id: option.label for option in question.options}
        if any(option_id not in options for option_id in answer.option_ids):
            raise _conflict_error()
        return tuple(options[option_id] for option_id in answer.option_ids)
    raise _conflict_error()


def _parse_document(raw: object) -> _Document:
    if not isinstance(raw, dict) or set(raw) != {"version", "global", "applications"}:
        raise ValueError("invalid root")
    if type(raw["version"]) is not int or raw["version"] != 1:
        raise ValueError("unsupported version")
    global_facts = _parse_fact_map(raw["global"], maximum=_MAX_GLOBAL_FACTS)
    applications_raw = raw["applications"]
    if not isinstance(applications_raw, dict) or len(applications_raw) > _MAX_APPLICATIONS:
        raise ValueError("invalid applications")
    applications: dict[str, dict[str, _StoredFact]] = {}
    for job_url, facts in applications_raw.items():
        if not isinstance(job_url, str) or validate_job_url(job_url) != job_url:
            raise ValueError("invalid application URL")
        applications[job_url] = _parse_fact_map(
            facts,
            maximum=_MAX_APPLICATION_FACTS,
        )
    return _Document(global_facts=global_facts, applications=applications)


def _parse_fact_map(raw: object, *, maximum: int) -> dict[str, _StoredFact]:
    if not isinstance(raw, dict) or len(raw) > maximum:
        raise ValueError("invalid fact map")
    facts: dict[str, _StoredFact] = {}
    for key, value in raw.items():
        if (
            not isinstance(key, str)
            or len(key) > 100
            or _KEY_PATTERN.fullmatch(key) is None
        ):
            raise ValueError("invalid fact key")
        facts[key] = _parse_fact(value)
    return facts


def _parse_fact(raw: object) -> _StoredFact:
    if not isinstance(raw, dict):
        raise ValueError("invalid fact")
    answer_type = raw.get("answer_type")
    status_value = raw.get("status")
    if answer_type not in _ANSWER_TYPES or status_value not in _STATUSES:
        raise ValueError("invalid fact type or status")
    status = str(status_value)
    expected = {"answer_type", "status", "question", "updated_at"}
    if status == "answered":
        expected.add("value")
    if set(raw) != expected:
        raise ValueError("invalid fact fields")
    question = raw["question"]
    if (
        not isinstance(question, str)
        or not question.strip()
        or question != question.strip()
        or len(question) > 500
    ):
        raise ValueError("invalid fact question")
    updated_at = raw["updated_at"]
    if not isinstance(updated_at, str) or not _valid_utc_timestamp(updated_at):
        raise ValueError("invalid fact timestamp")
    semantic_value = None
    if status == "answered":
        semantic_value = _validate_saved_value(str(answer_type), raw["value"])
    return _StoredFact(
        saved=SavedUserInfoFact(
            answer_type=str(answer_type),
            status=status,
            value=semantic_value,
        ),
        question=question,
        updated_at=updated_at,
    )


def _validate_saved_value(
    answer_type: str,
    value: object,
) -> str | bool | tuple[str, ...]:
    if answer_type == "boolean":
        if type(value) is not bool:
            raise ValueError("invalid boolean value")
        return value
    if answer_type == "text":
        if (
            not isinstance(value, str)
            or value != value.strip()
            or not 1 <= len(value) <= 2_000
        ):
            raise ValueError("invalid text value")
        return value
    if answer_type == "single_select":
        if (
            not isinstance(value, str)
            or value != value.strip()
            or not 1 <= len(value) <= 200
        ):
            raise ValueError("invalid select value")
        return value
    if (
        not isinstance(value, list)
        or not 1 <= len(value) <= 20
        or any(
            not isinstance(item, str)
            or item != item.strip()
            or not 1 <= len(item) <= 200
            for item in value
        )
    ):
        raise ValueError("invalid multi-select value")
    return tuple(value)


def _validate_document_bounds(document: _Document, *, encoded_size: int) -> None:
    if encoded_size > _MAX_DOCUMENT_BYTES:
        raise ValueError("document is too large")
    _validate_projection(document.global_facts, {})
    for application in document.applications.values():
        _validate_projection(document.global_facts, application)


def _validate_projection(
    global_facts: Mapping[str, _StoredFact],
    application_facts: Mapping[str, _StoredFact],
) -> None:
    saved_global = _projection(global_facts)
    saved_application = _projection(application_facts)
    if len(_compact_json(saved_global)) > _MAX_PROJECTION_BYTES:
        raise ValueError("global projection is too large")
    if len(_compact_json(saved_application)) > _MAX_PROJECTION_BYTES:
        raise ValueError("application projection is too large")
    wrapper = {
        "saved_global": saved_global,
        "saved_application": saved_application,
    }
    if len(_compact_json(wrapper)) > _MAX_SNAPSHOT_BYTES:
        raise ValueError("snapshot projection is too large")


def _encode_and_validate_document(document: _Document) -> bytes:
    if len(document.global_facts) > _MAX_GLOBAL_FACTS:
        raise ValueError("too many global facts")
    if len(document.applications) > _MAX_APPLICATIONS:
        raise ValueError("too many applications")
    if any(len(facts) > _MAX_APPLICATION_FACTS for facts in document.applications.values()):
        raise ValueError("too many application facts")
    encoded = _compact_json(document.as_disk_value())
    _validate_document_bounds(document, encoded_size=len(encoded))
    return encoded


def _projection(facts: Mapping[str, _StoredFact]) -> dict[str, dict[str, object]]:
    return {key: fact.saved.as_task_value() for key, fact in facts.items()}


def _freeze_projection(
    facts: Mapping[str, _StoredFact],
) -> Mapping[str, SavedUserInfoFact]:
    return MappingProxyType({key: fact.saved for key, fact in facts.items()})


def _copy_document(document: _Document) -> _Document:
    return _Document(
        global_facts=dict(document.global_facts),
        applications={
            job_url: dict(facts) for job_url, facts in document.applications.items()
        },
    )


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> object:
    raise ValueError(f"invalid JSON constant: {value}")


def _compact_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _utc_timestamp() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _valid_utc_timestamp(value: str) -> bool:
    if _TIMESTAMP_PATTERN.fullmatch(value) is None:
        return False
    try:
        parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() == timezone.utc.utcoffset(None)


def _require_regular_file(path: Path) -> None:
    mode = path.lstat().st_mode
    if not stat.S_ISREG(mode):
        raise ValueError("not a regular file")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _no_follow_flag() -> int:
    return getattr(os, "O_NOFOLLOW", 0)


def _conflict_error() -> HarnessServiceError:
    return HarnessServiceError(
        409,
        "command_conflict",
        "Additional information cannot be saved",
    )


def _internal_error() -> HarnessServiceError:
    return HarnessServiceError(500, "internal_error", "Request failed")
