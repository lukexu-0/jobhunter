import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Literal
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from typing_extensions import Annotated

from browser_use.agent.views import ActionModel, ActionResult
from browser_use.browser import BrowserSession
from browser_use.filesystem.file_system import FileSystem
from browser_use.llm.base import BaseChatModel
from browser_use.tools.service import Tools

from .context import CandidateContext
from .models import (
    ApplicationRunResult,
    FieldResult,
    sanitize_public_url,
    HarnessServiceError,
    SessionState,
    validate_approved_origin,
)

DEFAULT_ACTIONS_0_13_4 = frozenset(
    {
        "done",
        "search",
        "navigate",
        "go_back",
        "wait",
        "click",
        "input",
        "upload_file",
        "switch",
        "close",
        "extract",
        "search_page",
        "find_elements",
        "scroll",
        "send_keys",
        "find_text",
        "screenshot",
        "save_as_pdf",
        "dropdown_options",
        "select_dropdown",
        "write_file",
        "replace_file",
        "read_file",
        "evaluate",
    }
)
MAX_APPROVED_ORIGINS = 20
APPLICATION_MISMATCH_RESULT = '{"harness_failure":"application_mismatch"}'

GateEventPublisher = Callable[
    [SessionState, str | None, Mapping[str, object]], Awaitable[None]
]
ReviewSnapshotSink = Callable[[ApplicationRunResult], Awaitable[None]]
GateKind = Literal["navigation", "origin", "review"]
DecisionKind = Literal["continue", "approve", "revise", "ready", "cancel"]


class _StrictActionModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class HumanNavigationRequest(_StrictActionModel):
    instruction: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=2_000),
    ]


class OriginApprovalRequest(_StrictActionModel):
    origin: str

    @field_validator("origin")
    @classmethod
    def validate_origin(cls, value: str) -> str:
        return validate_approved_origin(value)


@dataclass(slots=True)
class _PendingGate:
    kind: GateKind
    future: asyncio.Future[tuple[DecisionKind, str | None]]
    browser_session: BrowserSession
    origin: str | None = None


def _origin_from_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.username is not None or parsed.password is not None or not parsed.hostname:
        raise ValueError("current page has no approvable origin")
    host = parsed.hostname.lower().rstrip(".")
    if ":" in host:
        host = f"[{host}]"
    port = parsed.port
    if (parsed.scheme.lower() == "https" and port == 443) or (
        parsed.scheme.lower() == "http" and port == 80
    ):
        port = None
    netloc = f"{host}:{port}" if port is not None else host
    return validate_approved_origin(f"{parsed.scheme.lower()}://{netloc}")


def _decode_public_text(value: str) -> str:
    decoded = value
    while True:
        next_value = unquote(decoded)
        if next_value == decoded:
            return decoded
        decoded = next_value


def redact_public_text(
    value: str | None,
    direct_values: Mapping[str, str],
) -> str | None:
    if value is None:
        return None
    redacted = _decode_public_text(value)
    secrets = {
        representation
        for secret in direct_values.values()
        if secret
        for representation in (secret, _decode_public_text(secret))
        if representation
    }
    for secret in sorted(secrets, key=len, reverse=True):
        redacted = redacted.replace(secret, "[redacted]")
    return redacted


def sanitize_application_result(
    result: ApplicationRunResult,
    direct_values: Mapping[str, str],
    revision_count: int,
) -> ApplicationRunResult:
    def safe_field(field: FieldResult) -> FieldResult:
        label = redact_public_text(field.label, direct_values) or "Field"
        return FieldResult(
            label=label,
            field_type=field.field_type,
            value_present=field.value_present,
            note="Filled" if field.value_present else "Needs human review",
        )

    warnings = (
        ["The application agent reported warnings; review all listed fields before submitting."]
        if result.warnings
        else []
    )
    return ApplicationRunResult(
        status="ready_for_human_submit",
        company=redact_public_text(result.company, direct_values),
        role=redact_public_text(result.role, direct_values),
        job_url=result.job_url,
        final_url=result.final_url,
        fields_filled=[safe_field(field) for field in result.fields_filled],
        fields_needing_human=[
            safe_field(field) for field in result.fields_needing_human
        ],
        files_attached=["resume.pdf"] if result.files_attached else [],
        warnings=warnings,
        revision_count=revision_count,
        submit_attempted=False,
    )


