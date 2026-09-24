export type GateKind = "navigation" | "credentials" | "additional_info" | "review";
export type GateState =
  | "running"
  | "awaiting_human_navigation"
  | "awaiting_additional_info"
  | "awaiting_human_review";

export interface GatePublication {
  state: GateState;
  event: string | null;
  detail: Record<string, unknown>;
}

export interface BrowserGateRuntime {
  getCurrentPageUrl(): Promise<string>;
  suppressPrivateCapture(): Promise<void>;
  activatePrivateValues(values: readonly string[]): Promise<void>;
  signIn(input: Record<string, string | undefined>): Promise<void>;
}

export interface UserInfoStorePort {
  merge(
    jobUrl: string,
    questions: readonly AdditionalInfoQuestion[],
    answers: readonly AdditionalInfoAnswer[],
  ): Promise<readonly unknown[]>;
}
export interface StoredCredential {
  origin: string;
  username: string;
  password: string;
}

export interface CredentialStorePort {
  credentialsForOrigin(origin: string): Promise<readonly StoredCredential[]>;
  upsert(origin: string, username: string, password: string): Promise<void>;
}
export interface AdditionalInfoQuestion {
  id: string;
  key: string;
  scope: "global" | "application";
  question: string;
  answer_type: "text" | "boolean" | "single_select" | "multi_select";
  options?: readonly { id: string; label: string }[];
}

export type AdditionalInfoAnswer =
  | { id: string; status: "declined" }
  | { id: string; status: "answered"; raw_value: string; value: string }
  | { id: string; status: "answered"; value: boolean }
  | { id: string; status: "answered"; option_id: string }
  | { id: string; status: "answered"; option_ids: readonly string[] };

export interface HumanReviewResult {
  fields_needing_human: readonly unknown[];
  revision_count?: number;
  [key: string]: unknown;
}

export interface GateResult {
  success: boolean;
  done: boolean;
  interrupted: boolean;
  extractedContent: string;
  longTermMemory: string;
  metadata: Record<string, unknown>;
}

export class HumanGateError extends Error {
  readonly status = 409;
  readonly code = "command_conflict";

  constructor(message: string) {
    super(message);
    this.name = "HumanGateError";
  }
}

type GateDecision =
  | { type: "continue" }
  | { type: "cancel" }
  | { type: "interrupted" }
  | { type: "sign_in" }
  | { type: "save_credentials" }
  | { type: "additional_info"; answers: readonly unknown[] }
  | { type: "continue_without_additional_info" }
  | { type: "submit" }
  | { type: "revise"; context: string };

interface PendingGate {
  kind: GateKind;
  resolve(decision: GateDecision): void;
  promise: Promise<GateDecision>;
  settled: boolean;
  runtime?: BrowserGateRuntime;
  credentialStore?: CredentialStorePort;
  loginOrigin?: string;
  usernameRef?: string;
  passwordRef?: string;
  passwordConfirmationRef?: string;
  submitRef?: string;
  questions?: readonly AdditionalInfoQuestion[];
  storageQuestions?: readonly AdditionalInfoQuestion[];
}

export interface HumanGateOptions {
  jobUrl: string;
  privateValues: Iterable<string>;
  userInfoStore: UserInfoStorePort;
  publish(publication: GatePublication): Promise<void>;
  autoSubmit?: boolean;
  defaultCredentials?: readonly [string, string];
  reviewSnapshot?(result: HumanReviewResult): Promise<void>;
}

function validBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function redactedText(value: string, privateValues: Iterable<string>, maximum: number): string {
  let redacted = value;
  for (const privateValue of privateValues) {
    if (!privateValue) continue;
    redacted = redacted.split(privateValue).join("[redacted]");
    redacted = redacted.split(encodeURIComponent(privateValue)).join("[redacted]");
  }
  const bounded = redacted.slice(0, maximum);
  return bounded || "Human action is required";
}
export function redactedUrl(value: string, privateValues: Iterable<string>): string {
  try {
    const url = new URL(value);
    let path = url.pathname;
    for (const privateValue of privateValues) {
      if (!privateValue) continue;
      path = path.split(privateValue).join("[redacted]");
      path = path.split(encodeURIComponent(privateValue)).join("[redacted]");
    }
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return value;
  }
}

