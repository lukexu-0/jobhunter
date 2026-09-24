import type {
  ApplicationSessionCommand,
  ApplicationSessionSnapshotDto,
  ApplicationSessionView,
  RunDto,
} from "./pipeline-contracts";
import {
  PipelineClientError,
  closeApplicationSession,
  getApplicationSession,
  openApplicationBrowser,
  retryApplicationSession,
  sendApplicationCommand,
  startApplicationSession,
} from "./pipeline-client";

export type ApplicationSessionRun = Pick<
  RunDto,
  "id" | "revision" | "status" | "currentPdfSha256"
>;
export type ApplicationLifecycleAction = "cancel" | "close" | "resume" | "retry";
export type ApplicationGateCommandType = Exclude<ApplicationSessionCommand["type"], "steer">;
export type ApplicationPanelAction = ApplicationLifecycleAction | ApplicationGateCommandType;
export type ApplicationSteerCommand = Extract<
  ApplicationSessionCommand,
  { readonly type: "steer" }
>;
export type ApplicationSteeringState = "idle" | "sending" | "ambiguous";
/** Acceptance confirms HTTP delivery, not completion of the requested workflow. */
export type ApplicationDispatchResult =
  | { readonly status: "accepted"; readonly current: boolean }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "ambiguous" };
export type ApplicationSessionAction = ApplicationSessionCommand
  | { readonly type: "start"; readonly approvedPdfSha256: string }
  | { readonly type: "resume" }
  | { readonly type: "retry" }
  | { readonly type: "close" }
  | { readonly type: "open_browser" };
