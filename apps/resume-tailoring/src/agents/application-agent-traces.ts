import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ModelTraceError,
  ModelTraceEvent,
  ModelTraceSink,
} from "./runner.ts";
import {
  isProcessIdentityAlive,
  readProcessStartToken,
} from "../worker/claims.ts";
import type { OpportunityKind } from "../contracts/index.ts";

export const MAX_APPLICATION_AGENT_TRACE_BYTES = 64 * 1024 * 1024;
export const MAX_APPLICATION_AGENT_TRACE_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_RETAINED_APPLICATION_AGENT_TRACES = 30;
const TRACE_FINISH_RESERVE_BYTES = 64 * 1024;
const TRACE_TRUNCATION_RESERVE_BYTES = 1_024;
const UUID_COMPONENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACE_FILENAME =
  /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.incomplete)?\.jsonl$/;
const ACTIVE_TRACE_FILENAME =
  /^([0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([1-9][0-9]*)\.([0-9]+)\.active$/;
const MAX_TERMINAL_ERROR_DEPTH = 2;
const MAX_TERMINAL_ERROR_TEXT_CHARS = 512;

function boundedTerminalErrorText(value: string): string {
  return value.length <= MAX_TERMINAL_ERROR_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_TERMINAL_ERROR_TEXT_CHARS)}[truncated]`;
}


export type ApplicationAgentModelTraceEvent = ModelTraceEvent;

export interface ApplicationAgentTraceStart {
  readonly sessionId: string;
  readonly opportunityKind: OpportunityKind;
  readonly autoSubmit: boolean;
}

export type ApplicationAgentTraceOutcome =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: unknown };

export type SerializedPrivateError = ModelTraceError;

type ApplicationAgentTracePayload =
  | ({ readonly type: "trace_started" } & ApplicationAgentTraceStart)
  | ApplicationAgentModelTraceEvent
  | {
      readonly type: "trace_truncated";
      readonly attemptedRecordType: ApplicationAgentModelTraceEvent["type"];
      readonly attemptedBytes: number;
    }
  | {
      readonly type: "trace_finished";
      readonly status: ApplicationAgentTraceOutcome["status"];
      readonly error?: SerializedPrivateError;
    };

export type ApplicationAgentTraceRecord = ApplicationAgentTracePayload & {
  readonly version: 1;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly sessionId: string;
};

export interface ApplicationAgentTrace extends ModelTraceSink {
  readonly path: string;
  record(event: ApplicationAgentModelTraceEvent): Promise<void>;
  finish(outcome: ApplicationAgentTraceOutcome): Promise<void>;
}

export interface ApplicationAgentTraceStoreOptions {
  readonly now?: () => number;
  readonly traceIdFactory?: () => string;
}

function requireUuid(value: string, label: string): string {
  if (!UUID_COMPONENT.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function serializePrivateError(
  value: unknown,
  seen = new Set<unknown>(),
  depth = 0,
): SerializedPrivateError {
  try {
    if (depth >= MAX_TERMINAL_ERROR_DEPTH) {
      return { name: "ErrorCauseLimit", message: "Additional error causes omitted" };
    }
    if (!(value instanceof Error)) {
      return {
        name: "NonError",
        message: boundedTerminalErrorText(String(value)),
      };
    }
    const name = boundedTerminalErrorText(value.name || "Error");
    if (seen.has(value)) {
      return { name, message: "[circular error cause]" };
    }
    seen.add(value);
    let code: string | number | undefined;
    try {
      const candidate = "code" in value ? value.code : undefined;
      if (typeof candidate === "string") {
        code = boundedTerminalErrorText(candidate);
      } else if (typeof candidate === "number") {
        code = candidate;
      }
    } catch {
      code = undefined;
    }
    let cause: unknown;
    try {
      cause = value.cause;
    } catch {
      cause = undefined;
    }
    const stack = value.stack;
    return {
      name,
      message: boundedTerminalErrorText(value.message),
      ...(stack === undefined
        ? {}
        : { stack: boundedTerminalErrorText(stack) }),
      ...(code === undefined ? {} : { code }),
      ...(cause === undefined
        ? {}
        : { cause: serializePrivateError(cause, seen, depth + 1) }),
    };
  } catch {
    return {
      name: "UninspectableError",
      message: "Terminal error details could not be inspected",
    };
  }
}

class FileApplicationAgentTrace implements ApplicationAgentTrace {
  readonly path: string;
  readonly #sessionId: string;
  readonly #activePath: string;
  readonly #handle: FileHandle;
  readonly #now: () => number;
  readonly #onFinish: () => Promise<void>;
  #sequence = 0;
  #bytes = 0;
  #truncated = false;
  #finished = false;
  #recordingFailed = false;
  #recordingError: unknown;

  constructor(
    path: string,
    activePath: string,
    sessionId: string,
    handle: FileHandle,
    now: () => number,
    onFinish: () => Promise<void>,
  ) {
    this.path = path;
    this.#activePath = activePath;
    this.#sessionId = sessionId;
    this.#handle = handle;
    this.#now = now;
    this.#onFinish = onFinish;
  }

  async start(input: ApplicationAgentTraceStart): Promise<void> {
    await this.#append({ type: "trace_started", ...input }, MAX_APPLICATION_AGENT_TRACE_BYTES);
  }

  async record(event: ApplicationAgentModelTraceEvent): Promise<void> {
    if (this.#finished || this.#truncated || this.#recordingFailed) return;
    try {
      const record = this.#record(event);
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      if (
        bytes > MAX_APPLICATION_AGENT_TRACE_RECORD_BYTES
        || this.#bytes + bytes
          > MAX_APPLICATION_AGENT_TRACE_BYTES
            - TRACE_FINISH_RESERVE_BYTES
            - TRACE_TRUNCATION_RESERVE_BYTES
      ) {
        this.#truncated = true;
        await this.#append({
          type: "trace_truncated",
          attemptedRecordType: event.type,
          attemptedBytes: bytes,
        }, MAX_APPLICATION_AGENT_TRACE_BYTES - TRACE_FINISH_RESERVE_BYTES);
        return;
      }
      await this.#handle.writeFile(line);
      this.#bytes += bytes;
    } catch (error) {
      this.#recordingFailed = true;
      this.#recordingError = error;
      throw error;
    }
  }

  async finish(outcome: ApplicationAgentTraceOutcome): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    let finishFailed = this.#recordingFailed;
    let finishError: unknown = this.#recordingError;
    if (!finishFailed) {
      try {
        await this.#append({
          type: "trace_finished",
          status: outcome.status,
          ...(outcome.status === "failed"
            ? { error: serializePrivateError(outcome.error) }
            : {}),
        }, MAX_APPLICATION_AGENT_TRACE_BYTES);
        await this.#handle.sync();
      } catch (error) {
        finishFailed = true;
        finishError = error;
      }
    }
    try {
      await this.#handle.close();
    } catch (error) {
      if (!finishFailed) {
        finishFailed = true;
        finishError = error;
      }
    }

    if (finishFailed) {
      const incompletePath =
        `${this.path.slice(0, -".jsonl".length)}.incomplete.jsonl`;
      try {
        await this.#publish(incompletePath);
      } catch (publicationError) {
        throw new AggregateError(
          [finishError, publicationError],
          "Application model trace finalization and recovery failed",
        );
      }
      throw finishError;
    }
    await this.#publish(this.path);
  }

  async #publish(path: string): Promise<void> {
    await link(this.#activePath, path);
    await fsyncDirectory(resolve(path, ".."));
    await rm(this.#activePath);
    await fsyncDirectory(resolve(path, ".."));
    await this.#onFinish();
  }

  #record(payload: ApplicationAgentTracePayload): ApplicationAgentTraceRecord {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid application trace timestamp");
    return {
      version: 1,
      sequence: ++this.#sequence,
      recordedAt: new Date(now).toISOString(),
      sessionId: this.#sessionId,
      ...payload,
    };
  }

  async #append(payload: ApplicationAgentTracePayload, maximumBytes: number): Promise<void> {
    const line = `${JSON.stringify(this.#record(payload))}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.#bytes + bytes > maximumBytes) {
      throw new Error(`application agent trace exceeds ${maximumBytes} bytes`);
    }
    await this.#handle.writeFile(line);
    this.#bytes += bytes;
  }
}

