import asyncio
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol, TypeAlias
from urllib.parse import quote, unquote, urlsplit, urlunsplit


from . import DEFAULT_SESSION_TIMEOUT_SECONDS
from .playwright_cli import PlaywrightCliRuntimeError
from .credentials import CredentialStore
from .models import (
    AcceptedAdditionalInfoAnswer,
    AdditionalInfoBooleanCommandAnswer,
    AdditionalInfoBooleanQuestion,
    AdditionalInfoCommandAnswer,
    AdditionalInfoDeclinedCommandAnswer,
    AdditionalInfoMultiSelectCommandAnswer,
    AdditionalInfoMultiSelectQuestion,
    AdditionalInfoOption,
    AdditionalInfoQuestion,
    AdditionalInfoRuntimeActionResponse,
    AdditionalInfoSingleSelectCommandAnswer,
    AdditionalInfoSingleSelectQuestion,
    AdditionalInfoTextCommandAnswer,
    AdditionalInfoTextQuestion,
    CancelledApplicationResult,
    ReviewApplicationResult,
    FieldResult,
    HarnessServiceError,
    SessionState,
    sanitize_public_url,
    validate_approved_origin,
    session_error,
    validate_job_url,
)
from .user_info import UserInfoStore


MAX_APPROVED_ORIGINS = 20


GateEventPublisher = Callable[
    [SessionState, str | None, Mapping[str, object]], Awaitable[None]
]
ReviewSnapshotSink = Callable[[ReviewApplicationResult], Awaitable[None]]
GateKind = Literal["navigation", "credentials", "origin", "additional_info", "review"]
DecisionKind = Literal[
    "continue",
    "sign_in",
    "save_credentials",
    "approve",
    "additional_info",
    "revise",
    "submit",
    "cancel",
]
GatePayload: TypeAlias = str | tuple[AcceptedAdditionalInfoAnswer, ...] | None
GateDecision: TypeAlias = tuple[DecisionKind, GatePayload]

class BrowserGateRuntime(Protocol):
    async def get_current_page_url(self) -> str: ...

    async def set_approved_origins(self, origins: Sequence[str]) -> None: ...

    async def suspend_navigation_guard(self) -> None: ...
    async def suppress_private_capture(self) -> None: ...

    async def activate_private_values(self, values: Iterable[str]) -> None: ...
    async def verify_origin_and_activate_private_values(
        self,
        expected_origin: str,
        values: Iterable[str],
    ) -> str | None: ...

    async def sign_in(
        self,
        *,
        expected_origin: str,
        username_ref: str,
        password_ref: str,
        submit_ref: str,
        username: str,
        password: str,
    ) -> None: ...


@dataclass(frozen=True, slots=True)
class GateResult:
    is_done: bool = False
    success: bool | None = None
    extracted_content: str | None = None
    long_term_memory: str | None = None
    metadata: dict[str, object] | None = None


@dataclass(slots=True)
class _PendingGate:
    kind: GateKind
    future: asyncio.Future[GateDecision]
    runtime: BrowserGateRuntime
    origin: str | None = None
    questions: tuple[AdditionalInfoQuestion, ...] = ()
    storage_questions: tuple[AdditionalInfoQuestion, ...] = ()
    login_origin: str | None = None
    username_ref: str | None = None
    password_ref: str | None = None
    submit_ref: str | None = None
    credential_store: CredentialStore | None = None


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
    private_values: Iterable[str],
    *,
    max_length: int | None = None,
) -> str | None:
    if value is None:
        return None
    redacted = _decode_public_text(value)
    secrets = {
        representation
        for secret in private_values
        if isinstance(secret, str) and secret
        for representation in (secret, _decode_public_text(secret))
        if representation
    }
    for secret in sorted(secrets, key=len, reverse=True):
        redacted = redacted.replace(secret, "[redacted]")
    if not redacted:
        redacted = "[redacted]"
    if max_length is not None:
        if max_length < 1:
            raise ValueError("max_length must be positive")
        if len(redacted) > max_length:
            redacted = redacted[: max_length - 1] + "…"
    return redacted