export interface ApplicationSessionState {
  readonly view: ApplicationSessionView | null;
  readonly loading: boolean;
  readonly actionBusy: ApplicationPanelAction | null;
  readonly browserOpenBusy: boolean;
  readonly steeringState: ApplicationSteeringState;
  readonly approvalAllowed: boolean;
  readonly error: string | null;
}
export const INITIAL_APPLICATION_SESSION: ApplicationSessionState = {
  view: null,
  loading: true,
  actionBusy: null,
  browserOpenBusy: false,
  steeringState: "idle",
  approvalAllowed: false,
  error: null,
};
export interface ApplicationSessionTransport {
  get(id: string, signal: AbortSignal): Promise<ApplicationSessionView>;
  start(id: string, hash: string, signal: AbortSignal): Promise<ApplicationSessionView>;
  retry(id: string, hash: string, signal: AbortSignal): Promise<ApplicationSessionView>;
  command(id: string, command: ApplicationSessionCommand, signal: AbortSignal): Promise<void>;
  close(id: string, signal: AbortSignal): Promise<void>;
  openBrowser(id: string, signal: AbortSignal): Promise<void>;
}
const productionTransport: ApplicationSessionTransport = {
  get: getApplicationSession,
  start: (id, hash, signal) => startApplicationSession(id, hash, {}, signal),
  retry: (id, hash, signal) => retryApplicationSession(id, hash, {}, signal),
  command: sendApplicationCommand,
  close: closeApplicationSession,
  openBrowser: openApplicationBrowser,
};
interface ApplicationSessionOptions {
  readonly signal: AbortSignal;
  readonly transport?: ApplicationSessionTransport;
  readonly schedule?: (callback: () => void, delay: number) => () => void;
  readonly onView?: (view: ApplicationSessionView | null) => void;
}
export interface ApplicationSession {
  getSnapshot(): ApplicationSessionState;
  subscribe(listener: () => void): () => void;
  updateRun(run: ApplicationSessionRun): void;
  dispatch(action: ApplicationSessionAction): Promise<ApplicationDispatchResult>;
}
const TERMINAL_STATES = new Set<ApplicationSessionSnapshotDto["bridgeState"]>([
  "cancelled",
  "failed",
  "closed",
  "lost",
]);
const STEERABLE_STATES = new Set<ApplicationSessionSnapshotDto["bridgeState"]>([
  "running",
  "awaiting_human_navigation",
  "awaiting_additional_info",
  "awaiting_human_review",
]);
export function canGuideApplicationAgent(snapshot: ApplicationSessionSnapshotDto): boolean {
  return STEERABLE_STATES.has(snapshot.bridgeState)
    && snapshot.submissionPhase === "not_attempted" && snapshot.terminalAt === null;
}
function snapshotFrom(view: ApplicationSessionView | null): ApplicationSessionSnapshotDto | null {
  return view && !("state" in view) ? view : null;
}
function acceptsView(current: ApplicationSessionView | null, next: ApplicationSessionView): boolean {
  const before = snapshotFrom(current);
  const after = snapshotFrom(next);
  if (!after) return before === null;
  if (!before) return true;
  if (after.generation !== before.generation) return after.generation > before.generation;
  if (TERMINAL_STATES.has(before.bridgeState) && !TERMINAL_STATES.has(after.bridgeState)) return false;
  return after.updatedAt > before.updatedAt;
}
function publicError(error: unknown, fallback: string): string {
  return error instanceof PipelineClientError ? error.message.trim().slice(0, 240) || fallback : fallback;
}
function definiteRejection(error: unknown): boolean {
  return error instanceof PipelineClientError && error.status !== undefined && error.status >= 400 && error.status < 500;
}
function cancellationSettled(snapshot: ApplicationSessionSnapshotDto): boolean {
  return TERMINAL_STATES.has(snapshot.bridgeState) || snapshot.submissionPhase === "submitted" || snapshot.submissionPhase === "uncertain";
}
function projectionMatcher(
  action: ApplicationSessionAction,
  baseline: ApplicationSessionSnapshotDto | null,
): (view: ApplicationSessionView) => boolean {
  // A fresh GET after a failed start can also confirm that nothing was reserved.
  if (action.type === "start" || action.type === "resume") return () => true;
  return (view) => {
    const next = snapshotFrom(view);
    if (!next || !baseline) return false;
    if (action.type === "submit") {
      return baseline.bridgeState === "awaiting_human_review" && baseline.pendingAction?.type === "human_review"
        && next.generation === baseline.generation && next.updatedAt > baseline.updatedAt && next.submissionPhase !== "not_attempted";
    }
    if (action.type === "continue_without_additional_info") {
      return baseline.pendingAction?.type === "additional_info" && next.generation >= baseline.generation
        && (
          next.pendingAction?.type !== "additional_info"
          || JSON.stringify(next.pendingAction.questions) !== JSON.stringify(baseline.pendingAction.questions)
        );
    }
    if (next.generation !== baseline.generation) {
      return next.generation > baseline.generation
        && ((action.type !== "sign_in" && action.type !== "save_credentials") || baseline.pendingAction?.type === "credentials");
    }
    switch (action.type) {
      case "retry": return false;
      case "cancel": return cancellationSettled(next);
      case "close": return next.bridgeState === "closed" || next.bridgeState === "lost";
      case "continue": return next.pendingAction?.type !== "human_navigation"
        || baseline.pendingAction?.type !== "human_navigation" || next.pendingAction.instruction !== baseline.pendingAction.instruction;
      case "sign_in":
      case "save_credentials":
        return baseline.pendingAction?.type === "credentials"
          && next.updatedAt > baseline.updatedAt
          && next.pendingAction?.type !== "credentials";
      case "provide_additional_info": return next.pendingAction?.type !== "additional_info"
        || baseline.pendingAction?.type !== "additional_info"
        || JSON.stringify(next.pendingAction.questions) !== JSON.stringify(baseline.pendingAction.questions);
      case "revise": return next.pendingAction?.type !== "human_review" || next.revisionCount > baseline.revisionCount;
      default: return false;
    }
  };
}
interface PendingAction {
  readonly action: ApplicationPanelAction;
  readonly accepts: (view: ApplicationSessionView) => boolean;
  requestPending: boolean;
  projectionAccepted: boolean;
}
function steeringIdentity(snapshot: ApplicationSessionSnapshotDto): string {
  return [
    snapshot.generation,
    snapshot.revisionCount,
    snapshot.bridgeState,
    JSON.stringify(snapshot.pendingAction),
  ].join(":");
}

