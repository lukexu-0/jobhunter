from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from .context import CandidateContext, candidate_evidence_records
from .models import SessionCreateRequest
from .user_info import UserInfoSnapshot


@dataclass(frozen=True, slots=True)
class ApplicationRunRequest:
    session: SessionCreateRequest
    candidate: CandidateContext
    resume_display_name: str
    user_info: UserInfoSnapshot
    resume_upload_path: str | None = None


def _navigation_url(value: str) -> str:
    parsed = urlsplit(value)
    return urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path or "/",
            parsed.query,
            "",
        )
    )


def build_application_task(request: ApplicationRunRequest) -> str:
    session = request.session
    evidence = [
        record.as_task_value()
        for record in candidate_evidence_records(
            request.candidate,
            request.resume_display_name,
        )
    ]
    saved = request.user_info.as_task_payload()
    payload = {
        "job": {
            "url": _navigation_url(session.job_url),
            "approved_origins": list(session.approved_origins),
            "resume": {
                "display_name": request.resume_display_name,
                "path": request.resume_upload_path or str(session.artifacts.resume),
            },
        },
        "user_info": {
            "explicit": dict(request.candidate.direct_fields),
            "saved_global": saved["saved_global"],
            "saved_application": saved["saved_application"],
        },
        "evidence": evidence,
    }
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    )
