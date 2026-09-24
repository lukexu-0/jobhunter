import { readFile } from "node:fs/promises";

import { HarnessServiceError, type StoredCandidateArtifacts, type StoredUpload } from "../host/artifacts.ts";

export const MAX_SOURCE_CHARACTERS = 500_000;
export const MAX_RESUME_SOURCE_CHARACTERS = 1_310_720;
const BASE_COMBINED_NARRATIVE_CHARACTERS = 1_250_000;
export const MAX_COMBINED_NARRATIVE_CHARACTERS = 2_060_720;

export type SourceCategory = "profile" | "context" | "anecdote";
export type EvidenceCategory = "resume" | SourceCategory;

export interface AttributedSource {
  readonly name: string;
  readonly category: SourceCategory;
  readonly text: string;
}
export interface CandidateContext {
  readonly directFields: Readonly<Record<string, string>>;
  readonly resumeText: string;
  readonly profileNarrative: AttributedSource;
  readonly contextSources: readonly AttributedSource[];
  readonly anecdotes: readonly AttributedSource[];
}
export interface AttributedEvidence {
  readonly category: EvidenceCategory;
  readonly name: string;
  readonly text: string;
}

function invalidContext(): HarnessServiceError {
  return new HarnessServiceError(422, "invalid_request", "Candidate context is invalid");
}

function characterCount(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function validateSanitizedBasename(value: string): string {
  if (typeof value !== "string") throw new TypeError("filename must be a string");
  const length = characterCount(value);
  if (length < 1 || length > 255) throw new Error("filename must contain 1 to 255 characters");
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) throw new Error("filename must be a basename");
  for (const character of value) if ((character.codePointAt(0) ?? 0) < 32) throw new Error("filename contains unsafe characters");
  return value;
}

function attributedSource(name: string, category: SourceCategory, text: string): AttributedSource {
  validateSanitizedBasename(name);
  if (characterCount(text) > MAX_SOURCE_CHARACTERS) throw new Error("candidate source exceeds the character limit");
  return Object.freeze({ name, category, text });
}

async function readUtf8(upload: StoredUpload, maximumCharacters = MAX_SOURCE_CHARACTERS): Promise<string> {
  const bytes = await readFile(upload.path);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (characterCount(text) > maximumCharacters) throw new Error("candidate source exceeds the character limit");
  return text;
}

export async function loadCandidateContext(artifacts: StoredCandidateArtifacts): Promise<CandidateContext> {
  try {
    const resumeText = await readUtf8(artifacts.resumeSource, MAX_RESUME_SOURCE_CHARACTERS);
    const profileNarrative = attributedSource(artifacts.personalUpload.displayName, "profile", artifacts.personal.narrative);
    const contextSources = await Promise.all(artifacts.contexts.map(async (upload) => attributedSource(upload.displayName, "context", await readUtf8(upload))));
    const anecdotes = await Promise.all(artifacts.anecdotes.map(async (upload) => attributedSource(upload.displayName, "anecdote", await readUtf8(upload))));
    const resumeLength = characterCount(resumeText);
    const combinedLength = resumeLength + characterCount(profileNarrative.text)
      + contextSources.reduce((total, source) => total + characterCount(source.text), 0)
      + anecdotes.reduce((total, source) => total + characterCount(source.text), 0);
    const combinedLimit = BASE_COMBINED_NARRATIVE_CHARACTERS + Math.max(0, resumeLength - MAX_SOURCE_CHARACTERS);
    if (combinedLength > combinedLimit) throw invalidContext();
    const directFields: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of artifacts.personal.directFields) directFields[name] = value;
    return Object.freeze({
      directFields: Object.freeze(directFields),
      resumeText,
      profileNarrative,
      contextSources: Object.freeze(contextSources),
      anecdotes: Object.freeze(anecdotes),
    });
  } catch (error) {
    if (error instanceof HarnessServiceError) throw error;
    throw invalidContext();
  }
}

export function candidateEvidenceRecords(candidate: CandidateContext, resumeName: string): readonly AttributedEvidence[] {
  const records: AttributedEvidence[] = [Object.freeze({ category: "resume", name: validateSanitizedBasename(resumeName), text: candidate.resumeText })];
  if (candidate.profileNarrative.text.length > 0) records.push(Object.freeze({
    category: candidate.profileNarrative.category,
    name: validateSanitizedBasename(candidate.profileNarrative.name),
    text: candidate.profileNarrative.text,
  }));
  for (const source of [...candidate.contextSources, ...candidate.anecdotes]) {
    records.push(Object.freeze({ category: source.category, name: validateSanitizedBasename(source.name), text: source.text }));
  }
  for (const record of records) {
    if (!(["resume", "profile", "context", "anecdote"] as const).includes(record.category)) throw new Error("candidate evidence has an invalid category");
    const limit = record.category === "resume" ? MAX_RESUME_SOURCE_CHARACTERS : MAX_SOURCE_CHARACTERS;
    if (characterCount(record.text) > limit) throw new Error("candidate evidence exceeds the character limit");
  }
  return Object.freeze(records);
}