/** Owns reconciliation and command coordination for exactly one run/revision lifetime. */
export function createApplicationSession(
  initialRun: ApplicationSessionRun,
  options: ApplicationSessionOptions,
): ApplicationSession {
  const transport = options.transport ?? productionTransport;
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  });
  const listeners = new Set<() => void>();
  let run = initialRun;
  let lifetime = new AbortController();
  let state = INITIAL_APPLICATION_SESSION;
  let view: ApplicationSessionView | null = null;
  let loading = true;
  let actionError: string | null = null;
  let loadError: string | null = null;
  let updateError: string | null = null;
  let pending: PendingAction | null = null;
  let steering: { identity: string; state: "sending" | "ambiguous" } | null = null;
  let browserPending = false;
  let actionEpoch = 0;
  let viewEpoch = 0;
  let readRequest: AbortController | null = null;
  let cancelTimer: (() => void) | null = null;
  const active = (scope = lifetime) => !options.signal.aborted && !scope.signal.aborted && lifetime === scope;
  function publish() {
    if (!active()) return;
    const availability = view && "state" in view ? view : null;
    const actionBusy = pending?.action ?? null;
    const steeringState = steering?.state ?? "idle";
    const approvalAllowed = !loading && !pending && (view === null || availability?.canStartAfterApproval === true);
    const error = actionError ?? loadError ?? updateError;
    if (state.view !== view || state.loading !== loading || state.actionBusy !== actionBusy
      || state.browserOpenBusy !== browserPending || state.steeringState !== steeringState
      || state.approvalAllowed !== approvalAllowed || state.error !== error) {
      state = { view, loading, actionBusy, browserOpenBusy: browserPending, steeringState, approvalAllowed, error };
      listeners.forEach((listener) => listener());
    }
    reconcilePolling();
  }
  function needsPolling() {
    const current = snapshotFrom(view);
    return pending !== null || (current !== null && current.bridgeState !== "reserved" && !TERMINAL_STATES.has(current.bridgeState));
  }
  function reconcilePolling() {
    if (!active() || !needsPolling()) { cancelTimer?.(); cancelTimer = null; return; }
    if (cancelTimer || readRequest) return;
    cancelTimer = schedule(() => { cancelTimer = null; void refresh(false); }, 1_000);
  }
  function releaseSettledAction() {
    if (pending && !pending.requestPending && pending.projectionAccepted) pending = null;
  }
  function install(next: ApplicationSessionView) {
    if (!acceptsView(view, next)) return;
    view = next;
    viewEpoch += 1;
    loadError = updateError = null;
    if (pending?.accepts(next)) pending.projectionAccepted = true;
    releaseSettledAction();
    const nextSnapshot = snapshotFrom(next);
    if (steering && (
      !nextSnapshot
      || !canGuideApplicationAgent(nextSnapshot)
      || steeringIdentity(nextSnapshot) !== steering.identity
    )) {
      steering = null;
    }
    options.onView?.(next);
    publish();
  }
  async function refresh(availability: boolean): Promise<void> {
    if (!active()) return;
    const scope = lifetime;
    readRequest?.abort();
    cancelTimer?.(); cancelTimer = null;
    const request = new AbortController();
    readRequest = request;
    const epoch = actionEpoch;
    if (availability) { loading = true; publish(); }
    try {
      const next = await transport.get(run.id, AbortSignal.any([scope.signal, options.signal, request.signal]));
      if (!active(scope) || readRequest !== request) return;
      if (!("state" in next) || epoch === actionEpoch) install(next);
      loadError = updateError = null;
    } catch (error) {
      if (!active(scope) || readRequest !== request) return;
      if (availability) loadError = publicError(error, "Application availability could not be loaded. The resume can still be approved.");
      else updateError = "Application updates could not be loaded. Retrying automatically.";
    } finally {
      if (active(scope) && readRequest === request) {
        readRequest = null;
        loading = false;
        publish();
      }
    }
  }
  function disposeScope() {
    lifetime.abort();
    readRequest?.abort(); readRequest = null;
    cancelTimer?.(); cancelTimer = null;
  }
  options.signal.addEventListener("abort", disposeScope, { once: true });
  const rejected = (
    message = "The application state changed; review the latest session state.",
  ): ApplicationDispatchResult => ({ status: "rejected", message });
  async function dispatch(action: ApplicationSessionAction): Promise<ApplicationDispatchResult> {
    if (!active()) return rejected();
    const scope = lifetime;
    const signal = AbortSignal.any([scope.signal, options.signal]);
    const id = run.id;
    if (action.type === "open_browser") {
      if (browserPending) return rejected();
      browserPending = true; actionError = null; publish();
      try {
        await transport.openBrowser(id, signal);
        return { status: "accepted", current: active(scope) };
      } catch (error) {
        const message = publicError(error, "The application browser could not be opened.");
        if (active(scope)) actionError = message;
        return rejected(message);
      } finally { if (active(scope)) { browserPending = false; publish(); } }
    }
    const baseline = snapshotFrom(view);
    if (action.type === "steer") {
      if (!baseline || !canGuideApplicationAgent(baseline) || pending || steering) return rejected();
      const latch = { identity: steeringIdentity(baseline), state: "sending" as "sending" | "ambiguous" };
      const epoch = actionEpoch;
      const projection = viewEpoch;
      steering = latch; publish();
      try {
        await transport.command(id, action, signal);
        const current = active(scope) && steering === latch && epoch === actionEpoch && projection === viewEpoch;
        if (active(scope) && steering === latch) { steering = null; publish(); }
        return { status: "accepted", current };
      } catch (error) {
        if (!active(scope) || steering !== latch) return { status: "ambiguous" };
        if (definiteRejection(error)) {
          steering = null; publish();
          return rejected(publicError(error, "The guidance could not be queued."));
        }
        latch.state = "ambiguous"; publish();
        return { status: "ambiguous" };
      }
    }
    const lifecycle = action.type === "cancel" || action.type === "close";
    if (pending && !(lifecycle && (
      pending.action !== "close"
      && pending.action !== "retry"
      && (action.type === "close" || pending.action !== "cancel")
    ))) return rejected();
    if (!lifecycle && steering?.state === "sending") return rejected();
    if (action.type !== "start" && !baseline) return rejected();
    const hash = action.type === "start" ? action.approvedPdfSha256 : run.currentPdfSha256;
    if ((action.type === "start" || action.type === "resume" || action.type === "retry") && !hash) {
      actionError = "The approved resume is no longer available."; publish();
      return rejected(actionError);
    }
    const latch: PendingAction = {
      action: action.type === "start" ? "resume" : action.type,
      requestPending: true,
      projectionAccepted: false,
      accepts: projectionMatcher(action, baseline),
    };
    pending = latch;
    actionEpoch += 1;
    actionError = null;
    publish();
    const owns = () => active(scope) && pending === latch;
    const settle = () => {
      if (owns()) {
        latch.requestPending = false;
        releaseSettledAction();
        publish();
      }
    };
    const fallback = action.type === "start" || action.type === "resume"
      ? "The resume is approved, but the application assistant could not start."
      : action.type === "retry" ? "The application assistant could not be retried."
      : action.type === "cancel" ? "The application assistant could not be cancelled."
      : action.type === "close" ? "The application session could not be ended."
      : "The application command could not be accepted.";
    try {
      if (action.type === "start" || action.type === "resume" || action.type === "retry") {
        const next = await (action.type === "retry" ? transport.retry(id, hash!, signal) : transport.start(id, hash!, signal));
        if (owns()) install(next);
      } else if (action.type === "close" || (action.type === "cancel" && baseline?.bridgeState === "reserved")) {
        await transport.close(id, signal);
        if (owns()) await refresh(false);
      } else {
        await transport.command(id, action, signal);
      }
      const current = active(scope) && pending === latch;
      settle();
      return { status: "accepted", current };
    } catch (error) {
      if (!owns()) return { status: "ambiguous" };
      const definite = definiteRejection(error);
      if (!definite) settle();
      const message = publicError(error, fallback);
      actionError = message; publish();
      await refresh(false);
      if (active(scope) && pending === latch && definite) { pending = null; publish(); }
      return definite ? rejected(message) : { status: "ambiguous" };
    }
  }
  options.onView?.(null);
  void refresh(true);
  return {
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispatch,
    updateRun(next) {
      if (!active()) return;
      const changedScope = next.id !== run.id || next.revision !== run.revision;
      const changedAvailability = changedScope || next.status !== run.status || next.currentPdfSha256 !== run.currentPdfSha256;
      run = next;
      if (!changedAvailability) return;
      if (changedScope) {
        disposeScope(); lifetime = new AbortController();
        view = null; pending = null; steering = null; browserPending = false;
        actionError = loadError = updateError = null; actionEpoch = viewEpoch = 0;
        options.onView?.(null);
      }
      void refresh(true);
    },
  };
}