class HumanGate:
    def __init__(
        self,
        *,
        job_url: str,
        candidate: CandidateContext,
        approved_origins: list[str] | tuple[str, ...],
        sensitive_data: dict[str, dict[str, str]],
        publish: GateEventPublisher,
        review_snapshot: ReviewSnapshotSink | None = None,
        action_timeout: float = 3_600,
    ) -> None:
        canonical_origins = [validate_approved_origin(origin) for origin in approved_origins]
        if not canonical_origins or len(canonical_origins) > MAX_APPROVED_ORIGINS:
            raise ValueError("approved origins must contain 1 to 20 entries")
        if len(set(canonical_origins)) != len(canonical_origins):
            raise ValueError("approved origins must be unique")
        if action_timeout <= 0:
            raise ValueError("action_timeout must be positive")
        self._job_url = job_url
        self._candidate = candidate
        self._approved_origins = canonical_origins
        self._sensitive_data = sensitive_data
        self._placeholders = dict(candidate.direct_fields)
        self._publish = publish
        self._review_snapshot = review_snapshot
        self._action_timeout = action_timeout
        self._lock = asyncio.Lock()
        self._pending: _PendingGate | None = None
        self._cancelled = False
        self._revision_count = 0
        self._ready_accepted = False

    @property
    def approved_origins(self) -> tuple[str, ...]:
        return tuple(self._approved_origins)

    @property
    def revision_count(self) -> int:
        return self._revision_count

    @property
    def sensitive_data(self) -> dict[str, dict[str, str]]:
        return self._sensitive_data

    @property
    def placeholder_values(self) -> dict[str, str]:
        return dict(self._placeholders)

    def is_origin_approved(self, origin: str) -> bool:
        return validate_approved_origin(origin) in self._approved_origins

    @property
    def ready_accepted(self) -> bool:
        return self._ready_accepted

    @property
    def pending_kind(self) -> GateKind | None:
        pending = self._pending
        return pending.kind if pending is not None and not pending.future.done() else None

    async def request_human_navigation(
        self,
        instruction: str,
        browser_session: BrowserSession,
    ) -> ActionResult:
        decision, _ = await self._wait_for_gate(
            kind="navigation",
            browser_session=browser_session,
            state="awaiting_human_navigation",
            event="human_navigation_required",
            detail={
                "instruction": redact_public_text(instruction, self._placeholders)
                or "Human action is required"
            },
        )
        if decision == "cancel":
            return await self._cancelled_result(browser_session)
        try:
            current_origin = _origin_from_url(await browser_session.get_current_page_url())
        except (RuntimeError, ValueError):
            return await self._cancelled_result(browser_session)
        if current_origin not in self._approved_origins:
            origin_result = await self.request_origin_approval(current_origin, browser_session)
            if origin_result.is_done:
                return origin_result
        await self._publish("running", None, {})
        return ActionResult(
            extracted_content="Human navigation completed.",
            long_term_memory="Human navigation completed; re-scan the current page before acting.",
        )

    async def request_origin_approval(
        self,
        origin: str,
        browser_session: BrowserSession,
    ) -> ActionResult:
        canonical_origin = validate_approved_origin(origin)
        if canonical_origin in self._approved_origins:
            return ActionResult(
                extracted_content="Origin is already approved.",
                long_term_memory="The current origin is approved.",
            )
        if len(self._approved_origins) >= MAX_APPROVED_ORIGINS:
            return await self._cancelled_result(browser_session)
        decision, _ = await self._wait_for_gate(
            kind="origin",
            browser_session=browser_session,
            state="awaiting_origin_approval",
            event="origin_approval_required",
            detail={"origin": canonical_origin},
            origin=canonical_origin,
        )
        if decision == "cancel":
            return await self._cancelled_result(browser_session)
        try:
            current_origin = _origin_from_url(
                await browser_session.get_current_page_url()
            )
        except (RuntimeError, ValueError):
            return await self._cancelled_result(browser_session)
        if current_origin not in self._approved_origins:
            return await self.request_origin_approval(current_origin, browser_session)
        await self._publish("running", None, {})
        return ActionResult(
            extracted_content="Origin approved.",
            long_term_memory="The new origin is approved; re-scan the page before entering data.",
        )

    async def request_human_review(
        self,
        result: ApplicationRunResult,
        browser_session: BrowserSession,
    ) -> ActionResult:
        review_result = sanitize_application_result(
            result,
            self._placeholders,
            self._revision_count,
        )
        if self._review_snapshot is not None:
            await self._review_snapshot(review_result)
        decision, context = await self._wait_for_gate(
            kind="review",
            browser_session=browser_session,
            state="awaiting_human_review",
            event="review_required",
            detail={},
        )
        if decision == "revise" and context is not None:
            return ActionResult(
                extracted_content="Human revision received. Apply it, re-scan the form, then request review again.",
                long_term_memory=context,
                metadata={"revision_count": self._revision_count},
            )
        if decision == "ready":
            ready_result = review_result
            return ActionResult(
                is_done=True,
                success=True,
                extracted_content=ready_result.model_dump_json(),
                long_term_memory="Application is ready for the human to review and submit.",
            )
        return await self._cancelled_result(browser_session, review_result)

    async def continue_navigation(self) -> None:
        async with self._lock:
            pending = self._require_pending("navigation")
            pending.future.set_result(("continue", None))

    async def approve_origin(self, origin: str) -> None:
        canonical_origin = validate_approved_origin(origin)
        async with self._lock:
            pending = self._require_pending("origin")
            if pending.origin != canonical_origin:
                raise self._conflict("The approved origin does not match the pending origin")
            if len(self._approved_origins) >= MAX_APPROVED_ORIGINS:
                raise self._conflict("The approved-origin limit was reached")
            domains = pending.browser_session.browser_profile.allowed_domains
            if not isinstance(domains, list) or not domains:
                raise RuntimeError("Browser allowlist is not a mutable nonempty list")
            pattern = f"{canonical_origin}/"
            if pattern in domains or canonical_origin in self._approved_origins:
                raise self._conflict("The origin is already approved")
            domains.append(pattern)
            self._approved_origins.append(canonical_origin)
            self._sensitive_data[canonical_origin] = dict(self._placeholders)
            pending.future.set_result(("approve", None))

    async def revise(self, context: str) -> None:
        trimmed = context.strip()
        if not trimmed or len(trimmed) > 20_000:
            raise HarnessServiceError(422, "invalid_request", "Revision context is invalid")
        async with self._lock:
            pending = self._require_pending("review")
            if self._revision_count >= 100:
                raise self._conflict("The revision limit was reached")
            self._revision_count += 1
            await self._publish(
                "running",
                "revision_applied",
                {"revision_count": self._revision_count},
            )
            pending.future.set_result(("revise", trimmed))

    async def ready(self) -> None:
        async with self._lock:
            pending = self._require_pending("review")
            self._ready_accepted = True
            pending.future.set_result(("ready", None))

    async def cancel(self) -> None:
        async with self._lock:
            self._cancelled = True
            pending = self._pending
            if pending is not None and not pending.future.done():
                pending.future.set_result(("cancel", None))

    async def _wait_for_gate(
        self,
        *,
        kind: GateKind,
        browser_session: BrowserSession,
        state: SessionState,
        event: str,
        detail: Mapping[str, object],
        origin: str | None = None,
    ) -> tuple[DecisionKind, str | None]:
        async with self._lock:
            if self._cancelled:
                return "cancel", None
            if self._pending is not None and not self._pending.future.done():
                raise RuntimeError("A human gate is already pending")
            future = asyncio.get_running_loop().create_future()
            pending = _PendingGate(kind, future, browser_session, origin)
            self._pending = pending
            await self._publish(state, event, detail)
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=self._action_timeout)
        except TimeoutError:
            async with self._lock:
                self._cancelled = True
                if not future.done():
                    future.set_result(("cancel", None))
            return "cancel", None
        finally:
            async with self._lock:
                if self._pending is pending:
                    self._pending = None

    def _require_pending(self, kind: GateKind) -> _PendingGate:
        pending = self._pending
        if pending is None or pending.kind != kind or pending.future.done():
            raise self._conflict("No matching human gate is pending")
        return pending

    def _conflict(self, message: str) -> HarnessServiceError:
        return HarnessServiceError(409, "command_conflict", message)

    async def _cancelled_result(
        self,
        browser_session: BrowserSession,
        result: ApplicationRunResult | None = None,
    ) -> ActionResult:
        try:
            current_url = sanitize_public_url(await browser_session.get_current_page_url())
        except Exception:
            current_url = sanitize_public_url(self._job_url)
        if result is not None:
            cancelled = ApplicationRunResult.model_validate(
                {
                    **result.model_dump(),
                    "status": "cancelled",
                    "final_url": current_url,
                    "revision_count": self._revision_count,
                    "submit_attempted": False,
                }
            )
        else:
            cancelled = ApplicationRunResult(
                status="cancelled",
                company=None,
                role=None,
                job_url=self._job_url,
                final_url=current_url,
                revision_count=self._revision_count,
                submit_attempted=False,
            )
        return ActionResult(
            is_done=True,
            success=False,
            extracted_content=cancelled.model_dump_json(),
            long_term_memory="The browser harness session was cancelled.",
        )