export class ApplicationAgentTraceStore {
  readonly root: string;
  readonly #now: () => number;
  readonly #traceIdFactory: () => string;
  readonly #processStartToken: string;
  #pruneQueue: Promise<void> = Promise.resolve();

  constructor(root: string, options: ApplicationAgentTraceStoreOptions = {}) {
    this.root = resolve(root);
    this.#now = options.now ?? Date.now;
    this.#traceIdFactory = options.traceIdFactory ?? randomUUID;
    this.#processStartToken = readProcessStartToken() ?? "0";
  }

  async initialize(): Promise<void> {
    try {
      const stat = await lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("application trace root must be a real directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const stat = await lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("application trace root must be a real directory");
      }
    }
    await chmod(this.root, 0o700);
  }

  #prune(): Promise<void> {
    const operation = this.#pruneQueue.then(() => this.#pruneExclusive());
    this.#pruneQueue = operation.catch(() => undefined);
    return operation;
  }

  async #recoverInactiveTraces(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true });
    let changed = false;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const match = ACTIVE_TRACE_FILENAME.exec(entry.name);
      if (match === null) continue;
      const fileStem = match[1]!;
      const ownerPid = Number(match[2]);
      const ownerStartToken = match[3]!;
      if (isProcessIdentityAlive(
        ownerPid,
        ownerStartToken === "0" ? "" : ownerStartToken,
      )) continue;

      const activePath = resolve(this.root, entry.name);
      const completedPath = resolve(this.root, `${fileStem}.jsonl`);
      try {
        const completed = await lstat(completedPath);
        if (
          completed.isFile()
          && !completed.isSymbolicLink()
          && completed.size > 0
        ) {
          await rm(activePath, { force: true });
          changed = true;
          continue;
        }
        if (completed.isFile() && !completed.isSymbolicLink()) {
          await rm(completedPath, { force: true });
          changed = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const incompletePath = resolve(
        this.root,
        `${fileStem}.incomplete.jsonl`,
      );
      try {
        await link(activePath, incompletePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code !== "EEXIST") throw error;
        const incomplete = await lstat(incompletePath);
        if (!incomplete.isFile() || incomplete.isSymbolicLink()) {
          throw new Error("recovered application trace must be a regular file");
        }
      }
      await chmod(incompletePath, 0o600);
      await rm(activePath, { force: true });
      changed = true;
    }
    if (changed) await fsyncDirectory(this.root);
  }

  async #pruneExclusive(): Promise<void> {
    await this.#recoverInactiveTraces();
    const entries = await readdir(this.root, { withFileTypes: true });
    const paths = entries
      .filter((entry) =>
        entry.isFile()
        && !entry.isSymbolicLink()
        && TRACE_FILENAME.test(entry.name)
      )
      .map((entry) => resolve(this.root, entry.name))
      .sort((left, right) => {
        const leftName = left.slice(left.lastIndexOf(sep) + 1);
        const rightName = right.slice(right.lastIndexOf(sep) + 1);
        const leftTimestamp = Number(leftName.slice(0, leftName.indexOf("-")));
        const rightTimestamp = Number(rightName.slice(0, rightName.indexOf("-")));
        return leftTimestamp - rightTimestamp || leftName.localeCompare(rightName);
      });
    let excess = paths.length - MAX_RETAINED_APPLICATION_AGENT_TRACES;
    let removed = false;
    for (const path of paths) {
      if (excess <= 0) break;
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          excess -= 1;
          continue;
        }
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await rm(path, { force: true });
      excess -= 1;
      removed = true;
    }
    if (removed) await fsyncDirectory(this.root);
  }

  async start(input: ApplicationAgentTraceStart): Promise<ApplicationAgentTrace> {
    const sessionId = requireUuid(
      input.sessionId.toLowerCase(),
      "application session id",
    );
    const traceId = requireUuid(
      this.#traceIdFactory().toLowerCase(),
      "application trace id",
    );
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid application trace timestamp");
    await this.initialize();
    const fileStem = `${now}-${sessionId}-${traceId}`;
    const path = resolve(this.root, `${fileStem}.jsonl`);
    const activePath = resolve(
      this.root,
      `${fileStem}.${process.pid}.${this.#processStartToken}.active`,
    );
    if (!contained(this.root, path) || !contained(this.root, activePath)) {
      throw new Error("application trace path escapes its root");
    }
    const handle = await open(
      activePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const trace = new FileApplicationAgentTrace(
      path,
      activePath,
      sessionId,
      handle,
      this.#now,
      async () => {
        await this.#prune();
      },
    );
    try {
      await trace.start({ ...input, sessionId });
      await this.#prune();
      return trace;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(activePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
