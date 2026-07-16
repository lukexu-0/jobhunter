from __future__ import annotations

import ipaddress
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path, PurePath
from types import MappingProxyType
from typing import Annotated, Literal, TypeAlias
from urllib.parse import SplitResult, urlsplit, urlunsplit
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

MODEL_PROVIDER = "openai-codex"
MODEL_NAME = "gpt-5.6-sol"
MODEL_REASONING = "high"

SessionState: TypeAlias = Literal[
    "starting",
    "running",
    "awaiting_human_navigation",
    "awaiting_origin_approval",
    "awaiting_human_review",
    "ready_for_human_submit",
    "cancelled",
    "failed",
    "closed",
]
TerminalSessionState: TypeAlias = Literal["cancelled", "failed", "closed"]
FieldType: TypeAlias = Literal[
    "text",
    "textarea",
    "select",
    "radio",
    "checkbox",
    "number",
    "file",
    "unknown",
]
ErrorCode: TypeAlias = Literal[
    "oauth_required",
    "pipeline_unavailable",
    "model_timeout",
    "invalid_model_output",
    "model_failed",
    "browser_failed",
    "application_mismatch",
    "step_limit",
    "session_timeout",
]
DIRECT_FIELD_NAMES = frozenset(
    {
        "full_name",
        "first_name",
        "last_name",
        "email",
        "phone",
        "street_address",
        "city",
        "region",
        "postal_code",
        "country",
        "linkedin_url",
        "portfolio_url",
        "work_authorization",
        "sponsorship_required",
        "relocation",
        "salary_expectation",
        "start_date",
    }
)


_SESSION_ERROR_MESSAGES: dict[str, str] = {
    "oauth_required": "Connect OpenAI Codex in Provider access",
    "pipeline_unavailable": "The local pipeline model service is unavailable",
    "model_timeout": "The model request timed out",
    "invalid_model_output": "The model returned invalid output",
    "model_failed": "The model request failed",
    "browser_failed": "The browser session failed",
    "application_mismatch": "The open page does not match the requested job",
    "step_limit": "The application step limit was reached",
    "session_timeout": "The application session expired",
}
SESSION_ERROR_MESSAGES: Mapping[str, str] = MappingProxyType(_SESSION_ERROR_MESSAGES)

StrictText = Annotated[str, StringConstraints(strict=True)]
ShortLabel = Annotated[
    str,
    StringConstraints(strict=True, min_length=1, max_length=500),
]
OptionalShortText = Annotated[
    str,
    StringConstraints(strict=True, max_length=1_000),
]
WarningText = Annotated[
    str,
    StringConstraints(strict=True, min_length=1, max_length=1_000),
]


def _split_absolute_http_url(value: str, *, field_name: str) -> SplitResult:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    try:
        parsed = urlsplit(value)
        # Accessing port eagerly catches malformed and out-of-range ports.
        parsed.port
    except ValueError as exc:
        raise ValueError(f"{field_name} is not a valid URL") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"{field_name} must be an absolute HTTP(S) URL")
    if "*" in parsed.hostname:
        raise ValueError(f"{field_name} must not contain a wildcard")
    return parsed


def _is_loopback_host(hostname: str) -> bool:
    hostname = hostname.rstrip(".").lower()
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _netloc_without_userinfo(parsed: SplitResult) -> str:
    assert parsed.hostname is not None
    host = parsed.hostname.lower().rstrip(".")
    if ":" in host:
        host = f"[{host}]"
    port = parsed.port
    if (parsed.scheme.lower() == "https" and port == 443) or (parsed.scheme.lower() == "http" and port == 80):
        port = None
    return f"{host}:{port}" if port is not None else host


def validate_job_url(value: str) -> str:
    """Validate a private job URL while preserving its path and query."""

    parsed = _split_absolute_http_url(value, field_name="job_url")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("job_url must not contain user information")
    if parsed.fragment:
        raise ValueError("job_url must not contain a fragment")
    if parsed.scheme.lower() == "http" and not _is_loopback_host(parsed.hostname or ""):
        raise ValueError("job_url must use HTTPS unless it is loopback")
    return value