class _HarnessTools(Tools):
    _RECOVERY_ACTIONS = frozenset(
        {
            "request_human_navigation",
            "request_origin_approval",
            "report_application_mismatch",
            "navigate",
            "go_back",
            "switch",
            "close",
        }
    )
    _SENSITIVE_INPUT_ACTIONS = frozenset({"input", "select_dropdown"})

    def __init__(
        self,
        human_gate: HumanGate,
        resume_upload_path: str | None,
    ) -> None:
        super().__init__()
        self._human_gate = human_gate
        self._resume_upload_path = resume_upload_path

        original_replace_sensitive_data = self.registry._replace_sensitive_data

        def replace_sensitive_data_at_dispatch(params, sensitive_data, current_url=None):
            del sensitive_data
            try:
                current_origin = _origin_from_url(current_url or "")
            except (RuntimeError, ValueError):
                scoped_values: dict[str, str] = {}
            else:
                scoped_values = (
                    self._human_gate.placeholder_values
                    if self._human_gate.is_origin_approved(current_origin)
                    else {}
                )
            return original_replace_sensitive_data(
                params,
                scoped_values,
                current_url,
            )

        # Browser Use 0.13.4 performs placeholder expansion in Registry immediately
        # before dispatch. Recheck the exact live origin there instead of relying on
        # its port-insensitive domain matcher or only on the earlier policy check.
        self.registry._replace_sensitive_data = replace_sensitive_data_at_dispatch

        original_execute_action = self.registry.execute_action

        async def execute_action_at_exact_origin(
            *,
            action_name,
            params,
            browser_session=None,
            **context,
        ):
            if action_name not in self._RECOVERY_ACTIONS:
                try:
                    dispatch_origin = _origin_from_url(
                        await browser_session.get_current_page_url()
                    )
                except (AttributeError, RuntimeError, ValueError):
                    dispatch_origin = None
                if dispatch_origin not in self._human_gate.approved_origins:
                    return ActionResult(
                        error=(
                            "The current origin requires exact human approval "
                            "before this action."
                        )
                    )
            return await original_execute_action(
                action_name=action_name,
                params=params,
                browser_session=browser_session,
                **context,
            )

        self.registry.execute_action = execute_action_at_exact_origin

    async def act(
        self,
        action: ActionModel,
        browser_session: BrowserSession,
        page_extraction_llm: BaseChatModel | None = None,
        sensitive_data: dict[str, str | dict[str, str]] | None = None,
        available_file_paths: list[str] | None = None,
        file_system: FileSystem | None = None,
        extraction_schema: dict | None = None,
        action_timeout: float | None = None,
    ) -> ActionResult:
        del sensitive_data, available_file_paths
        active_actions = [
            (name, params)
            for name, params in action.model_dump(exclude_unset=True).items()
            if params is not None
        ]
        if len(active_actions) != 1:
            return ActionResult(error="Exactly one browser action is required.")
        action_name, params = active_actions[0]

        try:
            current_origin = _origin_from_url(
                await browser_session.get_current_page_url()
            )
        except (RuntimeError, ValueError):
            current_origin = None

        if (
            current_origin not in self._human_gate.approved_origins
            and action_name not in self._RECOVERY_ACTIONS
        ):
            return ActionResult(
                error="The current origin requires exact human approval before this action."
            )

        if action_name == "upload_file":
            upload_path = params.get("path") if isinstance(params, dict) else None
            if (
                self._resume_upload_path is None
                or upload_path != self._resume_upload_path
            ):
                return ActionResult(
                    error="Only the supplied resume path may be uploaded."
                )

        scoped_sensitive_data: dict[str, str] | None = None
        if (
            action_name in self._SENSITIVE_INPUT_ACTIONS
            and current_origin is not None
            and self._human_gate.is_origin_approved(current_origin)
        ):
            scoped_sensitive_data = self._human_gate.placeholder_values

        allowed_file_paths = (
            [self._resume_upload_path]
            if self._resume_upload_path is not None
            else []
        )
        return await super().act(
            action,
            browser_session,
            page_extraction_llm=page_extraction_llm,
            sensitive_data=scoped_sensitive_data,
            available_file_paths=allowed_file_paths,
            file_system=file_system,
            extraction_schema=extraction_schema,
            action_timeout=action_timeout,
        )


