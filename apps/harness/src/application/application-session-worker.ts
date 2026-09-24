import { DEFAULT_APPLICATION_CREDENTIALS } from "./application-account.ts";
import { cleanupSessionArtifacts, HarnessServiceError, storeUploads } from "../host/artifacts.ts";
import { loadCandidateContext } from "./context.ts";
import type { GmailVerificationInbox } from "../host/gmail.ts";
import {
  AdditionalInfoRuntimeActionResponseSchema,
  CancelledApplicationResultSchema,
  ReviewApplicationResultSchema,
  RuntimeActionRequestSchema,
  PendingActionSchema,
  RuntimeActionResponseSchema,
  type ApplicationRunResult,
  type RuntimeActionRequest,
  type RuntimeActionResponse,
  type SessionCommand,
  type PendingAction,
  type PlaywrightCliDiagnostic,
} from "../contracts/models.ts";
import { HumanGate, redactedUrl, type AdditionalInfoQuestion, type GatePublication, type GateResult, type UserInfoStorePort } from "./human-gate.ts";
import { LocalApplicationAgent, type ApplicationModelMetadata, type ApplicationRunOptions } from "./application-agent.ts";
import type { ApplicationModel } from "../models/application-model.ts";
import { PipelineApplicationSubmissionGuard } from "./pipeline-submission-guard.ts";
import { PlaywrightCliRuntime, PlaywrightCliRuntimeError, type PlaywrightCliBrowser, type PlaywrightCliExecutionResult } from "../host/playwright-cli.ts";
import { buildApplicationTask } from "./task.ts";
import type { UserInfoStore } from "./user-info.ts";
import type { SessionWorker, SessionWorkerContext, SessionWorkerRequest } from "../host/sessions.ts";

interface ApplicationAgentPort {
  readonly modelMetadata: ApplicationModelMetadata;
  run(options: ApplicationRunOptions): Promise<ApplicationRunResult>;
  steer(message: string): Promise<void>;
  close(): Promise<void>;
}

interface ApplicationRuntimePort {
  execute(command: string, args?: readonly string[]): Promise<PlaywrightCliExecutionResult>;
  openBrowser(): Promise<void>;
  getCurrentPageUrl(): Promise<string>;
  suppressPrivateCapture(): Promise<void>;
  activatePrivateValues(values: readonly string[]): Promise<void>;
  signIn(input: Record<string, string | undefined>): Promise<void>;
  close(): Promise<void>;
}

interface UserInfoPort extends UserInfoStorePort {
  suggestions(jobUrl: string, question: AdditionalInfoQuestion): Promise<readonly unknown[]>;
  readContents(): Promise<string>;
}

interface GmailInboxPort {
  searchInbox(input: {
    query?: string;
    date?: string;
    time?: string;
    receivedWithinMinutes?: number;
    receivedBeforeMinutesAgo?: number;
  }): Promise<{ messages: readonly { messageId: string; subject: string; sentAt: Date }[]; truncated: boolean }>;
  readEmail(emailId: string, offset?: number): Promise<{ content: string }>;
}

export interface ApplicationSessionWorkerOptions {
  context: SessionWorkerContext;
  runtime: ApplicationRuntimePort;
  agent: ApplicationAgentPort;
  userInfoStore: UserInfoPort;
  applicationTask: string;
  runtimeOrigin: string;
  defaultCredentials?: readonly [string, string];
  gmailInbox?: GmailInboxPort;
  privateValues?: Iterable<string>;
  cleanup?: () => void | Promise<void>;
}

function pendingAction(publication: GatePublication): PendingAction | null {
  if (publication.state === "awaiting_human_navigation") {
    if (publication.event === "credentials_required") return { type: "credentials" };
    return PendingActionSchema.parse({ type: "human_navigation", instruction: publication.detail.instruction });
  }
  if (publication.state === "awaiting_additional_info") {
    return PendingActionSchema.parse({ type: "additional_info", questions: publication.detail.questions });
  }
  if (publication.state === "awaiting_human_review") return { type: "human_review" };
  return null;
}

