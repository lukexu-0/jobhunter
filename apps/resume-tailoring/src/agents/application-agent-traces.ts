import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
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
import type { OpportunityKind } from "../contracts/index.ts";

export const MAX_APPLICATION_AGENT_TRACE_BYTES = 64 * 1024 * 1024;
export const MAX_APPLICATION_AGENT_TRACE_RECORD_BYTES = 16 * 1024 * 1024;
export const MAX_RETAINED_APPLICATION_AGENT_TRACES = 30;
const TRACE_FINISH_RESERVE_BYTES = 64 * 1024;
const UUID_COMPONENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACE_FILENAME =
  /^[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

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
): SerializedPrivateError {
  if (!(value instanceof Error)) {
    return { name: "NonError", message: String(value) };
  }
  if (seen.has(value)) {
    return { name: value.name || "Error", message: "[circular error cause]" };
  }
  seen.add(value);
  let code: string | number | undefined;
  try {
    const candidate = "code" in value ? value.code : undefined;
    if (typeof candidate === "string" || typeof candidate === "number") code = candidate;
  } catch {
    code = undefined;
  }
  let cause: unknown;
  try {
    cause = value.cause;
  } catch {
    cause = undefined;
  }
  return {
    name: value.name || "Error",
    message: value.message,
    ...(value.stack === undefined ? {} : { stack: value.stack }),
    ...(code === undefined ? {} : { code }),
    ...(cause === undefined ? {} : { cause: serializePrivateError(cause, seen) }),
  };
}

class FileApplicationAgentTrace implements ApplicationAgentTrace {
  readonly path: string;
  readonly #sessionId: string;
  readonly #handle: FileHandle;
  readonly #now: () => number;
  readonly #onFinish: () => Promise<void>;
  #sequence = 0;
  #bytes = 0;
  #truncated = false;
  #finished = false;

  constructor(
    path: string,
    sessionId: string,
    handle: FileHandle,
    now: () => number,
    onFinish: () => Promise<void>,
  ) {
    this.path = path;
    this.#sessionId = sessionId;
    this.#handle = handle;
    this.#now = now;
    this.#onFinish = onFinish;
  }

  async start(input: ApplicationAgentTraceStart): Promise<void> {
    await this.#append({ type: "trace_started", ...input }, MAX_APPLICATION_AGENT_TRACE_BYTES);
  }

  async record(event: ApplicationAgentModelTraceEvent): Promise<void> {
    if (this.#finished || this.#truncated) return;
    const record = this.#record(event);
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (
      bytes > MAX_APPLICATION_AGENT_TRACE_RECORD_BYTES
      || this.#bytes + bytes > MAX_APPLICATION_AGENT_TRACE_BYTES - TRACE_FINISH_RESERVE_BYTES
    ) {
      this.#truncated = true;
      await this.#append({
        type: "trace_truncated",
        attemptedRecordType: event.type,
        attemptedBytes: bytes,
      }, MAX_APPLICATION_AGENT_TRACE_BYTES - TRACE_FINISH_RESERVE_BYTES);
      return;
    }
    await this.#handle.write(line);
    this.#bytes += bytes;
  }

  async finish(outcome: ApplicationAgentTraceOutcome): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    try {
      await this.#append({
        type: "trace_finished",
        status: outcome.status,
        ...(outcome.status === "failed"
          ? { error: serializePrivateError(outcome.error) }
          : {}),
      }, MAX_APPLICATION_AGENT_TRACE_BYTES);
      await this.#handle.sync();
    } finally {
      await this.#handle.close();
      await fsyncDirectory(resolve(this.path, ".."));
      await this.#onFinish();
    }
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
    await this.#handle.write(line);
    this.#bytes += bytes;
  }
}

export class ApplicationAgentTraceStore {
  readonly root: string;
  readonly #now: () => number;
  readonly #traceIdFactory: () => string;
  readonly #activePaths = new Set<string>();

  constructor(root: string, options: ApplicationAgentTraceStoreOptions = {}) {
    this.root = resolve(root);
    this.#now = options.now ?? Date.now;
    this.#traceIdFactory = options.traceIdFactory ?? randomUUID;
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

  async #prune(): Promise<void> {
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
      if (this.#activePaths.has(path)) continue;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      await rm(path);
      excess -= 1;
      removed = true;
    }
    if (removed) await fsyncDirectory(this.root);
  }

  async start(input: ApplicationAgentTraceStart): Promise<ApplicationAgentTrace> {
    const sessionId = requireUuid(input.sessionId, "application session id");
    const traceId = requireUuid(this.#traceIdFactory(), "application trace id");
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid application trace timestamp");
    await this.initialize();
    const path = resolve(this.root, `${now}-${sessionId}-${traceId}.jsonl`);
    if (!contained(this.root, path)) throw new Error("application trace path escapes its root");
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    this.#activePaths.add(path);
    const trace = new FileApplicationAgentTrace(
      path,
      sessionId,
      handle,
      this.#now,
      async () => {
        this.#activePaths.delete(path);
        await this.#prune();
      },
    );
    try {
      await trace.start({ ...input, sessionId });
      await this.#prune();
      return trace;
    } catch (error) {
      this.#activePaths.delete(path);
      await handle.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
