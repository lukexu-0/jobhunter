import type { ApplicationSessionView, ArtifactDto, RunDto } from "./pipeline-contracts";
import { getApplicationSession, listRuns, PipelineClientError, readJsonArtifact } from "./pipeline-client";
import { isApplicationSessionOpen } from "./application-session-state";

const POLL_INTERVAL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_APPLICATION_READS = 3;

export interface JobIdentity {
  readonly title: string;
  readonly organization?: string;
}

export interface RunCollectionSnapshot {
  readonly runs: readonly RunDto[] | undefined;
  readonly applicationAttention: ReadonlySet<string>;
  readonly jobIdentities: Readonly<Record<string, JobIdentity>>;
  readonly isLoadingRuns: boolean;
  readonly runsError: string | null;
}

interface Clock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
}

interface RunCollectionOptions {
  readonly listRuns?: typeof listRuns;
  readonly getApplicationSession?: typeof getApplicationSession;
  readonly readJsonArtifact?: typeof readJsonArtifact;
  readonly observeRun?: (run: RunDto) => void;
  readonly observeApplication?: (runId: string, view: ApplicationSessionView) => void;
  readonly clock?: Clock;
}

interface IdentityRead {
  readonly artifactId: string;
  readonly controller: AbortController;
  settled: boolean;
}

function latestJobAnalysis(run: RunDto): ArtifactDto | undefined {
  let latest: ArtifactDto | undefined;
  for (const artifact of run.artifacts) {
    if (artifact.kind === "job-analysis" && artifact.public
      && (!latest || artifact.createdAt > latest.createdAt)) latest = artifact;
  }
  return latest;
}

function parseJobIdentity(value: unknown): JobIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const analysis = value as Record<string, unknown>;
  if (analysis.schemaVersion !== 2) return null;
  const target = analysis.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const targetRecord = target as Record<string, unknown>;
  const title = typeof targetRecord.title === "string" ? targetRecord.title.trim() : "";
  if (!title) return null;
  const organization = typeof targetRecord.organization === "string" ? targetRecord.organization.trim() : "";
  return organization ? { title, organization } : { title };
}