function terminalGateResponse(result: GateResult): RuntimeActionResponse | null {
  if (!result.done) return null;
  try {
    return RuntimeActionResponseSchema.parse({
      type: "cancel",
      result: CancelledApplicationResultSchema.parse(JSON.parse(result.extractedContent)),
    });
  } catch {
    throw new HarnessServiceError(502, "browser_failed", "The browser session failed");
  }
}

function browserResponse(result: PlaywrightCliExecutionResult, modelAction: boolean): RuntimeActionResponse {
  return RuntimeActionResponseSchema.parse({
    type: "playwright_cli_result",
    exit_code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdoutTruncated,
    stderr_truncated: result.stderrTruncated,
    cli_error_category: result.cliErrorCategory,
    observation: {
      url: result.observation.url,
      title: result.observation.title,
      tabs: modelAction ? result.observation.tabs.map((tab) => ({
        url: tab.url,
        title: tab.title,
        tab_id: tab.tabId,
        parent_tab_id: tab.parentTabId,
      })) : [],
      dom: result.observation.dom,
      page_info: modelAction && result.observation.pageInfo !== null
        ? { current_tab: result.observation.pageInfo.currentTab }
        : null,
      screenshot: result.observation.screenshot === null ? null : {
        media_type: result.observation.screenshot.mediaType,
        data: result.observation.screenshot.data,
      },
    },
  });
}

export class ApplicationSessionWorker implements SessionWorker {
  readonly #context: SessionWorkerContext;
  readonly #runtime: ApplicationRuntimePort;
  readonly #agent: ApplicationAgentPort;
  readonly #userInfoStore: UserInfoPort;
  readonly #applicationTask: string;
  readonly #runtimeOrigin: string;
  readonly #defaultCredentials: readonly [string, string] | undefined;
  readonly #gmailInbox: GmailInboxPort | undefined;
  readonly #cleanup: (() => void | Promise<void>) | undefined;
  readonly #gate: HumanGate;
  #activeRuntimeAction = false;
  #closed = false;
  #submissionStarted = false;
  #playwrightActionCount = 0;
  #additionalQuestionCount = 0;
  #playwrightDiagnostics: PlaywrightCliDiagnostic[] = [];

