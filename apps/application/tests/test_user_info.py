from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

import jobhunter_browser_harness.user_info as user_info_module
from jobhunter_browser_harness.playwright_cli import BrowserConfigurationError
from jobhunter_browser_harness.models import (
    AdditionalInfoOption,
    AdditionalInfoDeclinedCommandAnswer,
    AdditionalInfoSingleSelectCommandAnswer,
    AdditionalInfoSingleSelectQuestion,
    AdditionalInfoTextCommandAnswer,
    AdditionalInfoTextQuestion,
    HarnessServiceError,
    validate_job_url,
)
from jobhunter_browser_harness.user_info import UserInfoStore


JOB_URL = "https://jobs.example.test/roles/42"
EMPTY_DOCUMENT = {"version": 2, "global": {}, "applications": {}}


def test_missing_store_is_created_private_and_snapshots_are_empty(tmp_path: Path) -> None:
    path = tmp_path / "private" / "user-info.json"

    store = UserInfoStore(path)

    assert json.loads(path.read_text(encoding="utf-8")) == EMPTY_DOCUMENT
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    snapshot = store.snapshot(JOB_URL)
    assert dict(snapshot.saved_global) == {}
    assert dict(snapshot.saved_application) == {}


def test_snapshot_loads_only_task_projection_for_exact_job(tmp_path: Path) -> None:
    other_job = "https://jobs.example.test/roles/99"
    path = tmp_path / "user-info.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "global": {
                    "availability.summer_2027": {
                        "answer_type": "text",
                        "status": "answered",
                        "question": "What dates are you available?",
                        "value": "June through August 2027",
                        "updated_at": "2026-07-19T12:34:56.000Z",
                    }
                },
                "applications": {
                    JOB_URL: {
                        "referral.source": {
                            "answer_type": "single_select",
                            "status": "declined",
                            "question": "How did you hear about this position?",
                            "updated_at": "2026-07-19T12:34:56.000Z",
                        }
                    },
                    other_job: {
                        "private.other_application": {
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

    snapshot = UserInfoStore(path).snapshot(validate_job_url(JOB_URL))

    assert snapshot.as_task_payload() == {
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
    }



async def test_v1_text_fact_is_read_and_next_write_migrates_every_fact_to_v2(
    tmp_path: Path,
) -> None:
    path = tmp_path / "user-info.json"
    _write_document(
        path,
        {
            "version": 1,
            "global": {
                "legacy.answer": {
                    "answer_type": "text",
                    "status": "answered",
                    "question": "Legacy question?",
                    "value": "Legacy answer",
                    "updated_at": "2026-07-19T12:34:56.000Z",
                }
            },
            "applications": {},
        },
    )
    store = UserInfoStore(path)

    await store.merge(
        JOB_URL,
        (
            AdditionalInfoTextQuestion(
                id="current_answer",
                key="current.answer",
                scope="application",
                question="Current question?",
                answer_type="text",
            ),
        ),
        (
            AdditionalInfoTextCommandAnswer(
                id="current_answer",
                status="answered",
                raw_value="Loose current thoughts",
                value="Professional current answer.",
            ),
        ),
    )

    disk = json.loads(path.read_text(encoding="utf-8"))
    assert disk["version"] == 2
    assert disk["global"]["legacy.answer"] == {
        "answer_type": "text",
        "status": "answered",
        "question": "Legacy question?",
        "raw_value": "Legacy answer",
        "sanitized_value": "Legacy answer",
        "updated_at": "2026-07-19T12:34:56.000Z",
    }
    assert disk["applications"][JOB_URL]["current.answer"] == {
        "answer_type": "text",
        "status": "answered",
        "question": "Current question?",
        "raw_value": "Loose current thoughts",
        "sanitized_value": "Professional current answer.",
        "updated_at": disk["applications"][JOB_URL]["current.answer"]["updated_at"],
    }
    snapshot = store.snapshot(JOB_URL)
    assert snapshot.raw_text_values == frozenset(
        {"Legacy answer", "Loose current thoughts"}
    )
    assert snapshot.as_task_payload()["saved_application"] == {
        "current.answer": {
            "answer_type": "text",
            "status": "answered",
            "value": "Professional current answer.",
        }
    }


async def test_merge_persists_global_and_exact_application_facts(
    tmp_path: Path,
) -> None:
    path = tmp_path / "user-info.json"
    store = UserInfoStore(path)
    questions = (
        AdditionalInfoTextQuestion(
            id="summer_availability",
            key="availability.summer_2027",
            scope="global",
            question="What dates are you available in Summer 2027?",
            answer_type="text",
        ),
        AdditionalInfoSingleSelectQuestion(
            id="referral_source",
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
    answers = (
        AdditionalInfoTextCommandAnswer(
            id="summer_availability",
            status="answered",
            raw_value="free june aug",
            value="June through August 2027",
        ),
        AdditionalInfoSingleSelectCommandAnswer(
            id="referral_source",
            status="answered",
            option_id="friend",
        ),
    )

    accepted = await store.merge(JOB_URL, questions, answers)

    assert [
        answer.model_dump(mode="json", exclude_none=True) for answer in accepted
    ] == [
        {
            "id": "summer_availability",
            "key": "availability.summer_2027",
            "scope": "global",
            "answer_type": "text",
            "status": "answered",
            "value": "June through August 2027",
        },
        {
            "id": "referral_source",
            "key": "referral.source",
            "scope": "application",
            "answer_type": "single_select",
            "status": "answered",
            "value": "A friend",
        },
    ]
    snapshot = store.snapshot(JOB_URL).as_task_payload()
    assert snapshot == {
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
                "status": "answered",
                "value": "A friend",
            }
        },
    }
    disk = json.loads(path.read_text(encoding="utf-8"))
    assert disk["version"] == 2
    stored_text = disk["global"]["availability.summer_2027"]
    assert stored_text["question"] == questions[0].question
    assert stored_text["raw_value"] == "free june aug"
    assert stored_text["sanitized_value"] == "June through August 2027"
    assert "value" not in stored_text
    assert disk["applications"][JOB_URL]["referral.source"]["value"] == "A friend"
    assert "options" not in json.dumps(disk)


def test_suggestions_rank_exact_key_then_recency_deduplicate_and_exclude_other_jobs(
    tmp_path: Path,
) -> None:
    path = tmp_path / "user-info.json"

    def text_fact(
        question: str,
        raw_value: str,
        sanitized_value: str,
        updated_at: str,
    ) -> dict[str, object]:
        return {
            "answer_type": "text",
            "status": "answered",
            "question": question,
            "raw_value": raw_value,
            "sanitized_value": sanitized_value,
            "updated_at": updated_at,
        }

    _write_document(
        path,
        {
            "version": 2,
            "global": {
                "target.answer": text_fact(
                    "Global exact question?",
                    "global exact raw secret",
                    "Repeated answer",
                    "2026-07-19T09:00:00Z",
                ),
                "unrelated.newest": text_fact(
                    "Newest source?",
                    "newest raw secret",
                    "Newest unrelated",
                    "2026-07-19T15:00:00Z",
                ),
                "unrelated.duplicate": text_fact(
                    "Duplicate source?",
                    "duplicate raw secret",
                    "Repeated answer",
                    "2026-07-19T16:00:00Z",
                ),
                "unrelated.third": text_fact(
                    "Third source?",
                    "third raw secret",
                    "Third",
                    "2026-07-19T14:00:00Z",
                ),
                "unrelated.fourth": text_fact(
                    "Fourth source?",
                    "fourth raw secret",
                    "Fourth",
                    "2026-07-19T13:00:00Z",
                ),
                "unrelated.boolean": {
                    "answer_type": "boolean",
                    "status": "answered",
                    "question": "Boolean source?",
                    "value": True,
                    "updated_at": "2026-07-19T18:00:00Z",
                },
                "unrelated.declined": {
                    "answer_type": "text",
                    "status": "declined",
                    "question": "Declined source?",
                    "updated_at": "2026-07-19T19:00:00Z",
                },
            },
            "applications": {
                JOB_URL: {
                    "target.answer": text_fact(
                        "Application exact question?",
                        "application exact raw secret",
                        "Application exact",
                        "2026-07-19T10:00:00Z",
                    ),
                    "unrelated.older": text_fact(
                        "Older source?",
                        "older raw secret",
                        "Older",
                        "2026-07-19T12:00:00Z",
                    ),
                },
                "https://jobs.example.test/roles/99": {
                    "target.answer": text_fact(
                        "Other job question?",
                        "other job raw secret",
                        "Other job answer",
                        "2026-07-19T17:00:00Z",
                    )
                },
            },
        },
    )
    question = AdditionalInfoTextQuestion(
        id="pending_answer",
        key="target.answer",
        scope="application",
        question="Pending question?",
        answer_type="text",
    )

    suggestions = UserInfoStore(path).suggestions(JOB_URL, question)

    assert [suggestion.model_dump() for suggestion in suggestions] == [
        {
            "question": "Application exact question?",
            "answer": "Application exact",
        },
        {"question": "Global exact question?", "answer": "Repeated answer"},
        {"question": "Newest source?", "answer": "Newest unrelated"},
        {"question": "Third source?", "answer": "Third"},
        {"question": "Fourth source?", "answer": "Fourth"},
    ]
    serialized = json.dumps(
        [suggestion.model_dump() for suggestion in suggestions]
    )
    for private_value in (
        "raw secret",
        "target.answer",
        JOB_URL,
        "Other job answer",
        "Duplicate source?",
    ):
        assert private_value not in serialized


def _stored_fact(
    *,
    answer_type: str = "text",
    status: str = "answered",
    value: object = "value",
) -> dict[str, object]:
    fact: dict[str, object] = {
        "answer_type": answer_type,
        "status": status,
        "question": "Stored question?",
        "updated_at": "2026-07-19T12:34:56.000Z",
    }
    if status == "answered":
        fact["value"] = value
    return fact


def _document(
    *,
    global_facts: dict[str, object] | None = None,
    applications: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "version": 1,
        "global": {} if global_facts is None else global_facts,
        "applications": {} if applications is None else applications,
    }


def _write_document(path: Path, document: object) -> None:
    path.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


@pytest.mark.parametrize(
    "document",
    [
        {},
        {"version": 3, "global": {}, "applications": {}},
        {"version": 1, "global": {}, "applications": {}, "extra": True},
        {
            "version": 2,
            "global": {"valid": _stored_fact(value="legacy-only-value")},
            "applications": {},
        },
        _document(global_facts={"Bad.Key": _stored_fact()}),
        _document(global_facts={"bad..key": _stored_fact()}),
        _document(global_facts={"a" * 101: _stored_fact()}),
        _document(global_facts={"valid": _stored_fact(status="unknown")}),
        _document(global_facts={"valid": _stored_fact(answer_type="unknown")}),
        _document(global_facts={"valid": _stored_fact(value=True)}),
        _document(
            global_facts={
                "valid": _stored_fact(answer_type="boolean", value="true")
            }
        ),
        _document(
            global_facts={
                "valid": {
                    **_stored_fact(),
                    "question": " ",
                }
            }
        ),
        _document(
            global_facts={
                "valid": {
                    **_stored_fact(),
                    "updated_at": "2026-07-19T12:34:56+00:00",
                }
            }
        ),
        _document(
            global_facts={
                "valid": {
                    **_stored_fact(status="declined"),
                    "value": "must be absent",
                }
            }
        ),
        _document(applications={"https://example.test/#fragment": {}}),
    ],
    ids=[
        "missing-root-fields",
        "unknown-version",
        "extra-root-field",
        "v2-text-with-v1-value",
        "uppercase-key",
        "empty-key-segment",
        "oversized-key",
        "unknown-status",
        "unknown-answer-type",
        "wrong-text-type",
        "wrong-boolean-type",
        "blank-question",
        "non-z-timestamp",
        "declined-with-value",
        "invalid-application-url",
    ],
)
def test_startup_rejects_malformed_documents(
    tmp_path: Path,
    document: object,
) -> None:
    path = tmp_path / "user-info.json"
    _write_document(path, document)

    with pytest.raises(BrowserConfigurationError):
        UserInfoStore(path)


@pytest.mark.parametrize(
    "raw",
    [
        b'{"version":1,"version":1,"global":{},"applications":{}}',
        b'{"version":1,"global":{"value":NaN},"applications":{}}',
        b'{"version":1,"global":{},"applications":{}}\xff',
    ],
    ids=["duplicate-key", "non-finite", "invalid-utf8"],
)
def test_startup_rejects_non_strict_json(tmp_path: Path, raw: bytes) -> None:
    path = tmp_path / "user-info.json"
    path.write_bytes(raw)

    with pytest.raises(BrowserConfigurationError):
        UserInfoStore(path)


def test_startup_rejects_symlink_and_non_regular_targets(tmp_path: Path) -> None:
    target = tmp_path / "target.json"
    target.write_bytes(b"{}")
    symlink = tmp_path / "symlink.json"
    symlink.symlink_to(target)
    directory = tmp_path / "directory.json"
    directory.mkdir()

    with pytest.raises(BrowserConfigurationError):
        UserInfoStore(symlink)
    with pytest.raises(BrowserConfigurationError):
        UserInfoStore(directory)


def test_startup_rejects_store_beneath_symlinked_parent(tmp_path: Path) -> None:
    actual_parent = tmp_path / "actual-parent"
    actual_parent.mkdir()
    symlinked_parent = tmp_path / "symlinked-parent"
    symlinked_parent.symlink_to(actual_parent, target_is_directory=True)
    path = symlinked_parent / "private" / "user-info.json"

    with pytest.raises(BrowserConfigurationError) as raised:
        UserInfoStore(path)

    assert str(raised.value) == "The user information store is invalid or unavailable"
    assert not (actual_parent / "private" / "user-info.json").exists()


def test_startup_rejects_store_beneath_world_writable_immediate_parent(
    tmp_path: Path,
) -> None:
    unsafe_parent = tmp_path / "unsafe-parent"
    unsafe_parent.mkdir()
    unsafe_parent.chmod(0o777)
    path = unsafe_parent / "user-info.json"

    with pytest.raises(BrowserConfigurationError) as raised:
        UserInfoStore(path)

    assert str(raised.value) == "The user information store is invalid or unavailable"
    assert not path.exists()


def test_startup_rejects_store_beneath_group_writable_immediate_parent(
    tmp_path: Path,
) -> None:
    unsafe_parent = tmp_path / "unsafe-parent"
    unsafe_parent.mkdir()
    unsafe_parent.chmod(0o770)
    assert stat.S_IMODE(unsafe_parent.stat().st_mode) == 0o770
    path = unsafe_parent / "user-info.json"

    with pytest.raises(BrowserConfigurationError) as raised:
        UserInfoStore(path)

    assert str(raised.value) == "The user information store is invalid or unavailable"
    assert not path.exists()


def _compact_size(value: object) -> int:
    return len(
        json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    )


def _task_projection(facts: dict[str, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, raw in facts.items():
        assert isinstance(raw, dict)
        fact = {
            "answer_type": raw["answer_type"],
            "status": raw["status"],
        }
        if raw["status"] == "answered":
            fact["value"] = raw["value"]
        result[key] = fact
    return result


def _fact_map_for_projection_size(
    target: int,
    *,
    prefix: str,
) -> dict[str, object]:
    for count in range(1, 101):
        values = ["x" * 1_500 for _ in range(count - 1)] + ["x"]
        task_map = {
            f"{prefix}.fact_{index}": {
                "answer_type": "text",
                "status": "answered",
                "value": value,
            }
            for index, value in enumerate(values)
        }
        missing = target - _compact_size(task_map)
        if 0 <= missing <= 1_999:
            values[-1] += "x" * missing
            disk_map = {
                f"{prefix}.fact_{index}": _stored_fact(value=value)
                for index, value in enumerate(values)
            }
            assert _compact_size(_task_projection(disk_map)) == target
            return disk_map
    raise AssertionError(f"could not construct a {target}-byte projection")


@pytest.mark.parametrize(
    ("scope", "size", "valid"),
    [
        ("global", 64 * 1024, True),
        ("global", 64 * 1024 + 1, False),
        ("application", 64 * 1024, True),
        ("application", 64 * 1024 + 1, False),
    ],
)
def test_individual_projection_bounds(
    tmp_path: Path,
    scope: str,
    size: int,
    valid: bool,
) -> None:
    path = tmp_path / f"{scope}-{size}.json"
    facts = _fact_map_for_projection_size(size, prefix=scope[0])
    document = (
        _document(global_facts=facts)
        if scope == "global"
        else _document(applications={JOB_URL: facts})
    )
    _write_document(path, document)

    if valid:
        UserInfoStore(path)
    else:
        with pytest.raises(BrowserConfigurationError):
            UserInfoStore(path)


@pytest.mark.parametrize("extra", [0, 1], ids=["at-limit", "beyond-limit"])
def test_complete_saved_snapshot_wrapper_bound(
    tmp_path: Path,
    extra: int,
) -> None:
    global_facts = _fact_map_for_projection_size(64 * 1024, prefix="g")
    saved_global = _task_projection(global_facts)
    wrapper_overhead = (
        _compact_size(
            {
                "saved_global": saved_global,
                "saved_application": {},
            }
        )
        - _compact_size(saved_global)
        - _compact_size({})
    )
    application_size = (
        128 * 1024
        - wrapper_overhead
        - _compact_size(saved_global)
        + extra
    )
    application_facts = _fact_map_for_projection_size(
        application_size,
        prefix="a",
    )
    wrapper = {
        "saved_global": saved_global,
        "saved_application": _task_projection(application_facts),
    }
    assert _compact_size(wrapper) == 128 * 1024 + extra
    path = tmp_path / f"wrapper-{extra}.json"
    _write_document(
        path,
        _document(
            global_facts=global_facts,
            applications={JOB_URL: application_facts},
        ),
    )

    if extra == 0:
        UserInfoStore(path)
    else:
        with pytest.raises(BrowserConfigurationError):
            UserInfoStore(path)


def test_v1_document_byte_bound_accepts_limit_and_rejects_next_byte(
    tmp_path: Path,
) -> None:
    raw = json.dumps(
        {"version": 1, "global": {}, "applications": {}},
        separators=(",", ":"),
    ).encode("utf-8")
    for extra in (0, 1):
        path = tmp_path / f"document-{extra}.json"
        padding = b" " * (8 * 1024 * 1024 - len(raw) + extra)
        path.write_bytes(raw + padding)
        assert path.stat().st_size == 8 * 1024 * 1024 + extra
        if extra == 0:
            UserInfoStore(path)
        else:
            with pytest.raises(BrowserConfigurationError):
                UserInfoStore(path)


async def test_maximum_size_text_heavy_v1_document_migrates_on_next_write(
    tmp_path: Path,
) -> None:
    path = tmp_path / "user-info.json"
    legacy_fact = _stored_fact(value="😀" * 2_000)
    document = _document(
        applications={
            f"https://jobs.example.test/roles/{index}": {
                "legacy.answer": legacy_fact
            }
            for index in range(1_000)
        }
    )
    encoded = json.dumps(
        document,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    assert len(encoded) < 8 * 1024 * 1024
    path.write_bytes(encoded + b" " * (8 * 1024 * 1024 - len(encoded)))

    store = UserInfoStore(path)
    await store.merge(
        JOB_URL,
        (
            AdditionalInfoTextQuestion(
                id="current",
                key="current.answer",
                scope="global",
                question="Current answer?",
                answer_type="text",
            ),
        ),
        (
            AdditionalInfoTextCommandAnswer(
                id="current",
                status="answered",
                raw_value="current raw answer",
                value="Current final answer.",
            ),
        ),
    )

    assert path.stat().st_size > 8 * 1024 * 1024
    migrated = json.loads(path.read_text(encoding="utf-8"))
    assert migrated["version"] == 2
    first_legacy = migrated["applications"][
        "https://jobs.example.test/roles/0"
    ]["legacy.answer"]
    assert first_legacy["raw_value"] == "😀" * 2_000
    assert first_legacy["sanitized_value"] == "😀" * 2_000


@pytest.mark.parametrize("extra", [0, 1], ids=["at-limit", "beyond-limit"])
def test_v2_document_byte_bound_is_hard(
    tmp_path: Path,
    extra: int,
) -> None:
    old_document_limit = 8 * 1024 * 1024
    maximum_fact_count = 200 + 1_000 * 100
    added_text_key_overhead = 23
    v2_document_limit = (
        2 * old_document_limit
        + maximum_fact_count * added_text_key_overhead
    )
    raw = json.dumps(EMPTY_DOCUMENT, separators=(",", ":")).encode("utf-8")
    path = tmp_path / f"v2-document-{extra}.json"
    path.write_bytes(raw + b" " * (v2_document_limit - len(raw) + extra))

    if extra == 0:
        UserInfoStore(path)
    else:
        with pytest.raises(BrowserConfigurationError):
            UserInfoStore(path)


@pytest.mark.parametrize(
    "document",
    [
        _document(
            global_facts={
                f"global.fact_{index}": _stored_fact()
                for index in range(201)
            }
        ),
        _document(
            applications={
                JOB_URL: {
                    f"application.fact_{index}": _stored_fact()
                    for index in range(101)
                }
            }
        ),
        _document(
            applications={
                f"https://jobs.example.test/roles/{index}": {}
                for index in range(1_001)
            }
        ),
    ],
    ids=["global-count", "application-fact-count", "application-count"],
)
def test_document_count_bounds(tmp_path: Path, document: object) -> None:
    path = tmp_path / "count.json"
    _write_document(path, document)

    with pytest.raises(BrowserConfigurationError):
        UserInfoStore(path)


async def test_merge_rereads_and_preserves_external_valid_changes(
    tmp_path: Path,
) -> None:
    path = tmp_path / "user-info.json"
    store = UserInfoStore(path)
    _write_document(
        path,
        _document(
            applications={
                "https://jobs.example.test/roles/external": {
                    "external.fact": _stored_fact(value="preserved")
                }
            }
        ),
    )

    await store.merge(
        JOB_URL,
        (
            AdditionalInfoTextQuestion(
                id="answer",
                key="current.answer",
                scope="global",
                question="Current answer?",
                answer_type="text",
            ),
        ),
        (
            AdditionalInfoTextCommandAnswer(
                id="answer",
                status="answered",
                raw_value="accepted",
                value="accepted",
            ),
        ),
    )

    disk = json.loads(path.read_text(encoding="utf-8"))
    external = disk["applications"]["https://jobs.example.test/roles/external"][
        "external.fact"
    ]
    assert external["raw_value"] == "preserved"
    assert external["sanitized_value"] == "preserved"


async def test_merge_overwrites_only_the_exact_scoped_key_and_persists_decline(
    tmp_path: Path,
) -> None:
    path = tmp_path / "user-info.json"
    _write_document(
        path,
        _document(
            global_facts={"same.key": _stored_fact(value="global")},
            applications={
                JOB_URL: {"same.key": _stored_fact(value="application")},
            },
        ),
    )
    store = UserInfoStore(path)


    accepted = await store.merge(
        JOB_URL,
        (
            AdditionalInfoTextQuestion(
                id="decline",
                key="same.key",
                scope="application",
                question="Application-specific question?",
                answer_type="text",
            ),
        ),
        (AdditionalInfoDeclinedCommandAnswer(id="decline", status="declined"),),
    )

    assert accepted[0].model_dump(exclude_none=True) == {
        "id": "decline",
        "key": "same.key",
        "scope": "application",
        "answer_type": "text",
        "status": "declined",
    }
    disk = json.loads(path.read_text(encoding="utf-8"))
    assert disk["global"]["same.key"]["raw_value"] == "global"
    assert disk["global"]["same.key"]["sanitized_value"] == "global"
    assert "value" not in disk["applications"][JOB_URL]["same.key"]


async def test_temp_file_is_private_and_replace_failure_preserves_bytes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "user-info.json"
    store = UserInfoStore(path)
    previous = path.read_bytes()
    real_replace = user_info_module.os.replace
    observed_modes: list[int] = []

    def failing_replace(source: str | os.PathLike[str], destination: str | os.PathLike[str]) -> None:
        observed_modes.append(stat.S_IMODE(Path(source).stat().st_mode))
        raise OSError("replace failed")

    monkeypatch.setattr(user_info_module.os, "replace", failing_replace)
    question = AdditionalInfoTextQuestion(
        id="answer",
        key="atomic.answer",
        scope="global",
        question="Atomic answer?",
        answer_type="text",
    )
    answer = AdditionalInfoTextCommandAnswer(
        id="answer",
        status="answered",
        raw_value="private",
        value="private",
    )

    with pytest.raises(HarnessServiceError) as raised:
        await store.merge(JOB_URL, (question,), (answer,))

    assert raised.value.code == "internal_error"
    assert path.read_bytes() == previous
    assert observed_modes == [0o600]
    assert list(tmp_path.glob(".*.tmp")) == []
    monkeypatch.setattr(user_info_module.os, "replace", real_replace)


async def test_parent_fsync_failure_exposes_commit_and_identical_retry_succeeds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "user-info.json"
    store = UserInfoStore(path)
    previous = path.read_bytes()
    real_fsync = user_info_module.os.fsync
    calls = 0

    def fail_parent_fsync(descriptor: int) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("directory fsync failed")
        real_fsync(descriptor)

    monkeypatch.setattr(user_info_module.os, "fsync", fail_parent_fsync)
    question = AdditionalInfoTextQuestion(
        id="answer",
        key="durability.answer",
        scope="global",
        question="Durable answer?",
        answer_type="text",
    )
    answer = AdditionalInfoTextCommandAnswer(
        id="answer",
        status="answered",
        raw_value="committed",
        value="committed",
    )

    with pytest.raises(HarnessServiceError) as raised:
        await store.merge(JOB_URL, (question,), (answer,))

    assert raised.value.code == "internal_error"
    assert path.read_bytes() != previous
    assert (
        store.snapshot(JOB_URL)
        .as_task_payload()["saved_global"]["durability.answer"]["value"]
        == "committed"
    )

    monkeypatch.setattr(user_info_module.os, "fsync", real_fsync)
    accepted = await store.merge(JOB_URL, (question,), (answer,))
    assert accepted[0].value == "committed"


async def test_merge_projection_conflict_preserves_previous_bytes(
    tmp_path: Path,
) -> None:
    path = tmp_path / "user-info.json"
    _write_document(
        path,
        _document(
            global_facts=_fact_map_for_projection_size(64 * 1024, prefix="g")
        ),
    )
    store = UserInfoStore(path)
    previous = path.read_bytes()

    with pytest.raises(HarnessServiceError) as raised:
        await store.merge(
            JOB_URL,
            (
                AdditionalInfoTextQuestion(
                    id="new_answer",
                    key="new.answer",
                    scope="global",
                    question="New answer?",
                    answer_type="text",
                ),
            ),
            (
                AdditionalInfoTextCommandAnswer(
                    id="new_answer",
                    status="answered",
                    raw_value="x",
                    value="x",
                ),
            ),
        )

    assert raised.value.code == "command_conflict"
    assert path.read_bytes() == previous


@pytest.mark.asyncio
async def test_temp_mode_failure_closes_descriptor_and_preserves_bytes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "user-info.json"
    store = UserInfoStore(path)
    previous = path.read_bytes()
    descriptors: list[int] = []
    real_mkstemp = user_info_module.tempfile.mkstemp

    def capture_mkstemp(*args: object, **kwargs: object) -> tuple[int, str]:
        descriptor, name = real_mkstemp(*args, **kwargs)
        descriptors.append(descriptor)
        return descriptor, name

    def fail_fchmod(_descriptor: int, _mode: int) -> None:
        raise OSError("temp mode failed")

    monkeypatch.setattr(user_info_module.tempfile, "mkstemp", capture_mkstemp)
    monkeypatch.setattr(user_info_module.os, "fchmod", fail_fchmod)

    with pytest.raises(HarnessServiceError) as raised:
        await store.merge(
            JOB_URL,
            (
                AdditionalInfoTextQuestion(
                    id="answer",
                    key="mode.answer",
                    scope="global",
                    question="Mode answer?",
                    answer_type="text",
                ),
            ),
            (
                AdditionalInfoTextCommandAnswer(
                    id="answer",
                    status="answered",
                    raw_value="private",
                    value="private",
                ),
            ),
        )

    assert raised.value.code == "internal_error"
    assert path.read_bytes() == previous
    assert len(descriptors) == 1
    with pytest.raises(OSError):
        os.fstat(descriptors[0])
    assert not tuple(tmp_path.glob(".user-info.json.*.tmp"))


@pytest.mark.parametrize("failure", ["temp-create", "temp-fsync"])
async def test_precommit_io_failures_preserve_previous_bytes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    path = tmp_path / "user-info.json"
    store = UserInfoStore(path)
    previous = path.read_bytes()
    if failure == "temp-create":
        def fail_mkstemp(*args: object, **kwargs: object) -> tuple[int, str]:
            raise OSError("temp create failed")

        monkeypatch.setattr(user_info_module.tempfile, "mkstemp", fail_mkstemp)
    else:
        def fail_fsync(_descriptor: int) -> None:
            raise OSError("temp fsync failed")

        monkeypatch.setattr(user_info_module.os, "fsync", fail_fsync)

    with pytest.raises(HarnessServiceError) as raised:
        await store.merge(
            JOB_URL,
            (
                AdditionalInfoTextQuestion(
                    id="answer",
                    key="io.answer",
                    scope="global",
                    question="I/O answer?",
                    answer_type="text",
                ),
            ),
            (
                AdditionalInfoTextCommandAnswer(
                    id="answer",
                    status="answered",
                    raw_value="private",
                    value="private",
                ),
            ),
        )

    assert raised.value.code == "internal_error"
    assert path.read_bytes() == previous
