from __future__ import annotations

import ipaddress
import re
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
    SecretStr,
    StringConstraints,
    field_validator,
    model_serializer,
    model_validator,
)
from . import DEFAULT_SESSION_TIMEOUT_SECONDS

MODEL_PROVIDER = "openai-codex"
MODEL_NAME = "gpt-5.6-sol"
MODEL_REASONING = "high"

OpportunityKind: TypeAlias = Literal[
    "job",
    "hackathon",
    "competition",
    "event",
]


SessionState: TypeAlias = Literal[
    "starting",
    "running",
    "awaiting_human_navigation",
    "awaiting_origin_approval",
    "awaiting_additional_info",
    "awaiting_human_review",
    "submitting",
    "submitted",
    "submission_uncertain",
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
_ELEMENT_REF_PATTERN = re.compile(r"^(?:f[1-9][0-9]{0,8})?e[1-9][0-9]{0,8}$")
ElementRef = Annotated[
    str,
    StringConstraints(
        strict=True,
        pattern=r"^(?:f[1-9][0-9]{0,8})?e[1-9][0-9]{0,8}$",
    ),
]
def _is_unicode_scalar_text(value: str) -> bool:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def normalize_steer_message(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("message is invalid")
    trimmed = value.strip()
    if (
        not 1 <= len(trimmed) <= 8_000
        or "\x00" in trimmed
        or not _is_unicode_scalar_text(trimmed)
    ):
        raise ValueError("message is invalid")
    return trimmed


AdditionalInfoQuestionId = Annotated[
    str,
    StringConstraints(strict=True, pattern=r"^[a-z][a-z0-9_]{0,63}$"),
]
UserInfoKey = Annotated[
    str,
    StringConstraints(
        strict=True,
        max_length=100,
        pattern=r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$",
    ),
]
AdditionalInfoQuestionText = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=500,
    ),
]
AdditionalInfoOptionLabel = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=200,
    ),
]
AdditionalInfoTextValue = Annotated[
    str,
    StringConstraints(
        strict=True,
        strip_whitespace=True,
        min_length=1,
        max_length=2_000,
    ),
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


class AdditionalInfoOption(FrozenPrivateModel):
    id: AdditionalInfoQuestionId
    label: AdditionalInfoOptionLabel


class _AdditionalInfoQuestionBase(FrozenPrivateModel):
    id: AdditionalInfoQuestionId
    key: UserInfoKey
    scope: Literal["global", "application"]
    question: AdditionalInfoQuestionText


class AdditionalInfoTextQuestion(_AdditionalInfoQuestionBase):
    answer_type: Literal["text"]


class AdditionalInfoBooleanQuestion(_AdditionalInfoQuestionBase):
    answer_type: Literal["boolean"]


class _AdditionalInfoSelectQuestion(_AdditionalInfoQuestionBase):
    options: list[AdditionalInfoOption] = Field(min_length=2, max_length=20)

    @field_validator("options")
    @classmethod
    def _validate_unique_options(
        cls, values: list[AdditionalInfoOption]
    ) -> list[AdditionalInfoOption]:
        if len({option.id for option in values}) != len(values):
            raise ValueError("option ids must be unique")
        return values


class AdditionalInfoSingleSelectQuestion(_AdditionalInfoSelectQuestion):
    answer_type: Literal["single_select"]


class AdditionalInfoMultiSelectQuestion(_AdditionalInfoSelectQuestion):
    answer_type: Literal["multi_select"]


AdditionalInfoQuestion: TypeAlias = Annotated[
    AdditionalInfoTextQuestion
    | AdditionalInfoBooleanQuestion
    | AdditionalInfoSingleSelectQuestion
    | AdditionalInfoMultiSelectQuestion,
    Field(discriminator="answer_type"),
]


class ApplicationAnswerSuggestion(PublicModel):
    question: AdditionalInfoQuestionText
    answer: AdditionalInfoTextValue


class ApplicationAnswerSuggestionsResponse(PublicModel):
    suggestions: list[ApplicationAnswerSuggestion] = Field(max_length=5)


def _validate_unique_additional_info_questions(
    values: list[AdditionalInfoQuestion],
) -> list[AdditionalInfoQuestion]:
    if len({question.id for question in values}) != len(values):
        raise ValueError("question ids must be unique")
    scoped_keys = {(question.scope, question.key) for question in values}
    if len(scoped_keys) != len(values):
        raise ValueError("question scope and key pairs must be unique")
    return values


class AdditionalInfoDeclinedCommandAnswer(FrozenPrivateModel):
    id: AdditionalInfoQuestionId
    status: Literal["declined"]


class AdditionalInfoTextCommandAnswer(FrozenPrivateModel):
    id: AdditionalInfoQuestionId
    status: Literal["answered"]
    raw_value: AdditionalInfoTextValue
    value: AdditionalInfoTextValue


class AdditionalInfoBooleanCommandAnswer(FrozenPrivateModel):
    id: AdditionalInfoQuestionId
    status: Literal["answered"]
    value: bool


class AdditionalInfoSingleSelectCommandAnswer(FrozenPrivateModel):
    id: AdditionalInfoQuestionId
    status: Literal["answered"]
    option_id: AdditionalInfoQuestionId


class AdditionalInfoMultiSelectCommandAnswer(FrozenPrivateModel):
    id: AdditionalInfoQuestionId
    status: Literal["answered"]
    option_ids: list[AdditionalInfoQuestionId] = Field(
        min_length=1,
        max_length=20,
    )

    @field_validator("option_ids")
    @classmethod
    def _validate_unique_option_ids(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("option_ids must be unique")
        return values


AdditionalInfoCommandAnswer: TypeAlias = (
    AdditionalInfoDeclinedCommandAnswer
    | AdditionalInfoTextCommandAnswer
    | AdditionalInfoBooleanCommandAnswer
    | AdditionalInfoSingleSelectCommandAnswer
    | AdditionalInfoMultiSelectCommandAnswer
)


class AcceptedAdditionalInfoAnswer(FrozenPrivateModel):
    id: AdditionalInfoQuestionId
    key: UserInfoKey
    scope: Literal["global", "application"]
    answer_type: Literal["text", "boolean", "single_select", "multi_select"]
    status: Literal["answered", "declined"]
    value: StrictText | bool | list[StrictText] | None = None

    @model_validator(mode="after")
    def _validate_semantic_value(self) -> AcceptedAdditionalInfoAnswer:
        value_was_supplied = "value" in self.model_fields_set
        if self.status == "declined":
            if value_was_supplied:
                raise ValueError("declined answers must omit value")
            return self
        if not value_was_supplied:
            raise ValueError("answered answers require value")
        if self.answer_type == "boolean":
            if not isinstance(self.value, bool):
                raise ValueError("boolean answers require a boolean value")
            return self
        if self.answer_type in {"text", "single_select"}:
            maximum = 2_000 if self.answer_type == "text" else 200
            if (
                not isinstance(self.value, str)
                or self.value != self.value.strip()
                or not 1 <= len(self.value) <= maximum
            ):
                raise ValueError("text answers require a bounded string value")
            return self
        if (
            not isinstance(self.value, list)
            or not 1 <= len(self.value) <= 20
            or any(
                not value or value != value.strip() or len(value) > 200
                for value in self.value
            )
        ):
            raise ValueError("multi-select answers require bounded string values")
        return self

    @model_serializer(mode="plain")
    def _serialize(self) -> dict[str, object]:
        result: dict[str, object] = {
            "id": self.id,
            "key": self.key,
            "scope": self.scope,
            "answer_type": self.answer_type,
            "status": self.status,
        }
        if self.status == "answered":
            result["value"] = self.value
        return result


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
    session_timeout: int = Field(
        default=DEFAULT_SESSION_TIMEOUT_SECONDS,
        ge=1,
        le=86_400,
    )
    node_executable: Path | None = None
    playwright_cli_script: Path | None = None
    user_info_json: Path = Path(
        "apps/user-info/current-context/personal/user-info.json"
    )
    credentials_json: Path = Path("~/.jobhunter/browser-harness/credentials.json")
    browser: BrowserLaunchConfig = Field(default_factory=BrowserLaunchConfig)

    @field_validator("pipeline_url")
    @classmethod
    def _validate_pipeline_url(cls, value: str) -> str:
        return validate_loopback_http_url(value, field_name="pipeline_url")


class UploadedArtifacts(FrozenPrivateModel):
    session_directory: Path
    personal_information: Path
    resume: Path
    resume_source: Path
    context: tuple[Path, ...] = Field(default=(), max_length=10)
    anecdotes: tuple[Path, ...] = Field(default=(), max_length=20)


class SessionCreateRequest(FrozenPrivateModel):
    session_id: UUID
    job_url: StrictText
    opportunity_kind: OpportunityKind
    approved_origins: tuple[StrictText, ...] = Field(min_length=1, max_length=20)
    auto_submit: bool
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


class PlaywrightCliDiagnostic(PublicModel):
    step: int = Field(ge=1, le=500)
    status: Literal["succeeded", "failed", "timed_out"]
    exit_code: int
    timed_out: bool
    error_category: Literal[
        "process_exit",
        "execution_timeout",
        "browser_runtime",
        "session_timeout",
    ] | None
    stderr_excerpt: Literal[
        "[redacted]",
        "Playwright CLI execution timed out after 120 seconds.",
        "Browser runtime failed.",
        "Application session expired.",
    ] | None
    stderr_truncated: bool

    @model_validator(mode="after")
    def _validate_outcome(self) -> PlaywrightCliDiagnostic:
        expected_status = (
            "timed_out"
            if self.timed_out
            else "succeeded"
            if self.exit_code == 0
            else "failed"
        )
        if self.status != expected_status:
            raise ValueError("status does not match the browser outcome")
        if self.error_category == "execution_timeout":
            expected_excerpt = "Playwright CLI execution timed out after 120 seconds."
            valid_category = self.timed_out
        elif self.error_category == "session_timeout":
            expected_excerpt = "Application session expired."
            valid_category = self.timed_out and self.exit_code == -1
        elif self.error_category == "browser_runtime":
            expected_excerpt = "Browser runtime failed."
            valid_category = not self.timed_out and self.exit_code == -1
        elif self.error_category == "process_exit":
            expected_excerpt = None
            valid_category = not self.timed_out and self.exit_code != 0
        else:
            expected_excerpt = None
            valid_category = not self.timed_out and self.exit_code == 0
        if not valid_category:
            raise ValueError("error_category does not match the browser outcome")
        if (
            expected_excerpt is not None
            and self.stderr_excerpt != expected_excerpt
        ):
            raise ValueError("stderr_excerpt does not match the fixed error catalog")
        if expected_excerpt is None and self.stderr_excerpt not in (
            None,
            "[redacted]",
        ):
            raise ValueError("stderr_excerpt must be absent or redacted")
        return self


class HumanNavigationPendingAction(PublicModel):
    type: Literal["human_navigation"]
    instruction: Annotated[
        str,
        StringConstraints(strict=True, min_length=1, max_length=2_000),
    ]

class CredentialsPendingAction(PublicModel):
    type: Literal["credentials"]



class OriginApprovalPendingAction(PublicModel):
    type: Literal["origin_approval"]
    origin: StrictText

    @field_validator("origin")
    @classmethod
    def _validate_origin(cls, value: str) -> str:
        return validate_approved_origin(value)


class AdditionalInfoPendingAction(PublicModel):
    type: Literal["additional_info"]
    questions: list[AdditionalInfoQuestion] = Field(min_length=1, max_length=20)


class HumanReviewPendingAction(PublicModel):
    type: Literal["human_review"]


PendingAction: TypeAlias = Annotated[
    HumanNavigationPendingAction
    | CredentialsPendingAction
    | OriginApprovalPendingAction
    | AdditionalInfoPendingAction
    | HumanReviewPendingAction,
    Field(discriminator="type"),
]


class SessionSnapshot(PublicModel):
    session_id: UUID
    state: SessionState
    created_at: datetime
    updated_at: datetime
    expires_at: datetime
    slot_released: bool = False
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
    playwright_cli_diagnostics: list[PlaywrightCliDiagnostic] = Field(
        default_factory=list,
        max_length=100,
    )
    revision_count: int = Field(default=0, ge=0, le=100)
    pending_action: PendingAction | None = None
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
    def _validate_timestamps_error_and_pending_action(self) -> SessionSnapshot:
        if self.updated_at < self.created_at:
            raise ValueError("updated_at must not precede created_at")
        if self.expires_at < self.created_at:
            raise ValueError("expires_at must not precede created_at")
        if self.slot_released and self.state not in {"cancelled", "failed", "closed"}:
            raise ValueError("only cleaned terminal sessions may release the slot")
        if self.state == "failed" and self.error is None:
            raise ValueError("failed sessions require an error")
        if self.state != "failed" and self.error is not None:
            raise ValueError("only failed sessions may contain an error")
        pending_types: dict[
            str,
            type[PublicModel] | tuple[type[PublicModel], ...],
        ] = {
            "awaiting_human_navigation": (
                HumanNavigationPendingAction,
                CredentialsPendingAction,
            ),
            "awaiting_origin_approval": OriginApprovalPendingAction,
            "awaiting_additional_info": AdditionalInfoPendingAction,
            "awaiting_human_review": HumanReviewPendingAction,
        }
        expected_pending_type = pending_types.get(self.state)
        if expected_pending_type is None:
            if self.pending_action is not None:
                raise ValueError("only awaiting sessions may contain a pending action")
        elif not isinstance(self.pending_action, expected_pending_type):
            raise ValueError("pending action does not match the awaiting session state")
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


class AdditionalInfoRequiredDetail(PublicModel):
    questions: list[AdditionalInfoQuestion] = Field(min_length=1, max_length=20)


class AdditionalInfoSavedDetail(PublicModel):
    count: int = Field(ge=1, le=20)


HarnessEventDetail: TypeAlias = (
    EmptyEventDetail
    | AgentStepDetail
    | HumanNavigationDetail
    | OriginApprovalDetail
    | RevisionAppliedDetail
    | AdditionalInfoRequiredDetail
    | AdditionalInfoSavedDetail
)
HarnessEventType: TypeAlias = Literal[
    "snapshot",
    "session_started",
    "agent_step",
    "human_navigation_required",
    "origin_approval_required",
    "review_required",
    "revision_applied",
    "additional_info_required",
    "additional_info_saved",
    "submission_started",
    "application_submitted",
    "submission_uncertain",
    "cancelled",
    "failed",
    "closed",
    "credentials_required",
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
        elif self.event == "additional_info_required":
            expected = AdditionalInfoRequiredDetail
        elif self.event == "additional_info_saved":
            expected = AdditionalInfoSavedDetail
        else:
            expected = EmptyEventDetail
        if not isinstance(self.detail, expected):
            raise ValueError(f"detail does not match {self.event}")
        return self

class _CredentialCommandBase(PublicModel):
    username: SecretStr = Field(repr=False)
    password: SecretStr = Field(repr=False)

    @field_validator("username", mode="before")
    @classmethod
    def _validate_username(cls, value: object) -> SecretStr:
        if not isinstance(value, str):
            raise ValueError("username is invalid")
        trimmed = value.strip()
        if (
            not 1 <= len(trimmed) <= 320
            or "\x00" in trimmed
            or not _is_unicode_scalar_text(trimmed)
        ):
            raise ValueError("username is invalid")
        return SecretStr(trimmed)

    @field_validator("password", mode="before")
    @classmethod
    def _validate_password(cls, value: object) -> SecretStr:
        if (
            not isinstance(value, str)
            or not 1 <= len(value) <= 4_096
            or not _is_unicode_scalar_text(value)
            or "\x00" in value
        ):
            raise ValueError("password is invalid")
        return SecretStr(value)

    def credentials(self) -> tuple[str, str]:
        return (
            self.username.get_secret_value(),
            self.password.get_secret_value(),
        )


class SignInCommand(_CredentialCommandBase):
    type: Literal["sign_in"]


class SaveCredentialsCommand(_CredentialCommandBase):
    type: Literal["save_credentials"]



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


class SteerCommand(PublicModel):
    type: Literal["steer"]
    message: str = Field(repr=False)

    @field_validator("message", mode="before")
    @classmethod
    def _validate_message(cls, value: object) -> str:
        return normalize_steer_message(value)


class SubmitCommand(PublicModel):
    type: Literal["submit"]


class CancelCommand(PublicModel):
    type: Literal["cancel"]


class ProvideAdditionalInfoCommand(PublicModel):
    type: Literal["provide_additional_info"]
    answers: list[AdditionalInfoCommandAnswer] = Field(min_length=1, max_length=20)

    @field_validator("answers")
    @classmethod
    def _validate_unique_answer_ids(
        cls, values: list[AdditionalInfoCommandAnswer]
    ) -> list[AdditionalInfoCommandAnswer]:
        if len({answer.id for answer in values}) != len(values):
            raise ValueError("answer ids must be unique")
        return values


SessionCommand: TypeAlias = Annotated[
    ContinueCommand
    | ApproveOriginCommand
    | ReviseCommand
    | SteerCommand
    | SubmitCommand
    | CancelCommand
    | ProvideAdditionalInfoCommand
    | SignInCommand
    | SaveCredentialsCommand,
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


class BrowserTab(PublicModel):
    url: Annotated[str, StringConstraints(strict=True, max_length=4_096)]
    title: Annotated[str, StringConstraints(strict=True, max_length=4_096)]
    tab_id: Annotated[str, StringConstraints(strict=True, max_length=512)]
    parent_tab_id: (
        Annotated[str, StringConstraints(strict=True, max_length=512)] | None
    ) = None


class BrowserScreenshot(PublicModel):
    media_type: Literal["image/png"] = "image/png"
    data: Annotated[
        str,
        StringConstraints(strict=True, max_length=11_184_812),
    ]


class BrowserObservation(PublicModel):
    url: Annotated[str, StringConstraints(strict=True, max_length=4_096)]
    title: Annotated[str, StringConstraints(strict=True, max_length=4_096)]
    tabs: list[BrowserTab] = Field(max_length=100)
    dom: Annotated[str, StringConstraints(strict=True, max_length=40_000)]
    page_info: dict[str, object] | None
    screenshot: BrowserScreenshot | None


class PlaywrightCliExecutionResult(PublicModel):
    exit_code: int
    timed_out: bool
    stdout: Annotated[str, StringConstraints(strict=True, max_length=20_000)]
    stderr: Annotated[str, StringConstraints(strict=True, max_length=20_000)]
    stdout_truncated: bool
    stderr_truncated: bool
    observation: BrowserObservation


class ApplicationResultBase(PublicModel):
    company: Annotated[str, StringConstraints(strict=True, max_length=500)] | None = None
    role: Annotated[str, StringConstraints(strict=True, max_length=500)] | None = None
    job_url: StrictText
    final_url: StrictText
    fields_filled: list[FieldResult] = Field(default_factory=list, max_length=500)
    fields_needing_human: list[FieldResult] = Field(default_factory=list, max_length=500)
    files_attached: list[StrictText] = Field(default_factory=list, max_length=20)
    warnings: list[WarningText] = Field(default_factory=list, max_length=100)
    revision_count: int = Field(default=0, ge=0, le=100)

    @field_validator("job_url", "final_url")
    @classmethod
    def _sanitize_url(cls, value: str) -> str:
        return sanitize_public_url(value)

    @field_validator("files_attached")
    @classmethod
    def _validate_files(cls, values: list[str]) -> list[str]:
        return [validate_sanitized_basename(value) for value in values]

    @field_validator("fields_filled")
    @classmethod
    def _validate_filled_fields(
        cls, values: list[FieldResult]
    ) -> list[FieldResult]:
        if any(not value.value_present for value in values):
            raise ValueError("fields_filled entries must have value_present true")
        return values

    @field_validator("fields_needing_human")
    @classmethod
    def _validate_unresolved_fields(
        cls, values: list[FieldResult]
    ) -> list[FieldResult]:
        if any(value.value_present for value in values):
            raise ValueError(
                "fields_needing_human entries must have value_present false"
            )
        return values


class ReviewApplicationResult(ApplicationResultBase):
    status: Literal["ready_for_submission"]
    submit_attempted: Literal[False] = False


class PostSubmitConfirmation(PublicModel):
    type: Literal["post_submit_confirmation"]
    text: Annotated[
        str,
        StringConstraints(
            strict=True,
            strip_whitespace=True,
            min_length=1,
            max_length=1_000,
        ),
    ]


class SubmittedApplicationResult(ApplicationResultBase):
    status: Literal["submitted"]
    submit_attempted: Literal[True]
    submission_confirmation: PostSubmitConfirmation


class SubmissionUncertainApplicationResult(ApplicationResultBase):
    status: Literal["submission_uncertain"]
    submit_attempted: Literal[True]
    submission_confirmation: None


class CancelledApplicationResult(ApplicationResultBase):
    status: Literal["cancelled"]
    submit_attempted: Literal[False]
    submission_confirmation: None


ApplicationRunResult: TypeAlias = Annotated[
    SubmittedApplicationResult
    | SubmissionUncertainApplicationResult
    | CancelledApplicationResult,
    Field(discriminator="status"),
]


PlaywrightCliCommand: TypeAlias = Literal[
    "goto",
    "snapshot",
    "eval",
    "click",
    "dblclick",
    "type",
    "press",
    "fill",
    "drag",
    "drop",
    "hover",
    "select",
    "upload",
    "check",
    "uncheck",
    "dialog-accept",
    "dialog-dismiss",
    "resize",
    "go-back",
    "go-forward",
    "reload",
    "keydown",
    "keyup",
    "mousemove",
    "mousedown",
    "mouseup",
    "mousewheel",
    "screenshot",
    "pdf",
    "tab-list",
    "tab-new",
    "tab-close",
    "tab-select",
    "generate-locator",
    "highlight",
    "video-chapter",
    "video-show-actions",
    "video-hide-actions",
]


class PlaywrightCliRuntimeAction(PublicModel):
    type: Literal["playwright_cli"]
    command: PlaywrightCliCommand
    args: list[StrictText] = Field(default_factory=list, max_length=64)

    @field_validator("args")
    @classmethod
    def _validate_argument_sizes(cls, values: list[str]) -> list[str]:
        try:
            oversized = any(
                len(value.encode("utf-8")) > 8_192 for value in values
            )
        except UnicodeEncodeError:
            raise ValueError("arguments must be valid UTF-8 text") from None
        if oversized:
            raise ValueError("each argument must be at most 8,192 UTF-8 bytes")
        return values

    @model_validator(mode="after")
    def _validate_invocation_size(self) -> PlaywrightCliRuntimeAction:
        invocation_size = len(self.command.encode("utf-8")) + sum(
            len(value.encode("utf-8")) for value in self.args
        )
        if invocation_size > 65_536:
            raise ValueError("invocation must be at most 65,536 UTF-8 bytes")
        return self


class RequestHumanNavigationRuntimeAction(PublicModel):
    type: Literal["request_human_navigation"]
    instruction: Annotated[
        str,
        StringConstraints(
            strict=True,
            strip_whitespace=True,
            min_length=1,
            max_length=2_000,
        ),
    ]
class RequestSignInRuntimeAction(PublicModel):
    type: Literal["request_sign_in"]
    username_ref: ElementRef
    password_ref: ElementRef
    submit_ref: ElementRef

    @field_validator("username_ref", "password_ref", "submit_ref")
    @classmethod
    def _validate_ref(cls, value: str) -> str:
        if _ELEMENT_REF_PATTERN.fullmatch(value) is None:
            raise ValueError("element ref is invalid")
        return value




class RequestAdditionalInfoRuntimeAction(PublicModel):
    type: Literal["request_additional_info"]
    questions: list[AdditionalInfoQuestion] = Field(min_length=1, max_length=20)

    @field_validator("questions")
    @classmethod
    def _validate_unique_questions(
        cls, values: list[AdditionalInfoQuestion]
    ) -> list[AdditionalInfoQuestion]:
        return _validate_unique_additional_info_questions(values)


class RequestHumanReviewRuntimeAction(PublicModel):
    type: Literal["request_human_review"]
    result: ReviewApplicationResult


class ReportApplicationMismatchRuntimeAction(PublicModel):
    type: Literal["report_application_mismatch"]


RuntimeActionRequest: TypeAlias = Annotated[
    PlaywrightCliRuntimeAction
    | RequestHumanNavigationRuntimeAction
    | RequestSignInRuntimeAction
    | RequestAdditionalInfoRuntimeAction
    | RequestHumanReviewRuntimeAction
    | ReportApplicationMismatchRuntimeAction,
    Field(discriminator="type"),
]


class PlaywrightCliResultRuntimeActionResponse(PlaywrightCliExecutionResult):
    type: Literal["playwright_cli_result"]

class SignInRuntimeActionResponse(PublicModel):
    type: Literal["sign_in"]
    status: Literal["attempted", "saved"]



class ContinueRuntimeActionResponse(PublicModel):
    type: Literal["continue"]


class ReviseRuntimeActionResponse(PublicModel):
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
    revision_count: int = Field(ge=1, le=100)


class SubmitRuntimeActionResponse(PublicModel):
    type: Literal["submit"]
    instruction: Literal["You're good to submit."]
    result: ReviewApplicationResult


class CancelRuntimeActionResponse(PublicModel):
    type: Literal["cancel"]
    result: CancelledApplicationResult


class AdditionalInfoRuntimeActionResponse(PublicModel):
    type: Literal["additional_info"]
    answers: list[AcceptedAdditionalInfoAnswer] = Field(min_length=1, max_length=20)


class ApplicationMismatchRuntimeActionResponse(PublicModel):
    type: Literal["application_mismatch"]


RuntimeActionResponse: TypeAlias = Annotated[
    PlaywrightCliResultRuntimeActionResponse
    | SignInRuntimeActionResponse
    | ContinueRuntimeActionResponse
    | ReviseRuntimeActionResponse
    | SubmitRuntimeActionResponse
    | CancelRuntimeActionResponse
    | AdditionalInfoRuntimeActionResponse
    | ApplicationMismatchRuntimeActionResponse,
    Field(discriminator="type"),
]