  constructor(options: ApplicationSessionWorkerOptions) {
    this.#context = options.context;
    this.#runtime = options.runtime;
    this.#agent = options.agent;
    this.#userInfoStore = options.userInfoStore;
    this.#applicationTask = options.applicationTask;
    this.#runtimeOrigin = options.runtimeOrigin;
    this.#defaultCredentials = options.defaultCredentials;
    this.#gmailInbox = options.gmailInbox;
    this.#cleanup = options.cleanup;
    this.#gate = new HumanGate({
      jobUrl: options.context.input.jobUrl,
      privateValues: [...(options.privateValues ?? []), ...(options.defaultCredentials ?? [])],
      userInfoStore: options.userInfoStore,
      autoSubmit: options.context.input.autoSubmit,
      ...(options.defaultCredentials === undefined ? {} : { defaultCredentials: options.defaultCredentials }),
      reviewSnapshot: async (result) => {
        const reviewed = ReviewApplicationResultSchema.parse(result);
        options.context.transition("running", null, {}, {
          job_url: reviewed.job_url,
          company: reviewed.company,
          role: reviewed.role,
          fields_filled: reviewed.fields_filled,
          fields_needing_human: reviewed.fields_needing_human,
          files_attached: reviewed.files_attached,
          warnings: reviewed.warnings,
          revision_count: reviewed.revision_count,
        });
      },
      publish: async (publication) => {
        options.context.transition(
          publication.state,
          publication.event,
          publication.detail,
          { pending_action: pendingAction(publication) },
        );
      },
    });
  }

  get modelMetadata() {
    const metadata = this.#agent.modelMetadata;
    return {
      model_provider: metadata.modelProvider,
      model: metadata.model,
      reasoning: metadata.reasoning,
    };
  }

  async run(recoveryGuidance?: readonly string[]): Promise<ApplicationRunResult> {
    if (this.#closed) throw new Error("session worker is closed");
    let task = this.#applicationTask;
    if (recoveryGuidance !== undefined) {
      await this.#gate.resetAfterAgentFailure();
      const payload = JSON.parse(task) as Record<string, unknown>;
      payload.recovery = {
        instruction: "The previous agent run stopped. The same browser is still open. Inspect the current page before taking any action. Do not replay the previous click or assume it failed. Obtain fresh final review before submitting. Never repeat a possible submission.",
        operator_guidance: [...recoveryGuidance],
      };
      task = JSON.stringify(payload);
    }
    return this.#agent.run({
      runtimeUrl: this.#runtimeOrigin,
      opportunityKind: this.#context.input.opportunityKind,
      autoSubmit: this.#context.input.autoSubmit,
      task,
      deadlineMs: null,
    });
  }

  async invoke(request: SessionWorkerRequest): Promise<unknown> {
    if (this.#closed) throw new HarnessServiceError(404, "session_not_found", "Session not found");
    if (request.type === "open_browser") {
      await this.#runtime.openBrowser();
      return undefined;
    }
    if (request.type === "suggestions") {
      const question = this.#gate.getPendingTextQuestion(request.questionId);
      if (question === null) throw new HarnessServiceError(404, "question_not_found", "Question not found");
      return { suggestions: await this.#userInfoStore.suggestions(this.#context.input.jobUrl, question) };
    }
    if (request.type === "command") {
      await this.#command(request.command);
      return undefined;
    }
    if (this.#activeRuntimeAction) {
      throw new HarnessServiceError(409, "command_conflict", "A runtime action is already pending");
    }
    const parsed = RuntimeActionRequestSchema.safeParse(request.action);
    if (!parsed.success) throw new HarnessServiceError(422, "invalid_request", "Request is invalid");
    this.#activeRuntimeAction = true;
    try {
      return await this.#runtimeAction(parsed.data, request.modelAction);
    } finally {
      this.#activeRuntimeAction = false;
    }
  }

  async #command(command: SessionCommand): Promise<void> {
    switch (command.type) {
      case "continue": await this.#gate.continueNavigation(); return;
      case "continue_without_additional_info": await this.#gate.continueWithoutAdditionalInfo(); return;
      case "provide_additional_info": await this.#gate.provideAdditionalInfo(command.answers); return;
      case "revise": await this.#gate.revise(command.context); return;
      case "submit": await this.#gate.submit(); return;
      case "sign_in": await this.#gate.signIn(command.username, command.password); return;
      case "save_credentials": await this.#gate.saveCredentials(command.username, command.password); return;
      case "cancel": await this.#gate.cancel(); return;
      case "steer":
        await this.#gate.interrupt();
        await this.#agent.steer(command.message);
        return;
    }
  }

  async #runtimeAction(action: RuntimeActionRequest, modelAction: boolean): Promise<RuntimeActionResponse> {
    if (action.type === "playwright_cli") {
      this.#playwrightActionCount += 1;
      if (this.#gate.submissionApproved && !this.#submissionStarted) {
        this.#submissionStarted = true;
        this.#context.markSubmissionStarted();
      }
      const step = this.#playwrightActionCount;
      let result: PlaywrightCliExecutionResult;
      try {
        result = await this.#runtime.execute(action.command, action.args);
        this.#appendPlaywrightDiagnostic({
          step, status: result.exitCode === 0 ? "succeeded" : "failed",
          exit_code: result.exitCode, error_category: result.exitCode === 0 ? null : "process_exit",
          stderr_excerpt: result.stderr ? "[redacted]" : null,
          stderr_truncated: result.stderrTruncated,
        });
      } catch (error) {
        if (error instanceof PlaywrightCliRuntimeError) {
          this.#appendPlaywrightDiagnostic({
            step, status: "failed", exit_code: -1, error_category: "browser_runtime",
            stderr_excerpt: "Browser runtime failed.", stderr_truncated: false,
          });
        }
        throw error;
      }
      let currentUrl: string;
      try { currentUrl = redactedUrl(result.observation.url, this.#gate.redactionValues); }
      catch { currentUrl = redactedUrl(this.#context.input.jobUrl, this.#gate.redactionValues); }
      this.#context.transition("running", "agent_step", { step_number: step, current_url: currentUrl }, {
        playwright_cli_diagnostics: this.#playwrightDiagnostics,
      });
      return browserResponse(result, modelAction);
    }
    if (action.type === "request_human_navigation") {
      const result = await this.#gate.requestHumanNavigation(action.instruction, this.#runtime);
      return terminalGateResponse(result) ?? (result.interrupted ? { type: "interrupted" } : { type: "continue" });
    }
    if (action.type === "get_credentials") {
      if (!modelAction) throw new HarnessServiceError(409, "command_conflict", "Default credential actions are model-only");
      if (this.#defaultCredentials === undefined) throw new HarnessServiceError(409, "command_conflict", "Default application credentials are unavailable");
      return { type: "credentials", username: this.#defaultCredentials[0], password: this.#defaultCredentials[1] };
    }
    if (action.type === "read_user_info") {
      if (!modelAction) throw new HarnessServiceError(409, "command_conflict", "User information actions are model-only");
      return RuntimeActionResponseSchema.parse({ type: "read_user_info_result", content: await this.#userInfoStore.readContents() });
    }
    if (action.type === "read_inbox" || action.type === "read_email") {
      if (!modelAction) throw new HarnessServiceError(409, "command_conflict", "Inbox actions are model-only");
      if (this.#gmailInbox === undefined) return { type: "gmail_unavailable", message: "Gmail is unavailable. Continue without reading email." };
      try {
        if (action.type === "read_email") {
          const email = await this.#gmailInbox.readEmail(action.email_id, action.offset);
          return RuntimeActionResponseSchema.parse({ type: "read_email_result", content: email.content });
        }
        const inbox = await this.#gmailInbox.searchInbox({
          query: action.query,
          ...(action.date === null ? {} : { date: action.date }),
          ...(action.time === null ? {} : { time: action.time }),
          ...(action.received_within_minutes === null ? {} : { receivedWithinMinutes: action.received_within_minutes }),
          ...(action.received_before_minutes_ago === null ? {} : { receivedBeforeMinutesAgo: action.received_before_minutes_ago }),
        });
        return RuntimeActionResponseSchema.parse({
          type: "read_inbox_result",
          messages: inbox.messages.map((message) => ({
            email_id: message.messageId,
            subject: message.subject,
            sent_at: message.sentAt.toISOString(),
          })),
          truncated: inbox.truncated,
        });
      } catch {
        return { type: "gmail_unavailable", message: "Gmail is unavailable. Continue without reading email." };
      }
    }
    if (action.type === "request_additional_info") {
      if (this.#playwrightActionCount < 1) throw new HarnessServiceError(409, "command_conflict", "Inspect the application before requesting additional information");
      if (this.#additionalQuestionCount + action.questions.length > 100) throw new HarnessServiceError(409, "command_conflict", "The additional-information question limit was reached");
      this.#additionalQuestionCount += action.questions.length;
      const result = await this.#gate.requestAdditionalInfo(action.questions, this.#runtime);
      const terminal = terminalGateResponse(result);
      if (terminal !== null) return terminal;
      if (result.interrupted) return { type: "interrupted" };
      try { return AdditionalInfoRuntimeActionResponseSchema.parse(JSON.parse(result.extractedContent)); }
      catch { throw new HarnessServiceError(502, "browser_failed", "The browser session failed"); }
    }
    if (action.type === "request_human_review") {
      if (action.result.job_url !== this.#context.input.jobUrl) return { type: "application_mismatch" };
      const result = await this.#gate.requestHumanReview(action.result, this.#runtime);
      const terminal = terminalGateResponse(result);
      if (terminal !== null) return terminal;
      if (result.interrupted) return { type: "interrupted" };
      if (this.#gate.submissionApproved) {
        try {
          return {
            type: "submit",
            instruction: "You're good to submit.",
            result: ReviewApplicationResultSchema.parse(JSON.parse(result.extractedContent)),
          };
        } catch {
          throw new HarnessServiceError(502, "browser_failed", "The browser session failed");
        }
      }
      return RuntimeActionResponseSchema.parse({ type: "revise", context: result.longTermMemory, revision_count: this.#gate.revisionCount });
    }
    return { type: "application_mismatch" };
  }

  #appendPlaywrightDiagnostic(diagnostic: PlaywrightCliDiagnostic): void {
    this.#playwrightDiagnostics.push(diagnostic);
    if (this.#playwrightDiagnostics.length > 100) this.#playwrightDiagnostics.splice(0, this.#playwrightDiagnostics.length - 100);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#gate.cancel();
    await Promise.allSettled([this.#runtime.close(), this.#agent.close()]);
    await this.#cleanup?.();
  }
}

export interface ApplicationSessionWorkerFactoryOptions { artifactsRoot: string; browser: PlaywrightCliBrowser; nodeExecutable: string; cliScript: string; pipelineUrl: string; bearerToken: string; runtimeOrigin: string; userInfoStore: UserInfoStore; applicationModelReader?: () => ApplicationModel | Promise<ApplicationModel>; gmailInbox?: GmailVerificationInbox; }

export function createApplicationSessionWorkerFactory(options: ApplicationSessionWorkerFactoryOptions) {
  return async (context: SessionWorkerContext): Promise<SessionWorker> => {
    const input = context.input;
    let sessionDirectory: string | undefined;
    let runtime: PlaywrightCliRuntime | undefined;
    let agent: LocalApplicationAgent | undefined;
    try {
      const stored = await storeUploads(
        options.artifactsRoot, context.sessionId, input.personalInformation, input.resume,
        input.resumeSource, input.context, input.anecdotes, input.transcript,
      );
      sessionDirectory = stored.sessionDirectory;
      const [candidate, userInfo] = await Promise.all([
        loadCandidateContext(stored),
        options.userInfoStore.snapshot(input.jobUrl),
      ]);
      const defaultCredentials = DEFAULT_APPLICATION_CREDENTIALS;
      const applicationTask = buildApplicationTask({
        session: {
          jobUrl: input.jobUrl,
          opportunityKind: input.opportunityKind,
          artifacts: {
            resume: stored.resume.path,
            ...(stored.transcript === undefined ? {} : { transcript: stored.transcript.path }),
          },
        },
        candidate,
        resumeDisplayName: stored.resume.displayName,
        resumeSourceDisplayName: stored.resumeSource.displayName,
        userInfo: { savedGlobal: userInfo.savedGlobal, savedApplication: userInfo.savedApplication },
        resumeUploadPath: stored.resume.path,
        ...(stored.transcript === undefined ? {} : {
          transcriptDisplayName: stored.transcript.displayName,
          transcriptUploadPath: stored.transcript.path,
        }),
      });
      if (Buffer.byteLength(applicationTask, "utf8") > 5_242_880) {
        throw new HarnessServiceError(422, "invalid_request", "Request is invalid");
      }
      runtime = new PlaywrightCliRuntime({
        sessionId: context.sessionId, browser: options.browser, sessionDirectory,
        nodeExecutable: options.nodeExecutable, cliScript: options.cliScript,
      });
      agent = new LocalApplicationAgent({ sessionId: context.sessionId, bearerToken: options.bearerToken, submissionGuard: new PipelineApplicationSubmissionGuard(context.sessionId, options.pipelineUrl, options.bearerToken), ...(options.applicationModelReader === undefined ? {} : { modelReader: options.applicationModelReader }) });
      await runtime.start(input.jobUrl);
      await agent.checkReady();
      return new ApplicationSessionWorker({
        context, runtime, agent, userInfoStore: options.userInfoStore, applicationTask,
        runtimeOrigin: options.runtimeOrigin,
        ...(defaultCredentials === undefined ? {} : { defaultCredentials }),
        ...(options.gmailInbox === undefined ? {} : { gmailInbox: options.gmailInbox }),
        privateValues: [
          ...Object.values(candidate.directFields),
          ...userInfo.rawTextValues,
          stored.resume.displayName,
          ...(stored.transcript === undefined ? [] : [stored.transcript.displayName]),
        ],
        cleanup: async () => { await cleanupSessionArtifacts(stored.sessionDirectory); },
      });
    } catch (error) {
      await Promise.allSettled([runtime?.close(), agent?.close()]);
      if (sessionDirectory !== undefined) await cleanupSessionArtifacts(sessionDirectory);
      throw error;
    }
  };
}