/** Owns accepted dashboard snapshots; React only subscribes and declares its lifetime. */
export class RunCollection {
  readonly #listRuns: typeof listRuns;
  readonly #getApplicationSession: typeof getApplicationSession;
  readonly #readJsonArtifact: typeof readJsonArtifact;
  readonly #observeRun: (run: RunDto) => void;
  readonly #observeApplication: (runId: string, view: ApplicationSessionView) => void;
  readonly #clock: Clock;
  readonly #listeners = new Set<() => void>();
  readonly #watchedApplications = new Set<string>();
  readonly #identityReads = new Map<string, IdentityRead>();
  readonly #pendingCreations = new Set<Set<string>>();
  #identityWatchers = 0;
  #version = 0;
  #polling = false;
  #stopped = false;
  #timer: unknown;
  #activeRequest: AbortController | undefined;
  #snapshot: RunCollectionSnapshot = {
    runs: undefined, applicationAttention: new Set(), jobIdentities: {}, isLoadingRuns: true, runsError: null,
  };

  constructor(options: RunCollectionOptions = {}) {
    this.#listRuns = options.listRuns ?? listRuns;
    this.#getApplicationSession = options.getApplicationSession ?? getApplicationSession;
    this.#readJsonArtifact = options.readJsonArtifact ?? readJsonArtifact;
    this.#observeRun = options.observeRun ?? (() => {});
    this.#observeApplication = options.observeApplication ?? (() => {});
    this.#clock = options.clock ?? {
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
  }

  getSnapshot = (): RunCollectionSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  #publish(update: Partial<RunCollectionSnapshot>): void {
    for (const key in update) {
      const field = key as keyof RunCollectionSnapshot;
      if (this.#snapshot[field] === update[field]) continue;
      this.#snapshot = { ...this.#snapshot, ...update };
      for (const listener of this.#listeners) listener();
      return;
    }
  }

  #invalidate(): void {
    this.#version += 1;
    this.#activeRequest?.abort();
    this.#activeRequest = undefined;
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    if (!this.#polling) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  // Settle even an uncooperative transport so a timed-out read cannot starve polling.
  async #request<T>(parent: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    const timer = this.#clock.setTimeout(() => {
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, REQUEST_TIMEOUT_MS);
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      return await Promise.race([read(signal), aborted]);
    } finally {
      this.#clock.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  #replaceRuns(runs: readonly RunDto[], runsError = this.#snapshot.runsError): Set<string> {
    const ids = new Set(runs.map((run) => run.id));
    for (const previous of this.#snapshot.runs ?? []) {
      if (ids.has(previous.id)) continue;
      for (const removedIds of this.#pendingCreations) removedIds.add(previous.id);
    }
    let identities: Record<string, JobIdentity> | undefined;
    for (const id of Object.keys(this.#snapshot.jobIdentities)) {
      if (ids.has(id)) continue;
      identities ??= { ...this.#snapshot.jobIdentities };
      delete identities[id];
    }
    for (const [id, read] of this.#identityReads) {
      if (ids.has(id)) continue;
      read.controller.abort();
      this.#identityReads.delete(id);
    }
    for (const id of this.#watchedApplications) {
      if (!ids.has(id)) this.#watchedApplications.delete(id);
    }
    const openIds = new Set<string>();
    for (const run of runs) {
      if (!isApplicationSessionOpen(run)) continue;
      openIds.add(run.id);
      this.#watchedApplications.add(run.id);
    }
    let attention: Set<string> | undefined;
    for (const id of this.#snapshot.applicationAttention) {
      if (openIds.has(id)) continue;
      attention ??= new Set(this.#snapshot.applicationAttention);
      attention.delete(id);
    }
    this.#publish({
      runs, runsError, isLoadingRuns: false,
      jobIdentities: identities ?? this.#snapshot.jobIdentities,
      applicationAttention: attention ?? this.#snapshot.applicationAttention,
    });
    for (const run of runs) {
      this.#observeRun(run);
      if (this.#identityWatchers > 0) this.#loadIdentity(run);
    }
    return openIds;
  }

  #loadIdentity(run: RunDto): void {
    const artifact = latestJobAnalysis(run);
    const previous = this.#identityReads.get(run.id);
    if (artifact?.id === previous?.artifactId) return;
    previous?.controller.abort();
    this.#identityReads.delete(run.id);
    if (!artifact) return;
    const read: IdentityRead = { artifactId: artifact.id, controller: new AbortController(), settled: false };
    this.#identityReads.set(run.id, read);
    const current = () => this.#identityReads.get(run.id) === read && !read.controller.signal.aborted;
    void this.#request(read.controller.signal, (signal) => this.#readJsonArtifact(artifact, signal)).then((value) => {
      if (!current()) return;
      read.settled = true;
      const identity = parseJobIdentity(value);
      if (identity) this.#publish({ jobIdentities: { ...this.#snapshot.jobIdentities, [run.id]: identity } });
    }).catch(() => {
      // Optional metadata retries on the next accepted snapshot, not in a tight loop.
      if (current()) this.#identityReads.delete(run.id);
    });
  }

  watchJobIdentities = (): (() => void) => {
    this.#identityWatchers += 1;
    if (!this.#stopped && this.#identityWatchers === 1) {
      for (const run of this.#snapshot.runs ?? []) this.#loadIdentity(run);
    }
    return () => {
      this.#identityWatchers -= 1;
      if (this.#identityWatchers > 0) return;
      for (const [id, read] of this.#identityReads) {
        if (read.settled) continue;
        read.controller.abort();
        this.#identityReads.delete(id);
      }
    };
  };

  refresh = async (showLoading = false): Promise<void> => {
    if (this.#stopped) return;
    this.#invalidate();
    const version = this.#version;
    const controller = new AbortController();
    this.#activeRequest = controller;
    const current = () => version === this.#version && !controller.signal.aborted;
    if (showLoading) this.#publish({ isLoadingRuns: true });
    try {
      const runs = await this.#request(controller.signal, (signal) => this.#listRuns(signal));
      if (!current()) return;
      const openIds = this.#replaceRuns(runs, null);
      // Read one final snapshot after a session releases its slot. A failed read stays watched.
      const ids = [...this.#watchedApplications];
      let index = 0;
      const observeNext = async () => {
        while (current() && index < ids.length) {
          const id = ids[index++]!;
          try {
            const view = await this.#request(controller.signal, (signal) => this.#getApplicationSession(id, signal));
            if (!current()) return;
            this.#observeApplication(id, view);
            const needsAttention = openIds.has(id) && !("state" in view) && view.pendingAction !== null;
            if (this.#snapshot.applicationAttention.has(id) !== needsAttention) {
              const attention = new Set(this.#snapshot.applicationAttention);
              if (needsAttention) attention.add(id);
              else attention.delete(id);
              this.#publish({ applicationAttention: attention });
            }
            if (!openIds.has(id)) this.#watchedApplications.delete(id);
          } catch {
            // An unavailable session must not hide other sessions or durable application status.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(ids.length, MAX_CONCURRENT_APPLICATION_READS) }, observeNext));
    } catch (error) {
      if (!current()) return;
      this.#publish({ runsError: error instanceof PipelineClientError
        ? error.message : "Applications are unavailable. Try again." });
    } finally {
      if (current()) {
        this.#publish({ isLoadingRuns: false });
        this.#activeRequest = undefined;
        this.#schedule();
      }
    }
  };

  acceptRun = (accepted: RunDto): void => {
    if (this.#stopped) return;
    const runs = this.#snapshot.runs;
    const previous = runs?.find((run) => run.id === accepted.id);
    // A late command result must not resurrect removals or roll back later pipeline progress.
    if (!runs || !previous || previous.updatedAt > accepted.updatedAt) return;
    this.#invalidate();
    this.#replaceRuns(runs.map((run) => run.id === accepted.id ? accepted : run));
    this.#schedule();
  };

  collectCreatedRuns = async (work: () => Promise<readonly RunDto[]>): Promise<readonly RunDto[]> => {
    // Track removals only while a batch can still produce a delayed creation result.
    const removedIds = new Set<string>();
    this.#pendingCreations.add(removedIds);
    try {
      const created = await work();
      if (!this.#pendingCreations.has(removedIds) || this.#stopped) return created;
      if (!created.some((run) => !removedIds.has(run.id))) return created;
      this.#invalidate();
      const current = new Map(this.#snapshot.runs?.map((run) => [run.id, run]));
      const seen = new Set<string>();
      const runs: RunDto[] = [];
      for (const run of created) {
        if (seen.has(run.id) || removedIds.has(run.id)) continue;
        seen.add(run.id);
        // A list can see a new run progressing before the creation batch settles.
        runs.push(current.get(run.id) ?? run);
      }
      for (const run of current.values()) if (!seen.has(run.id)) runs.push(run);
      this.#replaceRuns(runs);
      this.#schedule();
      return created;
    } finally {
      this.#pendingCreations.delete(removedIds);
    }
  };

  acceptRemoval = (runId: string): void => {
    if (this.#stopped) return;
    for (const removedIds of this.#pendingCreations) removedIds.add(runId);
    this.#invalidate();
    this.#replaceRuns(this.#snapshot.runs?.filter((run) => run.id !== runId) ?? []);
    this.#schedule();
  };

  acceptApplicationStarted = (runId: string): void => {
    const run = this.#snapshot.runs?.find((run) => run.id === runId);
    // Starting/retrying a session does not change its durable submission outcome.
    if (run) this.acceptRun({ ...run, isApplying: true, isApplicationSessionOpen: true });
  };

  start = (): void => {
    if (this.#polling) return;
    this.#stopped = false;
    this.#polling = true;
    void this.refresh();
  };

  stop = (): void => {
    this.#stopped = true;
    this.#polling = false;
    this.#invalidate();
    this.#pendingCreations.clear();
    for (const [id, read] of this.#identityReads) {
      if (read.settled) continue;
      read.controller.abort();
      this.#identityReads.delete(id);
    }
  };
}