function gateResult(overrides: Partial<GateResult> = {}): GateResult {
  return {
    success: true,
    done: false,
    interrupted: false,
    extractedContent: "",
    longTermMemory: "",
    metadata: {},
    ...overrides,
  };
}

export class HumanGate {
  readonly #jobUrl: string;
  readonly #privateValues: Set<string>;
  readonly #userInfoStore: UserInfoStorePort;
  readonly #publish: (publication: GatePublication) => Promise<void>;
  readonly #autoSubmit: boolean;
  readonly #defaultCredentials: readonly [string, string] | undefined;
  readonly #reviewSnapshot: ((result: HumanReviewResult) => Promise<void>) | undefined;
  #pending: PendingGate | null = null;
  #credentialMutation: Promise<void> | null = null;
  #credentialValuesActivated = false;
  readonly #triedCredentials = new Set<string>();
  #submissionApproved = false;
  #revisionCount = 0;
  #cancelled = false;

  constructor(options: HumanGateOptions) {
    this.#jobUrl = new URL(options.jobUrl).toString();
    this.#privateValues = new Set([...options.privateValues].filter(Boolean));
    this.#userInfoStore = options.userInfoStore;
    this.#publish = options.publish;
    this.#autoSubmit = options.autoSubmit ?? false;
    this.#defaultCredentials = options.defaultCredentials;
    this.#reviewSnapshot = options.reviewSnapshot;
    if (this.#defaultCredentials) {
      this.#privateValues.add(this.#defaultCredentials[0]);
      this.#privateValues.add(this.#defaultCredentials[1]);
    }
  }