def redact_public_url(value: str, private_values: Iterable[str]) -> str:
    parsed = urlsplit(value)
    redacted_path = redact_public_text(parsed.path, private_values) or ""
    safe_path = quote(redacted_path, safe="/:@-._~!$&'()*+,;=[]")
    return sanitize_public_url(
        urlunsplit((parsed.scheme, parsed.netloc, safe_path, "", ""))
    )


def sanitize_application_result(
    result: ReviewApplicationResult,
    private_values: Iterable[str],
    revision_count: int,
) -> ReviewApplicationResult:
    redaction_values = tuple(private_values)

    def safe_field(field: FieldResult) -> FieldResult:
        label = redact_public_text(field.label, redaction_values) or "Field"
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
    return ReviewApplicationResult(
        status="ready_for_submission",
        company=redact_public_text(result.company, redaction_values),
        role=redact_public_text(result.role, redaction_values),
        job_url=redact_public_url(result.job_url, redaction_values),
        final_url=redact_public_url(result.final_url, redaction_values),
        fields_filled=[safe_field(field) for field in result.fields_filled],
        fields_needing_human=[
            safe_field(field) for field in result.fields_needing_human
        ],
        files_attached=["resume.pdf"] if result.files_attached else [],
        warnings=warnings,
        revision_count=revision_count,
        submit_attempted=False,
    )


def _prepare_additional_info_questions(
    questions: Sequence[AdditionalInfoQuestion],
    private_values: Iterable[str],
) -> tuple[
    tuple[AdditionalInfoQuestion, ...],
    tuple[AdditionalInfoQuestion, ...],
]:
    original = tuple(questions)
    if not 1 <= len(original) <= 20:
        raise HarnessServiceError(422, "invalid_request", "Request is invalid")
    if len({question.id for question in original}) != len(original):
        raise HarnessServiceError(422, "invalid_request", "Request is invalid")
    if len({(question.scope, question.key) for question in original}) != len(original):
        raise HarnessServiceError(422, "invalid_request", "Request is invalid")
    redaction_values = frozenset(private_values)
    public: list[AdditionalInfoQuestion] = []
    storage: list[AdditionalInfoQuestion] = []
    for question in original:
        safe_question = redact_public_text(
            question.question,
            redaction_values,
            max_length=500,
        )
        assert safe_question is not None
        storage.append(
            question.model_copy(
                deep=True,
                update={"question": safe_question},
            )
        )
        if isinstance(
            question,
            (AdditionalInfoSingleSelectQuestion, AdditionalInfoMultiSelectQuestion),
        ):
            safe_options = [
                AdditionalInfoOption(
                    id=option.id,
                    label=redact_public_text(
                        option.label,
                        redaction_values,
                        max_length=200,
                    )
                    or "[redacted]",
                )
                for option in question.options
            ]
            public.append(
                question.model_copy(
                    deep=True,
                    update={
                        "question": safe_question,
                        "options": safe_options,
                    },
                )
            )
        else:
            public.append(
                question.model_copy(
                    deep=True,
                    update={"question": safe_question},
                )
            )
    return tuple(public), tuple(storage)