export function renderCandidateEvidence(candidate: CandidateContext, resumeName: string): string {
  const records = candidateEvidenceRecords(candidate, resumeName);
  return "Candidate evidence sources (one JSON object per line):\n" + records.map((record) => JSON.stringify({
    category: record.category,
    name: record.name,
    text: record.text,
  })).join("\n");
}
export async function extractPdfText(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const subprocess = Bun.spawn(["pdftotext", path, "-"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const abort = (): void => subprocess.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);
    signal?.throwIfAborted();
    if (exitCode !== 0) throw invalidContext();
    const text = stdout.replaceAll("\f", "").trimEnd();
    if (characterCount(text) > MAX_RESUME_SOURCE_CHARACTERS) throw invalidContext();
    return text;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw invalidContext();
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
interface CandidateContextPayload {
  readonly ok: boolean;
  readonly candidate?: CandidateContext;
}

async function runContextWorker(): Promise<void> {
  try {
    const artifacts = JSON.parse(await Bun.stdin.text()) as StoredCandidateArtifacts;
    const candidate = await loadCandidateContext(artifacts);
    process.stdout.write(JSON.stringify({ ok: true, candidate } satisfies CandidateContextPayload));
  } catch {
    process.stdout.write(JSON.stringify({ ok: false } satisfies CandidateContextPayload));
  }
}

export class CandidateContextProcess {
  readonly #subprocess: Bun.Subprocess<"pipe", "pipe", "ignore">;
  #resultPromise: Promise<CandidateContext> | undefined;
  #closed = false;

  constructor(artifacts: StoredCandidateArtifacts) {
    try {
      this.#subprocess = Bun.spawn([process.execPath, import.meta.path, "--candidate-context-worker"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      const stdin = this.#subprocess.stdin;
      if (stdin === undefined) throw new Error("failed to open context worker input");
      stdin.write(JSON.stringify(artifacts));
      stdin.end();
    } catch {
      throw invalidContext();
    }
  }

  async result(): Promise<CandidateContext> {
    if (this.#closed) throw invalidContext();
    this.#resultPromise ??= this.#receive();
    try {
      const candidate = await this.#resultPromise;
      this.#closed = true;
      return candidate;
    } catch (error) {
      this.#closed = true;
      if (error instanceof HarnessServiceError) throw error;
      throw invalidContext();
    }
  }

  async terminate(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#subprocess.kill();
    await this.#subprocess.exited.catch(() => undefined);
  }

  async #receive(): Promise<CandidateContext> {
    const output = await new Response(this.#subprocess.stdout).text();
    const exitCode = await Promise.race([
      this.#subprocess.exited,
      new Promise<number>((resolve) => setTimeout(() => {
        this.#subprocess.kill(9);
        resolve(-1);
      }, 5_000)),
    ]);
    if (exitCode !== 0) throw invalidContext();
    const payload = JSON.parse(output) as CandidateContextPayload;
    if (payload.ok !== true || payload.candidate === undefined) throw invalidContext();
    const candidate = payload.candidate;
    const profile = attributedSource(candidate.profileNarrative.name, "profile", candidate.profileNarrative.text);
    const contexts = candidate.contextSources.map((source) => attributedSource(source.name, "context", source.text));
    const anecdotes = candidate.anecdotes.map((source) => attributedSource(source.name, "anecdote", source.text));
    if (typeof candidate.resumeText !== "string" || characterCount(candidate.resumeText) > MAX_RESUME_SOURCE_CHARACTERS) throw invalidContext();
    const directFields: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(candidate.directFields)) {
      if (typeof value !== "string") throw invalidContext();
      directFields[name] = value;
    }
    return Object.freeze({
      directFields: Object.freeze(directFields),
      resumeText: candidate.resumeText,
      profileNarrative: profile,
      contextSources: Object.freeze(contexts),
      anecdotes: Object.freeze(anecdotes),
    });
  }
}

if (import.meta.main && process.argv.at(-1) === "--candidate-context-worker") {
  await runContextWorker();
}