def create_unfiltered_tools(
    human_gate: HumanGate,
    resume_upload_path: str | None = None,
) -> Tools:
    tools = _HarnessTools(human_gate, resume_upload_path)
    defaults = frozenset(tools.registry.registry.actions)
    if defaults != DEFAULT_ACTIONS_0_13_4:
        raise RuntimeError("Browser Use 0.13.4 default action registry changed")
    original_done = tools.registry.registry.actions["done"]

    @tools.action(
        "Pause while the human completes navigation, CAPTCHA, 2FA, or another manual step.",
        param_model=HumanNavigationRequest,
        terminates_sequence=True,
    )
    async def request_human_navigation(
        params: HumanNavigationRequest,
        browser_session: BrowserSession,
    ) -> ActionResult:
        return await human_gate.request_human_navigation(
            params.instruction,
            browser_session,
        )

    @tools.action(
        "Request approval for an exact new HTTPS origin before navigating to it or entering data there.",
        param_model=OriginApprovalRequest,
        terminates_sequence=True,
    )
    async def request_origin_approval(
        params: OriginApprovalRequest,
        browser_session: BrowserSession,
    ) -> ActionResult:
        return await human_gate.request_origin_approval(
            params.origin,
            browser_session,
        )

    @tools.action(
        "Stop because the open posting/form is closed or materially mismatches the requested company or role.",
        terminates_sequence=True,
    )
    async def report_application_mismatch(
        browser_session: BrowserSession,
    ) -> ActionResult:
        del browser_session
        return ActionResult(
            is_done=True,
            success=False,
            extracted_content=APPLICATION_MISMATCH_RESULT,
            long_term_memory="The open page does not match the requested active job.",
        )

    @tools.action(
        "Pause for final human review after every field is handled and before any final submission.",
        param_model=ApplicationRunResult,
        terminates_sequence=True,
    )
    async def request_human_review(
        params: ApplicationRunResult,
        browser_session: BrowserSession,
    ) -> ActionResult:
        return await human_gate.request_human_review(params, browser_session)

    if tools.registry.registry.actions["done"] is not original_done:
        raise RuntimeError("Browser Use done action was replaced")
    return tools