def _private_values_from_answers(
    questions: Sequence[AdditionalInfoQuestion],
    answers: Sequence[AdditionalInfoCommandAnswer],
) -> frozenset[str]:
    if len(answers) != len(questions):
        raise HarnessServiceError(
            409,
            "command_conflict",
            "The additional-information answers are incomplete",
        )
    question_by_id = {question.id: question for question in questions}
    answer_by_id: dict[str, AdditionalInfoCommandAnswer] = {}
    for answer in answers:
        if answer.id in answer_by_id or answer.id not in question_by_id:
            raise HarnessServiceError(
                409,
                "command_conflict",
                "The additional-information answers do not match the pending questions",
            )
        answer_by_id[answer.id] = answer
    if set(answer_by_id) != set(question_by_id):
        raise HarnessServiceError(
            409,
            "command_conflict",
            "The additional-information answers are incomplete",
        )

    values: set[str] = set()
    for question in questions:
        answer = answer_by_id[question.id]
        if isinstance(answer, AdditionalInfoDeclinedCommandAnswer):
            continue
        if isinstance(question, AdditionalInfoTextQuestion) and isinstance(
            answer, AdditionalInfoTextCommandAnswer
        ):
            values.add(answer.value)
            continue
        if isinstance(question, AdditionalInfoBooleanQuestion) and isinstance(
            answer, AdditionalInfoBooleanCommandAnswer
        ):
            continue
        if isinstance(question, AdditionalInfoSingleSelectQuestion) and isinstance(
            answer, AdditionalInfoSingleSelectCommandAnswer
        ):
            options = {option.id: option.label for option in question.options}
            if answer.option_id not in options:
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "An additional-information option is invalid",
                )
            values.add(options[answer.option_id])
            continue
        if isinstance(question, AdditionalInfoMultiSelectQuestion) and isinstance(
            answer, AdditionalInfoMultiSelectCommandAnswer
        ):
            options = {option.id: option.label for option in question.options}
            if any(option_id not in options for option_id in answer.option_ids):
                raise HarnessServiceError(
                    409,
                    "command_conflict",
                    "An additional-information option is invalid",
                )
            values.update(options[option_id] for option_id in answer.option_ids)
            continue
        raise HarnessServiceError(
            409,
            "command_conflict",
            "An additional-information answer has the wrong type",
        )
    return frozenset(values)