def sanitize_public_url(value: str) -> str:
    """Strip credentials, query, and fragment from a public HTTP(S) URL."""

    parsed = _split_absolute_http_url(value, field_name="URL")
    return urlunsplit(
        (
            parsed.scheme.lower(),
            _netloc_without_userinfo(parsed),
            parsed.path or "",
            "",
            "",
        )
    )


def validate_https_origin(value: str) -> str:
    """Return a canonical exact HTTPS origin, rejecting URL-like additions."""

    parsed = _split_absolute_http_url(value, field_name="origin")
    if parsed.scheme.lower() != "https":
        raise ValueError("origin must use HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("origin must not contain user information")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("origin must not contain a path, query, or fragment")
    return f"https://{_netloc_without_userinfo(parsed)}"


def validate_approved_origin(value: str) -> str:
    """Return a canonical HTTPS origin (or HTTP origin for loopback fixtures)."""

    parsed = _split_absolute_http_url(value, field_name="origin")
    if parsed.scheme.lower() == "http" and not _is_loopback_host(parsed.hostname or ""):
        raise ValueError("origin must use HTTPS unless it is loopback")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("origin must not contain user information")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("origin must not contain a path, query, or fragment")
    return f"{parsed.scheme.lower()}://{_netloc_without_userinfo(parsed)}"


def validate_loopback_http_url(value: str, *, field_name: str) -> str:
    parsed = _split_absolute_http_url(value, field_name=field_name)
    if parsed.scheme.lower() != "http" or not _is_loopback_host(parsed.hostname or ""):
        raise ValueError(f"{field_name} must be a loopback HTTP URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(f"{field_name} must not contain user information")
    if parsed.query or parsed.fragment:
        raise ValueError(f"{field_name} must not contain a query or fragment")
    return value.rstrip("/")


def validate_sanitized_basename(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("filename must be a string")
    if not value or len(value) > 255:
        raise ValueError("filename must contain 1 to 255 characters")
    if value in {".", ".."} or "/" in value or "\\" in value:
        raise ValueError("filename must be a basename")
    if PurePath(value).name != value or any(ord(character) < 32 for character in value):
        raise ValueError("filename contains unsafe characters")
    return value


def session_error(code: ErrorCode) -> SessionError:
    """Construct an error from the fixed public catalog."""

    return SessionError(code=code, message=SESSION_ERROR_MESSAGES[code])


class PublicModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class FrozenPrivateModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class HarnessServiceError(Exception):
    """Sanitized service failure safe to expose through the loopback API."""

    __slots__ = ("status_code", "code", "public_message", "session_id")

    def __init__(
        self,
        status_code: int,
        code: str,
        public_message: str,
        *,
        session_id: UUID | None = None,
    ) -> None:
        super().__init__(public_message)
        self.status_code = status_code
        self.code = code
        self.public_message = public_message
        self.session_id = session_id


class BrowserLaunchConfig(FrozenPrivateModel):
    chrome_executable: Path | None = None
    chrome_user_data_dir: Path = Path("~/.jobhunter/browser-harness/chrome")
    cdp_url: StrictText | None = None

    @field_validator("cdp_url")
    @classmethod
    def _validate_cdp_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        canonical = validate_loopback_http_url(value, field_name="cdp_url")
        parsed = urlsplit(canonical)
        if parsed.path not in {"", "/"} or parsed.port is None:
            raise ValueError("cdp_url must be a loopback HTTP origin with an explicit port")
        return canonical

    @model_validator(mode="after")
    def _validate_browser_options(self) -> BrowserLaunchConfig:
        if self.cdp_url is not None and self.chrome_executable is not None:
            raise ValueError("cdp_url and chrome_executable are mutually exclusive")
        return self


class HarnessConfig(FrozenPrivateModel):
    bearer_token: Annotated[
        str,
        StringConstraints(strict=True, min_length=32),
    ]
    pipeline_url: StrictText = "http://127.0.0.1:3457"
    port: int = Field(default=8765, ge=1, le=65_535)
    session_timeout: int = Field(default=3_600, ge=1)
    browser: BrowserLaunchConfig = Field(default_factory=BrowserLaunchConfig)

    @field_validator("pipeline_url")
    @classmethod
    def _validate_pipeline_url(cls, value: str) -> str:
        return validate_loopback_http_url(value, field_name="pipeline_url")


class UploadedArtifacts(FrozenPrivateModel):
    session_directory: Path
    personal_information: Path
    resume: Path
    context: tuple[Path, ...] = Field(default=(), max_length=10)
    anecdotes: tuple[Path, ...] = Field(default=(), max_length=20)


class SessionCreateRequest(FrozenPrivateModel):
    session_id: UUID
    job_url: StrictText
    approved_origins: tuple[StrictText, ...] = Field(min_length=1, max_length=20)
    max_steps: int = Field(default=100, ge=1, le=500)
    artifacts: UploadedArtifacts
    direct_fields: tuple[tuple[StrictText, StrictText], ...] = ()

    @field_validator("job_url")
    @classmethod
    def _validate_job_url(cls, value: str) -> str:
        return validate_job_url(value)

    @field_validator("approved_origins")
    @classmethod
    def _validate_approved_origins(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        canonical = tuple(validate_approved_origin(value) for value in values)
        if len(set(canonical)) != len(canonical):
            raise ValueError("approved_origins must not contain duplicates")
        return canonical

    @field_validator("direct_fields")
    @classmethod
    def _validate_direct_fields(
        cls, values: tuple[tuple[str, str], ...]
    ) -> tuple[tuple[str, str], ...]:
        names = [name for name, _ in values]
        if len(set(names)) != len(names):
            raise ValueError("direct_fields must not contain duplicate names")
        if any(name not in DIRECT_FIELD_NAMES for name in names):
            raise ValueError("direct_fields contains an unknown name")
        if any(not value.strip() for _, value in values):
            raise ValueError("direct_fields values must be nonempty")
        return values

    @property
    def direct_field_map(self) -> Mapping[str, str]:
        return MappingProxyType(dict(self.direct_fields))


class FieldResult(PublicModel):
    label: ShortLabel
    field_type: FieldType
    value_present: bool
    note: OptionalShortText = ""


class SessionError(PublicModel):
    code: ErrorCode
    message: StrictText

    @model_validator(mode="after")
    def _validate_catalog_message(self) -> SessionError:
        if self.message != SESSION_ERROR_MESSAGES[self.code]:
            raise ValueError("message does not match the fixed session error catalog")
        return self


class SessionSnapshot(PublicModel):
    session_id: UUID
    state: SessionState
    created_at: datetime
    updated_at: datetime
    job_url: StrictText
    company: Annotated[str, StringConstraints(strict=True, max_length=500)] | None = None
    role: Annotated[str, StringConstraints(strict=True, max_length=500)] | None = None
    model_provider: Literal["openai-codex"] = MODEL_PROVIDER
    model: Literal["gpt-5.6-sol"] = MODEL_NAME
    reasoning: Literal["high"] = MODEL_REASONING
    fields_filled: list[FieldResult] = Field(default_factory=list, max_length=500)
    fields_needing_human: list[FieldResult] = Field(default_factory=list, max_length=500)
    files_attached: list[StrictText] = Field(default_factory=list, max_length=20)
    warnings: list[WarningText] = Field(default_factory=list, max_length=100)
    revision_count: int = Field(default=0, ge=0, le=100)
    approved_origins: list[StrictText] = Field(default_factory=list, max_length=20)
    error: SessionError | None = None

    @field_validator("job_url")
    @classmethod
    def _sanitize_job_url(cls, value: str) -> str:
        return sanitize_public_url(value)

    @field_validator("files_attached")
    @classmethod
    def _validate_files(cls, values: list[str]) -> list[str]:
        return [validate_sanitized_basename(value) for value in values]

    @field_validator("approved_origins")
    @classmethod
    def _validate_origins(cls, values: list[str]) -> list[str]:
        canonical = [validate_approved_origin(value) for value in values]
        if len(set(canonical)) != len(canonical):
            raise ValueError("approved_origins must not contain duplicates")
        return canonical

    @model_validator(mode="after")
    def _validate_timestamps_and_error(self) -> SessionSnapshot:
        if self.updated_at < self.created_at:
            raise ValueError("updated_at must not precede created_at")
        if self.state == "failed" and self.error is None:
            raise ValueError("failed sessions require an error")
        if self.state != "failed" and self.error is not None:
            raise ValueError("only failed sessions may contain an error")
        return self


class EmptyEventDetail(PublicModel):
    pass


class AgentStepDetail(PublicModel):
    step_number: int = Field(ge=1, le=500)
    current_url: StrictText

    @field_validator("current_url")
    @classmethod
    def _sanitize_current_url(cls, value: str) -> str:
        return sanitize_public_url(value)


class HumanNavigationDetail(PublicModel):
    instruction: Annotated[
        str,
        StringConstraints(strict=True, min_length=1, max_length=2_000),
    ]


class OriginApprovalDetail(PublicModel):
    origin: StrictText

    @field_validator("origin")
    @classmethod
    def _validate_origin(cls, value: str) -> str:
        return validate_approved_origin(value)


class RevisionAppliedDetail(PublicModel):
    revision_count: int = Field(ge=1, le=100)


HarnessEventDetail: TypeAlias = (
    EmptyEventDetail
    | AgentStepDetail
    | HumanNavigationDetail
    | OriginApprovalDetail
    | RevisionAppliedDetail
)
HarnessEventType: TypeAlias = Literal[
    "snapshot",
    "session_started",
    "agent_step",
    "human_navigation_required",
    "origin_approval_required",
    "review_required",
    "revision_applied",
    "ready_for_human_submit",
    "cancelled",
    "failed",
    "closed",
]


class HarnessEvent(PublicModel):
    id: int = Field(ge=0)
    event: HarnessEventType
    session: SessionSnapshot
    detail: HarnessEventDetail = Field(default_factory=EmptyEventDetail)

    @model_validator(mode="after")
    def _validate_event_detail(self) -> HarnessEvent:
        expected: type[PublicModel]
        if self.event == "agent_step":
            expected = AgentStepDetail
        elif self.event == "human_navigation_required":
            expected = HumanNavigationDetail
        elif self.event == "origin_approval_required":
            expected = OriginApprovalDetail
        elif self.event == "revision_applied":
            expected = RevisionAppliedDetail
        else:
            expected = EmptyEventDetail
        if not isinstance(self.detail, expected):
            raise ValueError(f"detail does not match {self.event}")
        return self


class ContinueCommand(PublicModel):
    type: Literal["continue"]


class ApproveOriginCommand(PublicModel):
    type: Literal["approve_origin"]
    origin: StrictText

    @field_validator("origin")
    @classmethod
    def _validate_origin(cls, value: str) -> str:
        return validate_approved_origin(value)


class ReviseCommand(PublicModel):
    type: Literal["revise"]
    context: Annotated[
        str,
        StringConstraints(
            strict=True,
            strip_whitespace=True,
            min_length=1,
            max_length=20_000,
        ),
    ]


class ReadyCommand(PublicModel):
    type: Literal["ready"]


class CancelCommand(PublicModel):
    type: Literal["cancel"]


SessionCommand: TypeAlias = Annotated[
    ContinueCommand
    | ApproveOriginCommand
    | ReviseCommand
    | ReadyCommand
    | CancelCommand,
    Field(discriminator="type"),
]


class SessionCreateResponse(PublicModel):
    session_id: UUID
    state: Literal["starting"] = "starting"
    events_url: StrictText
    commands_url: StrictText

    @field_validator("events_url", "commands_url")
    @classmethod
    def _sanitize_endpoint_url(cls, value: str) -> str:
        return sanitize_public_url(value)


class ApplicationRunResult(PublicModel):
    status: Literal["ready_for_human_submit", "cancelled"]
    company: Annotated[str, StringConstraints(strict=True, max_length=500)] | None = None
    role: Annotated[str, StringConstraints(strict=True, max_length=500)] | None = None
    job_url: StrictText
    final_url: StrictText
    fields_filled: list[FieldResult] = Field(default_factory=list, max_length=500)
    fields_needing_human: list[FieldResult] = Field(default_factory=list, max_length=500)
    files_attached: list[StrictText] = Field(default_factory=list, max_length=20)
    warnings: list[WarningText] = Field(default_factory=list, max_length=100)
    revision_count: int = Field(default=0, ge=0, le=100)
    submit_attempted: Literal[False] = False

    @field_validator("job_url", "final_url")
    @classmethod
    def _sanitize_url(cls, value: str) -> str:
        return sanitize_public_url(value)

    @field_validator("files_attached")
    @classmethod
    def _validate_files(cls, values: list[str]) -> list[str]:
        return [validate_sanitized_basename(value) for value in values]