  get pendingKind(): GateKind | null {
    return this.#pending?.settled === false ? this.#pending.kind : null;
  }
  get redactionValues(): readonly string[] {
    return [...this.#privateValues];
  }

  get screenshotsSuppressed(): boolean {
    return this.#credentialValuesActivated;
  }
  get submissionApproved(): boolean {
    return this.#submissionApproved;
  }

  get revisionCount(): number {
    return this.#revisionCount;
  }

  async requestHumanNavigation(
    instruction: string,
    runtime: BrowserGateRuntime,
  ): Promise<GateResult> {
    let publicInstruction = redactedText(instruction, this.#privateValues, 2_000);
    while (true) {
      const decision = await this.#waitForGate(
        "navigation",
        "awaiting_human_navigation",
        "human_navigation_required",
        { instruction: publicInstruction },
      );
      if (decision.type === "interrupted") {
        return gateResult({
          interrupted: true,
          extractedContent: JSON.stringify({ type: "interrupted" }),
          longTermMemory: "Operator guidance interrupted the pending action. Follow the latest operator guidance before continuing.",
        });
      }
      if (decision.type === "cancel") return this.#cancelledResult(runtime);
      if (!validBrowserUrl(await runtime.getCurrentPageUrl())) {
        publicInstruction =
          "The current page could not be inspected as a valid application page. Navigate to the application website, then choose Continue.";
        continue;
      }
      await this.#publish({ state: "running", event: null, detail: {} });
      return gateResult({
        extractedContent: "Human navigation completed.",
        longTermMemory: "Human navigation completed; re-scan the current page before acting.",
      });
    }
  }
  async requestSignIn(input: {
    accountAction?: "create_account" | "sign_in";
    usernameRef: string;
    passwordRef: string;
    passwordConfirmationRef?: string;
    submitRef: string;
    runtime: BrowserGateRuntime;
    credentialStore: CredentialStorePort;
  }): Promise<GateResult> {
    await input.runtime.suppressPrivateCapture();
    const loginUrl = new URL(await input.runtime.getCurrentPageUrl());
    const loginOrigin = loginUrl.origin;
    const accountAction = input.accountAction ?? "sign_in";
    let credentials: readonly [string, string] | null = null;
    let defaultAccount = false;
    if (this.#defaultCredentials) {
      const key = JSON.stringify([loginOrigin, ...this.#defaultCredentials, accountAction]);
      if (!this.#triedCredentials.has(key)) {
        credentials = this.#defaultCredentials;
        defaultAccount = true;
      }
    }
    if (!credentials) {
      const saved = await input.credentialStore.credentialsForOrigin(loginOrigin);
      for (const credential of saved) {
        const key = JSON.stringify([loginOrigin, credential.username, credential.password, accountAction]);
        if (!this.#triedCredentials.has(key)) {
          credentials = [credential.username, credential.password];
          break;
        }
      }
    }
    if (credentials) {
      this.#triedCredentials.add(JSON.stringify([loginOrigin, ...credentials, accountAction]));
      await this.#performSignIn(input, credentials[0], credentials[1]);
      return gateResult({ metadata: {
        sign_in_status: "attempted",
        account_origin: loginOrigin,
        ...(defaultAccount ? { default_account: true } : {}),
      } });
    }

    const decision = await this.#waitForGate(
      "credentials",
      "awaiting_human_navigation",
      "credentials_required",
      {},
      {
        runtime: input.runtime,
        credentialStore: input.credentialStore,
        loginOrigin,
        usernameRef: input.usernameRef,
        passwordRef: input.passwordRef,
        ...(input.passwordConfirmationRef === undefined
          ? {}
          : { passwordConfirmationRef: input.passwordConfirmationRef }),
        submitRef: input.submitRef,
      },
    );
    if (decision.type === "interrupted") return this.#interruptedResult();
    if (decision.type === "cancel") return this.#cancelledResult(input.runtime);
    await this.#publish({ state: "running", event: null, detail: {} });
    return gateResult({ metadata: {
      sign_in_status: decision.type === "save_credentials" ? "saved" : "attempted",
    } });
  }

  async signIn(username: string, password: string): Promise<void> {
    const pending = this.#requirePending("credentials");
    if (this.#credentialMutation) {
      throw new HumanGateError("A credential command is already pending");
    }
    if (!pending.runtime || !pending.credentialStore || !pending.loginOrigin ||
        !pending.usernameRef || !pending.passwordRef || !pending.submitRef) {
      throw new Error("Credential gate is incomplete");
    }
    const mutation = (async () => {
      await this.#performSignIn({
        runtime: pending.runtime!,
        usernameRef: pending.usernameRef!,
        passwordRef: pending.passwordRef!,
        ...(pending.passwordConfirmationRef === undefined
          ? {}
          : { passwordConfirmationRef: pending.passwordConfirmationRef }),
        submitRef: pending.submitRef!,
      }, username, password);
      await pending.credentialStore!.upsert(pending.loginOrigin!, username, password);
      if (this.#pending !== pending) throw new HumanGateError("The credential gate changed");
      this.#resolvePending("credentials", { type: "sign_in" });
    })();
    this.#credentialMutation = mutation;
    try {
      await mutation;
    } finally {
      if (this.#credentialMutation === mutation) this.#credentialMutation = null;
    }
  }
  getPendingTextQuestion(questionId: string): AdditionalInfoQuestion {
    const pending = this.#requirePending("additional_info");
    const question = pending.questions?.find(
      (candidate) => candidate.id === questionId && candidate.answer_type === "text",
    );
    if (!question) throw new HumanGateError("No matching text question is pending");
    return question;
  }

  async saveCredentials(username: string, password: string): Promise<void> {
    const pending = this.#requirePending("credentials");
    if (this.#credentialMutation) {
      throw new HumanGateError("A credential command is already pending");
    }
    if (!pending.runtime || !pending.credentialStore || !pending.loginOrigin) {
      throw new Error("Credential gate is incomplete");
    }
    const mutation = (async () => {
      this.#privateValues.add(username);
      this.#privateValues.add(password);
      this.#credentialValuesActivated = true;
      await pending.runtime!.activatePrivateValues([username, password]);
      await pending.credentialStore!.upsert(pending.loginOrigin!, username, password);
      if (this.#pending !== pending) throw new HumanGateError("The credential gate changed");
      this.#resolvePending("credentials", { type: "save_credentials" });
    })();
    this.#credentialMutation = mutation;
    try {
      await mutation;
    } finally {
      if (this.#credentialMutation === mutation) this.#credentialMutation = null;
    }
  }

  async requestAdditionalInfo(
    questions: readonly AdditionalInfoQuestion[],
    _runtime: BrowserGateRuntime,
  ): Promise<GateResult> {
    if (questions.length < 1 || questions.length > 20 ||
        new Set(questions.map((question) => question.id)).size !== questions.length ||
        new Set(questions.map((question) => JSON.stringify([question.scope, question.key]))).size !== questions.length) {
      const error = new Error("Request is invalid") as Error & { status: number; code: string };
      error.status = 422;
      error.code = "invalid_request";
      throw error;
    }
    const publicQuestions = questions.map((question) => ({ ...question }));
    const storageQuestions = questions.map((question) => ({
      ...question,
      question: redactedText(question.question, this.#privateValues, 500),
    }));
    const decision = await this.#waitForGate(
      "additional_info",
      "awaiting_additional_info",
      "additional_info_required",
      { questions: publicQuestions },
      { questions, storageQuestions },
    );
    if (decision.type === "interrupted") return this.#interruptedResult();
    if (decision.type === "cancel") return this.#cancelledResult(_runtime);
    if (decision.type === "continue_without_additional_info") {
      return gateResult({
        extractedContent: JSON.stringify({ type: "continue_without_additional_info" }),
        longTermMemory: "The human chose Continue without providing answers. Re-inspect the current application step and continue without inventing information.",
      });
    }
    if (decision.type !== "additional_info") throw new Error("Invalid additional-information decision");
    return gateResult({
      extractedContent: JSON.stringify({ type: "additional_info", answers: decision.answers }),
      longTermMemory: "Human-provided information was saved. Apply it, re-scan the current application step, and continue.",
    });
  }

  async provideAdditionalInfo(answers: readonly AdditionalInfoAnswer[]): Promise<void> {
    const pending = this.#requirePending("additional_info");
    if (!pending.questions || !pending.storageQuestions) {
      throw new Error("Additional-information gate is incomplete");
    }
    const questionIds = new Set(pending.questions.map((question) => question.id));
    const answerIds = answers.map((answer) => answer.id);
    if (answers.length !== pending.questions.length ||
        new Set(answerIds).size !== answerIds.length ||
        answerIds.some((id) => !questionIds.has(id))) {
      throw new HumanGateError(
        answers.length === pending.questions.length
          ? "The additional-information answers do not match the pending questions"
          : "The additional-information answers are incomplete",
      );
    }
    for (const answer of answers) {
      if ("raw_value" in answer) {
        this.#privateValues.add(answer.raw_value);
        this.#privateValues.add(answer.value);
      }
    }
    const accepted = await this.#userInfoStore.merge(
      this.#jobUrl,
      pending.storageQuestions,
      answers,
    );
    await this.#publish({
      state: "running",
      event: "additional_info_saved",
      detail: { count: accepted.length },
    });
    this.#resolvePending("additional_info", { type: "additional_info", answers: accepted });
  }

  async continueWithoutAdditionalInfo(): Promise<void> {
    this.#requirePending("additional_info");
    await this.#publish({ state: "running", event: null, detail: {} });
    this.#resolvePending("additional_info", { type: "continue_without_additional_info" });
  }
  async requestHumanReview(
    result: HumanReviewResult,
    runtime: BrowserGateRuntime,
  ): Promise<GateResult> {
    const reviewed = this.#sanitizeReviewResult(result);
    await this.#reviewSnapshot?.(reviewed);
    if (this.#autoSubmit) {
      if (reviewed.fields_needing_human.length > 0) {
        const error = new Error("Request is invalid") as Error & { status: number; code: string };
        error.status = 422;
        error.code = "invalid_request";
        throw error;
      }
      if (this.#submissionApproved) {
        throw new HumanGateError("Final submission was already approved");
      }
      if (this.#cancelled) return this.#cancelledResult(runtime, reviewed);
      if (this.#pending && !this.#pending.settled) {
        throw new Error("A human gate is already pending");
      }
      this.#submissionApproved = true;
      return gateResult({
        extractedContent: JSON.stringify(reviewed),
        longTermMemory: "You're good to submit.",
      });
    }

    const decision = await this.#waitForGate(
      "review",
      "awaiting_human_review",
      "review_required",
      {},
    );
    if (decision.type === "interrupted") return this.#interruptedResult();
    if (decision.type === "cancel") return this.#cancelledResult(runtime, reviewed);
    if (decision.type === "revise") {
      return gateResult({
        extractedContent: "Human revision received. Apply it, re-scan the form, then request review again.",
        longTermMemory: decision.context,
        metadata: { revision_count: this.#revisionCount },
      });
    }
    if (decision.type !== "submit") throw new Error("Invalid review decision");
    return gateResult({
      extractedContent: JSON.stringify(reviewed),
      longTermMemory: "You're good to submit.",
    });
  }

  async revise(context: string): Promise<void> {
    this.#requirePending("review");
    const revised = context.trim();
    if (!revised || revised.length > 20_000) {
      const error = new Error("Revision context is invalid") as Error & { status: number; code: string };
      error.status = 422;
      error.code = "invalid_request";
      throw error;
    }
    if (this.#revisionCount >= 100) {
      throw new HumanGateError("The revision limit was reached");
    }
    this.#revisionCount += 1;
    await this.#publish({
      state: "running",
      event: "revision_applied",
      detail: { revision_count: this.#revisionCount },
    });
    this.#resolvePending("review", { type: "revise", context: revised });
  }

  async continueNavigation(): Promise<void> {
    this.#resolvePending("navigation", { type: "continue" });
  }
  async submit(): Promise<void> {
    this.#requirePending("review");
    this.#submissionApproved = true;
    this.#resolvePending("review", { type: "submit" });
  }
  async cancel(): Promise<void> {
    if (this.#credentialMutation) await this.#credentialMutation;
    this.#cancelled = true;
    this.#submissionApproved = false;
    const pending = this.#pending;
    if (!pending || pending.settled) return;
    this.#resolvePending(pending.kind, { type: "cancel" });
  }

  async resetAfterAgentFailure(privateValues: Iterable<string> = []): Promise<void> {
    if (this.#credentialMutation) await this.#credentialMutation;
    for (const value of privateValues) if (value) this.#privateValues.add(value);
    this.#submissionApproved = false;
    const pending = this.#pending;
    if (!pending || pending.settled) return;
    this.#resolvePending(pending.kind, { type: "interrupted" });
  }

  async interrupt(): Promise<boolean> {
    const pending = this.#pending;
    if (this.#credentialMutation) return false;
    if (!pending || pending.settled) return false;
    await this.#publish({ state: "running", event: null, detail: {} });
    pending.settled = true;
    pending.resolve({ type: "interrupted" });
    return true;
  }
  async #performSignIn(
    input: {
      runtime: BrowserGateRuntime;
      usernameRef: string;
      passwordRef: string;
      passwordConfirmationRef?: string;
      submitRef: string;
    },
    username: string,
    password: string,
  ): Promise<void> {
    this.#privateValues.add(username);
    this.#privateValues.add(password);
    this.#credentialValuesActivated = true;
    await input.runtime.signIn({
      usernameRef: input.usernameRef,
      passwordRef: input.passwordRef,
      passwordConfirmationRef: input.passwordConfirmationRef,
      submitRef: input.submitRef,
      username,
      password,
    });
  }

  #interruptedResult(): GateResult {
    return gateResult({
      interrupted: true,
      extractedContent: JSON.stringify({ type: "interrupted" }),
      longTermMemory: "Operator guidance interrupted the pending action. Follow the latest operator guidance before continuing.",
    });
  }

  #sanitizeReviewResult(result: HumanReviewResult): HumanReviewResult {
    const source = result as Record<string, unknown>;
    const safeText = (value: unknown, maximum: number): string | null => {
      if (typeof value !== "string") return null;
      const sanitized = redactedText(value, this.#privateValues, maximum);
      return sanitized === "Human action is required" && value.length === 0 ? null : sanitized;
    };
    const safeFields = (value: unknown, needsHuman: boolean): readonly unknown[] => {
      if (!Array.isArray(value)) return [];
      return value.map((entry) => {
        const field = entry as Record<string, unknown>;
        return {
          label: safeText(field.label, 500) ?? "Field",
          field_type: field.field_type,
          value_present: field.value_present,
          note: needsHuman ? "Needs human review" : "Filled",
        };
      });
    };
    const warnings = Array.isArray(source.warnings)
      ? source.warnings.flatMap((warning) => {
          const sanitized = safeText(warning, 1_000);
          return sanitized === null ? [] : [sanitized];
        })
      : [];
    return {
      status: "ready_for_submission",
      company: safeText(source.company, 500),
      role: safeText(source.role, 500),
      job_url: redactedUrl(
        typeof source.job_url === "string" ? source.job_url : this.#jobUrl,
        this.#privateValues,
      ),
      final_url: redactedUrl(
        typeof source.final_url === "string" ? source.final_url : this.#jobUrl,
        this.#privateValues,
      ),
      fields_filled: safeFields(source.fields_filled, false),
      fields_needing_human: safeFields(source.fields_needing_human, true),
      files_attached: Array.isArray(source.files_attached) && source.files_attached.length > 0
        ? ["resume.pdf"]
        : [],
      warnings,
      revision_count: this.#revisionCount,
      submit_attempted: false,
    };
  }
  async #cancelledResult(
    runtime: BrowserGateRuntime,
    result?: HumanReviewResult,
  ): Promise<GateResult> {
    let currentUrl: string;
    try {
      currentUrl = redactedUrl(await runtime.getCurrentPageUrl(), this.#privateValues);
    } catch {
      currentUrl = redactedUrl(this.#jobUrl, this.#privateValues);
    }
    const cancelled = result
      ? {
          ...result,
          status: "cancelled",
          final_url: currentUrl,
          revision_count: this.#revisionCount,
          submit_attempted: false,
        }
      : {
          status: "cancelled",
          company: null,
          role: null,
          job_url: redactedUrl(this.#jobUrl, this.#privateValues),
          final_url: currentUrl,
          fields_filled: [],
          fields_needing_human: [],
          files_attached: [],
          warnings: [],
          revision_count: this.#revisionCount,
          submit_attempted: false,
        };
    return gateResult({
      done: true,
      success: false,
      extractedContent: JSON.stringify(cancelled),
      longTermMemory: "The browser harness session was cancelled.",
    });
  }

  async #waitForGate(
    kind: GateKind,
    state: GateState,
    event: string,
    detail: Record<string, unknown>,
    context: Partial<Omit<PendingGate, "kind" | "resolve" | "promise" | "settled">> = {},
  ): Promise<GateDecision> {
    if (this.#submissionApproved && kind !== "navigation") {
      throw new HumanGateError("Final submission was already approved");
    }
    if (this.#cancelled) return { type: "cancel" };
    if (this.#pending && !this.#pending.settled) {
      throw new Error("A human gate is already pending");
    }
    let resolve!: (decision: GateDecision) => void;
    const promise = new Promise<GateDecision>((fulfill) => {
      resolve = fulfill;
    });
    const pending: PendingGate = { kind, resolve, promise, settled: false, ...context };
    this.#pending = pending;
    await this.#publish({ state, event, detail });
    try {
      return await promise;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }
  #requirePending(kind: GateKind): PendingGate {
    const pending = this.#pending;
    if (!pending || pending.kind !== kind || pending.settled) {
      throw new HumanGateError("No matching human gate is pending");
    }
    return pending;
  }

  #resolvePending(kind: GateKind, decision: GateDecision): void {
    const pending = this.#pending;
    if (!pending || pending.kind !== kind || pending.settled) {
      throw new HumanGateError("No matching human gate is pending");
    }
    pending.settled = true;
    pending.resolve(decision);
  }
}