class HumanGate:
    def __init__(
        self,
        *,
        job_url: str,
        private_values: Iterable[str],
        user_info_store: UserInfoStore,
        approved_origins: Sequence[str],
        publish: GateEventPublisher,
        review_snapshot: ReviewSnapshotSink | None = None,
        auto_submit: bool = False,
        action_timeout: float = DEFAULT_SESSION_TIMEOUT_SECONDS,
    ) -> None:
        canonical_origins = [validate_approved_origin(origin) for origin in approved_origins]
        if not canonical_origins or len(canonical_origins) > MAX_APPROVED_ORIGINS:
            raise ValueError("approved origins must contain 1 to 20 entries")
        if len(set(canonical_origins)) != len(canonical_origins):
            raise ValueError("approved origins must be unique")
        if action_timeout <= 0:
            raise ValueError("action_timeout must be positive")
        if type(auto_submit) is not bool:
            raise ValueError("auto_submit must be a boolean")
        self._job_url = validate_job_url(job_url)
        self._approved_origins = canonical_origins
        self._redaction_values = {
            value
            for value in private_values
            if isinstance(value, str) and value
        }
        self._user_info_store = user_info_store
        self._publish = publish
        self._review_snapshot = review_snapshot
        self._auto_submit = auto_submit
        self._action_timeout = action_timeout
        self._lock = asyncio.Lock()
        self._pending: _PendingGate | None = None
        self._cancelled = False
        self._revision_count = 0
        self._submission_approved = False
        self._tried_credentials: set[tuple[str, str]] = set()
        self._credential_values_activated = False
        self._credential_command_task: asyncio.Task[None] | None = None

    @property
    def approved_origins(self) -> tuple[str, ...]:
        return tuple(self._approved_origins)

    @property
    def redaction_values(self) -> frozenset[str]:
        return frozenset(self._redaction_values)

    @property
    def revision_count(self) -> int:
        return self._revision_count

    @property
    def submission_approved(self) -> bool:
        return self._submission_approved

    @property
    def screenshots_suppressed(self) -> bool:
        return self._credential_values_activated

    @property
    def pending_kind(self) -> GateKind | None:
        pending = self._pending
        return pending.kind if pending is not None and not pending.future.done() else None

    async def request_human_navigation(
        self,
        instruction: str,
        runtime: BrowserGateRuntime,
    ) -> GateResult:
        await runtime.suspend_navigation_guard()
        try:
            decision, _ = await self._wait_for_gate(
                kind="navigation",
                runtime=runtime,
                state="awaiting_human_navigation",
                event="human_navigation_required",
                detail={
                    "instruction": redact_public_text(
                        instruction,
                        self._redaction_values,
                    )
                    or "Human action is required"
                },
            )
            if decision == "cancel":
                return await self._cancelled_result(runtime)
            try:
                current_origin = _origin_from_url(
                    await runtime.get_current_page_url()
                )
            except (RuntimeError, ValueError):
                return await self._cancelled_result(runtime)
            if current_origin not in self._approved_origins:
                origin_result = await self.register_origin(
                    current_origin,
                    runtime,
                )
                if origin_result.is_done:
                    return origin_result
            else:
                await self._publish("running", None, {})
            return GateResult(
                extracted_content="Human navigation completed.",
                long_term_memory=(
                    "Human navigation completed; re-scan the current page before acting."
                ),
            )
        finally:
            await runtime.set_approved_origins(self._approved_origins)
    async def request_sign_in(
        self,
        *,
        username_ref: str,
        password_ref: str,
        submit_ref: str,
        runtime: BrowserGateRuntime,
        credential_store: CredentialStore,
    ) -> GateResult:
        try:
            await runtime.suppress_private_capture()
        except PlaywrightCliRuntimeError as error:
            public = session_error(error.code)
            raise HarnessServiceError(
                504 if error.code == "session_timeout" else 502,
                public.code,
                public.message,
            ) from None
        except HarnessServiceError:
            raise
        except Exception:
            raise HarnessServiceError(
                502,
                "browser_failed",
                "Browser runtime failed.",
            ) from None
        try:
            login_origin = _origin_from_url(await runtime.get_current_page_url())
        except (RuntimeError, ValueError):
            raise HarnessServiceError(
                502,
                "browser_failed",
                "Browser runtime failed.",
            ) from None
        if login_origin not in self._approved_origins:
            raise HarnessServiceError(
                409,
                "command_conflict",
                "Sign-in requires an approved exact origin",
            )

        saved = credential_store.credentials_for_origin(login_origin)
        credential = next(
            (
                candidate
                for candidate in saved
                if (candidate.origin, candidate.username)
                not in self._tried_credentials
            ),
            None,
        )
        if credential is not None:
            self._tried_credentials.add((credential.origin, credential.username))
            await self._perform_sign_in(
                runtime=runtime,
                login_origin=login_origin,
                username_ref=username_ref,
                password_ref=password_ref,
                submit_ref=submit_ref,
                username=credential.username,
                password=credential.password,
            )
            return GateResult(metadata={"sign_in_status": "attempted"})

        decision, _ = await self._wait_for_gate(
            kind="credentials",
            runtime=runtime,
            state="awaiting_human_navigation",
            event="credentials_required",
            detail={},
            login_origin=login_origin,
            username_ref=username_ref,
            password_ref=password_ref,
            submit_ref=submit_ref,
            credential_store=credential_store,
        )
        if decision == "cancel":
            return await self._cancelled_result(runtime)
        status = "saved" if decision == "save_credentials" else "attempted"
        await self._publish("running", None, {})
        return GateResult(metadata={"sign_in_status": status})


    async def register_origin(
        self,
        origin: str,
        runtime: BrowserGateRuntime,
    ) -> GateResult:
        canonical_origin = validate_approved_origin(origin)
        cancelled = False
        capped = False
        already_approved = False
        async with self._lock:
            if self._cancelled:
                cancelled = True
            elif self._pending is not None and not self._pending.future.done():
                raise RuntimeError("A human gate is already pending")
            elif canonical_origin in self._approved_origins:
                already_approved = True
            elif len(self._approved_origins) >= MAX_APPROVED_ORIGINS:
                capped = True
            else:
                approved_origins = [*self._approved_origins, canonical_origin]
                await runtime.set_approved_origins(approved_origins)
                self._approved_origins.append(canonical_origin)
        if cancelled or capped:
            return await self._cancelled_result(runtime)
        if already_approved:
            return GateResult(
                extracted_content="Origin is already approved.",
                long_term_memory="The requested origin is approved.",
            )
        try:
            current_origin = _origin_from_url(
                await runtime.get_current_page_url()
            )
        except (RuntimeError, ValueError):
            return await self._cancelled_result(runtime)
        if current_origin not in self._approved_origins:
            return await self.register_origin(current_origin, runtime)
        await self._publish("running", None, {})
        return GateResult(
            extracted_content="Origin approved.",
            long_term_memory="The requested and current origins are approved.",
        )

    async def request_additional_info(
        self,
        questions: Sequence[AdditionalInfoQuestion],
        runtime: BrowserGateRuntime,
    ) -> GateResult:
        public_questions, storage_questions = _prepare_additional_info_questions(
            questions,
            self._redaction_values,
        )
        decision, payload = await self._wait_for_gate(
            kind="additional_info",
            runtime=runtime,
            state="awaiting_additional_info",
            event="additional_info_required",
            detail={"questions": list(public_questions)},
            questions=tuple(questions),
            storage_questions=storage_questions,
        )
        if decision == "cancel":
            return await self._cancelled_result(runtime)
        if decision != "additional_info" or not isinstance(payload, tuple):
            raise RuntimeError("Additional-information gate returned an invalid result")
        response = AdditionalInfoRuntimeActionResponse(
            type="additional_info",
            answers=list(payload),
        )
        return GateResult(
            extracted_content=response.model_dump_json(),
            long_term_memory=(
                "Human-provided information was saved. Apply it, re-scan the "
                "current application step, and continue."
            ),
        )

    async def request_human_review(
        self,
        result: ReviewApplicationResult,
        runtime: BrowserGateRuntime,
    ) -> GateResult:
        review_result = sanitize_application_result(
            result,
            self._redaction_values,
            self._revision_count,
        )
        if self._review_snapshot is not None:
            await self._review_snapshot(review_result)
        if not self._auto_submit:
            decision, context = await self._wait_for_gate(
                kind="review",
                runtime=runtime,
                state="awaiting_human_review",
                event="review_required",
                detail={},
            )
            if decision == "revise" and context is not None:
                return GateResult(
                    extracted_content=(
                        "Human revision received. Apply it, re-scan the form, "
                        "then request review again."
                    ),
                    long_term_memory=context,
                    metadata={"revision_count": self._revision_count},
                )
            if decision == "submit":
                return GateResult(
                    extracted_content=review_result.model_dump_json(),
                    long_term_memory="You're good to submit.",
                )
            return await self._cancelled_result(runtime, review_result)
        if review_result.fields_needing_human:
            raise HarnessServiceError(422, "invalid_request", "Request is invalid")
        async with self._lock:
            if self._submission_approved:
                raise self._conflict("Final submission was already approved")
            cancelled = self._cancelled
            if not cancelled:
                if self._pending is not None and not self._pending.future.done():
                    raise RuntimeError("A human gate is already pending")
                self._submission_approved = True
        if cancelled:
            return await self._cancelled_result(runtime, review_result)
        return GateResult(
            extracted_content=review_result.model_dump_json(),
            long_term_memory="You're good to submit.",
        )

    async def continue_navigation(self) -> None:
        async with self._lock:
            pending = self._require_pending("navigation")
            pending.future.set_result(("continue", None))

    async def approve_origin(self, origin: str) -> None:
        canonical_origin = validate_approved_origin(origin)
        async with self._lock:
            pending = self._require_pending("origin")
            if pending.origin != canonical_origin:
                raise self._conflict(
                    "The approved origin does not match the pending origin"
                )
            if len(self._approved_origins) >= MAX_APPROVED_ORIGINS:
                raise self._conflict("The approved-origin limit was reached")
            if canonical_origin in self._approved_origins:
                raise self._conflict("The origin is already approved")
            approved_origins = [*self._approved_origins, canonical_origin]
            await pending.runtime.set_approved_origins(approved_origins)
            self._approved_origins.append(canonical_origin)
            pending.future.set_result(("approve", None))
    async def sign_in(self, username: str, password: str) -> None:
        current_task = asyncio.current_task()
        if current_task is None:
            raise RuntimeError("Credential command has no owning task")
        async with self._lock:
            pending = self._require_pending("credentials")
            if (
                pending.login_origin is None
                or pending.username_ref is None
                or pending.password_ref is None
                or pending.submit_ref is None
            ):
                raise RuntimeError("Credential gate is incomplete")
            if (
                self._credential_command_task is not None
                and not self._credential_command_task.done()
            ):
                raise self._conflict("A credential command is already pending")
            self._credential_command_task = current_task
            runtime = pending.runtime
            login_origin = pending.login_origin
            username_ref = pending.username_ref
            password_ref = pending.password_ref
            submit_ref = pending.submit_ref
        try:
            await self._perform_sign_in(
                runtime=runtime,
                login_origin=login_origin,
                username_ref=username_ref,
                password_ref=password_ref,
                submit_ref=submit_ref,
                username=username,
                password=password,
            )
            async with self._lock:
                if self._pending is not pending:
                    raise self._conflict("The credential gate changed")
                self._require_pending("credentials")
                pending.future.set_result(("sign_in", None))
        finally:
            async with self._lock:
                if self._credential_command_task is current_task:
                    self._credential_command_task = None

    async def save_credentials(self, username: str, password: str) -> None:
        current_task = asyncio.current_task()
        if current_task is None:
            raise RuntimeError("Credential command has no owning task")
        async with self._lock:
            pending = self._require_pending("credentials")
            if pending.login_origin is None or pending.credential_store is None:
                raise RuntimeError("Credential gate is incomplete")
            if (
                self._credential_command_task is not None
                and not self._credential_command_task.done()
            ):
                raise self._conflict("A credential command is already pending")
            self._credential_command_task = current_task
            self._activate_credential_redaction(username, password)
            runtime = pending.runtime
            credential_store = pending.credential_store
            login_origin = pending.login_origin
        try:
            try:
                live_origin = (
                    await runtime.verify_origin_and_activate_private_values(
                        login_origin,
                        (username, password),
                    )
                )
                if live_origin is None:
                    raise self._conflict("The credential page changed")
                await credential_store.upsert(
                    live_origin,
                    username,
                    password,
                )
            except PlaywrightCliRuntimeError as error:
                public = session_error(error.code)
                raise HarnessServiceError(
                    504 if error.code == "session_timeout" else 502,
                    public.code,
                    public.message,
                ) from None
            except HarnessServiceError:
                raise
            except Exception:
                raise HarnessServiceError(
                    500,
                    "internal_error",
                    "Request failed",
                ) from None
            async with self._lock:
                if self._pending is not pending:
                    raise self._conflict("The credential gate changed")
                self._require_pending("credentials")
                pending.future.set_result(("save_credentials", None))
        finally:
            async with self._lock:
                if self._credential_command_task is current_task:
                    self._credential_command_task = None


    async def provide_additional_info(
        self,
        answers: Sequence[AdditionalInfoCommandAnswer],
    ) -> None:
        async with self._lock:
            pending = self._require_pending("additional_info")
            private_values = _private_values_from_answers(
                pending.questions,
                answers,
            )
            self._redaction_values.update(private_values)
            accepted = await self._user_info_store.merge(
                self._job_url,
                pending.storage_questions,
                answers,
            )
            await self._publish(
                "running",
                "additional_info_saved",
                {"count": len(accepted)},
            )
            pending.future.set_result(("additional_info", accepted))

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

    async def submit(self) -> None:
        async with self._lock:
            pending = self._require_pending("review")
            self._submission_approved = True
            pending.future.set_result(("submit", None))

    async def cancel(self) -> None:
        current_task = asyncio.current_task()
        async with self._lock:
            self._cancelled = True
            pending = self._pending
            if pending is not None and not pending.future.done():
                pending.future.set_result(("cancel", None))
            credential_task = self._credential_command_task
        if (
            credential_task is not None
            and credential_task is not current_task
            and not credential_task.done()
        ):
            credential_task.cancel()
            await asyncio.gather(credential_task, return_exceptions=True)

    async def _wait_for_gate(
        self,
        *,
        kind: GateKind,
        runtime: BrowserGateRuntime,
        state: SessionState,
        event: str,
        detail: Mapping[str, object],
        origin: str | None = None,
        questions: tuple[AdditionalInfoQuestion, ...] = (),
        storage_questions: tuple[AdditionalInfoQuestion, ...] = (),
        login_origin: str | None = None,
        username_ref: str | None = None,
        password_ref: str | None = None,
        submit_ref: str | None = None,
        credential_store: CredentialStore | None = None,
    ) -> GateDecision:
        async with self._lock:
            if self._submission_approved and kind not in {"navigation", "origin"}:
                raise self._conflict("Final submission was already approved")
            if self._cancelled:
                return "cancel", None
            if self._pending is not None and not self._pending.future.done():
                raise RuntimeError("A human gate is already pending")
            future: asyncio.Future[GateDecision] = (
                asyncio.get_running_loop().create_future()
            )
            pending = _PendingGate(
                kind=kind,
                future=future,
                runtime=runtime,
                origin=origin,
                questions=questions,
                storage_questions=storage_questions,
                login_origin=login_origin,
                username_ref=username_ref,
                password_ref=password_ref,
                submit_ref=submit_ref,
                credential_store=credential_store,
            )
            self._pending = pending
            await self._publish(state, event, detail)
        try:
            return await asyncio.wait_for(
                asyncio.shield(future),
                timeout=self._action_timeout,
            )
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

    async def _perform_sign_in(
        self,
        *,
        runtime: BrowserGateRuntime,
        login_origin: str,
        username_ref: str,
        password_ref: str,
        submit_ref: str,
        username: str,
        password: str,
    ) -> None:
        self._activate_credential_redaction(username, password)
        try:
            await runtime.sign_in(
                expected_origin=login_origin,
                username_ref=username_ref,
                password_ref=password_ref,
                submit_ref=submit_ref,
                username=username,
                password=password,
            )
        except PlaywrightCliRuntimeError as error:
            public = session_error(error.code)
            raise HarnessServiceError(
                504 if error.code == "session_timeout" else 502,
                public.code,
                public.message,
            ) from None
        except HarnessServiceError:
            raise
        except Exception:
            raise HarnessServiceError(
                502,
                "browser_failed",
                "Browser runtime failed.",
            ) from None

    def _activate_credential_redaction(
        self,
        username: str,
        password: str,
    ) -> None:
        self._redaction_values.update(
            value for value in (username, password) if value
        )
        self._credential_values_activated = True

    async def _cancelled_result(
        self,
        runtime: BrowserGateRuntime,
        result: ReviewApplicationResult | None = None,
    ) -> GateResult:
        try:
            current_url = redact_public_url(
                await runtime.get_current_page_url(),
                self._redaction_values,
            )
        except Exception:
            current_url = redact_public_url(self._job_url, self._redaction_values)
        if result is not None:
            cancelled = CancelledApplicationResult.model_validate(
                {
                    **result.model_dump(),
                    "status": "cancelled",
                    "final_url": current_url,
                    "revision_count": self._revision_count,
                    "submit_attempted": False,
                    "submission_confirmation": None,
                }
            )
        else:
            cancelled = CancelledApplicationResult(
                status="cancelled",
                company=None,
                role=None,
                job_url=redact_public_url(self._job_url, self._redaction_values),
                final_url=current_url,
                revision_count=self._revision_count,
                submit_attempted=False,
                submission_confirmation=None,
            )
        return GateResult(
            is_done=True,
            success=False,
            extracted_content=cancelled.model_dump_json(),
            long_term_memory="The browser harness session was cancelled.",
        )

