import { constants } from "node:fs";
import { chmod, lstat, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  BrowserConfigurationError,
  HarnessServiceError,
  decodeUtf8,
  parseStrictJson,
  preparePrivateDirectory,
  replacePrivateFile,
} from "./credentials.ts";

const MAX_V1_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_GLOBAL_FACTS = 200;
const MAX_APPLICATIONS = 1_000;
const MAX_APPLICATION_FACTS = 100;
const MAX_SELECTED_OPTIONS = 100;
const MAX_STORED_FACTS = MAX_GLOBAL_FACTS + MAX_APPLICATIONS * MAX_APPLICATION_FACTS;
const MAX_V2_DOCUMENT_BYTES = 2 * MAX_V1_DOCUMENT_BYTES + MAX_STORED_FACTS * 23;
const MAX_PROJECTION_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
const EMPTY_DOCUMENT = Buffer.from('{"version":2,"global":{},"applications":{}}');
const KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

type AnswerType = "text" | "boolean" | "single_select" | "multi_select";
type Status = "answered" | "declined";
type SavedValue = string | boolean | readonly string[];
export type SavedUserInfoFact =
  | { readonly answer_type: AnswerType; readonly status: "declined" }
  | { readonly answer_type: AnswerType; readonly status: "answered"; readonly value: SavedValue };

interface StoredFact {
  saved: SavedUserInfoFact;
  question: string;
  updatedAt: string;
  rawValue?: string;
}

interface DocumentModel {
  globalFacts: Record<string, StoredFact>;
  applications: Record<string, Record<string, StoredFact>>;
}

export interface AdditionalInfoOption {
  id: string;
  label: string;
}

export interface AdditionalInfoQuestion {
  id: string;
  key: string;
  scope: "global" | "application";
  question: string;
  answer_type: AnswerType;
  options?: readonly AdditionalInfoOption[];
}

export type AdditionalInfoAnswer =
  | { id: string; status: "declined" }
  | { id: string; status: "answered"; raw_value: string; value: string }
  | { id: string; status: "answered"; value: boolean }
  | { id: string; status: "answered"; option_id: string }
  | { id: string; status: "answered"; option_ids: readonly string[] };

export interface AcceptedAdditionalInfoAnswer {
  readonly id: string;
  readonly key: string;
  readonly scope: "global" | "application";
  readonly answer_type: AnswerType;
  readonly status: Status;
  readonly value?: SavedValue;
}

export interface ApplicationAnswerSuggestion {
  readonly question: string;
  readonly answer: string;
}

export class UserInfoSnapshot {
  constructor(
    readonly savedGlobal: Readonly<Record<string, SavedUserInfoFact>>,
    readonly savedApplication: Readonly<Record<string, SavedUserInfoFact>>,
    readonly rawTextValues: ReadonlySet<string>,
  ) {}

  asTaskPayload(): {
    saved_global: Readonly<Record<string, SavedUserInfoFact>>;
    saved_application: Readonly<Record<string, SavedUserInfoFact>>;
  } {
    return {
      saved_global: taskProjection(this.savedGlobal),
      saved_application: taskProjection(this.savedApplication),
    };
  }
}

class Mutex {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class UserInfoStore {
  private readonly mutex = new Mutex();

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<UserInfoStore> {
    const store = new UserInfoStore(path);
    try {
      await preparePrivateDirectory(dirname(path), true, false);
      try {
        const target = await lstat(path);
        if (target.isSymbolicLink()) {
          throw new BrowserConfigurationError("The user information store must not be a symbolic link");
        }
        if (!target.isFile()) throw new Error("not a regular file");
        await chmod(path, 0o600);
      } catch (error) {
        if (error instanceof BrowserConfigurationError) throw error;
        if (!isMissing(error)) throw error;
        await createEmptyStore(path);
      }
      await store.readDocumentWithContents();
      return store;
    } catch (error) {
      if (error instanceof BrowserConfigurationError) throw error;
      throw new BrowserConfigurationError("The user information store is invalid or unavailable");
    }
  }

  async readContents(): Promise<string> {
    try {
      return (await this.readDocumentWithContents()).contents;
    } catch (error) {
      if (error instanceof HarnessServiceError) throw error;
      throw internalError();
    }
  }

  async snapshot(jobUrl: string): Promise<UserInfoSnapshot> {
    const validatedJobUrl = validateJobUrl(jobUrl);
    try {
      const { document } = await this.readDocumentWithContents();
      const application = document.applications[validatedJobUrl] ?? {};
      return new UserInfoSnapshot(
        Object.freeze(savedProjection(document.globalFacts)),
        Object.freeze(savedProjection(application)),
        new Set(rawTextValues(document.globalFacts, application)),
      );
    } catch (error) {
      if (error instanceof HarnessServiceError) throw error;
      throw internalError();
    }
  }

  async suggestions(jobUrl: string, question: AdditionalInfoQuestion): Promise<readonly ApplicationAnswerSuggestion[]> {
    const validatedJobUrl = validateJobUrl(jobUrl);
    try {
      const { document } = await this.readDocumentWithContents();
      const candidates = [
        ...Object.entries(document.applications[validatedJobUrl] ?? {}),
        ...Object.entries(document.globalFacts),
      ];
      candidates.sort((left, right) => {
        const exact = Number(right[0] === question.key) - Number(left[0] === question.key);
        return exact || Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt);
      });
      const seen = new Set<string>();
      const result: ApplicationAnswerSuggestion[] = [];
      for (const [, fact] of candidates) {
        if (fact.saved.answer_type !== "text" || fact.saved.status !== "answered" || typeof fact.saved.value !== "string" || seen.has(fact.saved.value)) continue;
        seen.add(fact.saved.value);
        result.push({ question: fact.question, answer: fact.saved.value });
        if (result.length === 5) break;
      }
      return result;
    } catch (error) {
      if (error instanceof HarnessServiceError) throw error;
      throw internalError();
    }
  }

  async merge(
    jobUrl: string,
    questions: readonly AdditionalInfoQuestion[],
    answers: readonly AdditionalInfoAnswer[],
  ): Promise<readonly AcceptedAdditionalInfoAnswer[]> {
    let validatedJobUrl: string;
    try {
      validatedJobUrl = validateJobUrl(jobUrl);
    } catch {
      throw conflictError();
    }
    const { accepted, replacements } = acceptAnswers(questions, answers);
    return this.mutex.run(async () => {
      let current: DocumentModel;
      try {
        current = (await this.readDocumentWithContents()).document;
      } catch {
        throw internalError();
      }
      const candidate: DocumentModel = {
        globalFacts: { ...current.globalFacts },
        applications: Object.fromEntries(
          Object.entries(current.applications).map(([url, facts]) => [url, { ...facts }]),
        ),
      };
      for (const [question, fact] of replacements) {
        const destination = question.scope === "global"
          ? candidate.globalFacts
          : (candidate.applications[validatedJobUrl] ??= {});
        destination[question.key] = fact;
      }
      let encoded: Buffer;
      try {
        encoded = encodeAndValidate(candidate);
      } catch {
        throw conflictError();
      }
      try {
        await replacePrivateFile(this.path, encoded, false);
      } catch (error) {
        if (error instanceof HarnessServiceError) throw error;
        throw internalError();
      }
      return accepted;
    });
  }

  private async readDocumentWithContents(): Promise<{ document: DocumentModel; contents: string }> {
    const target = await lstat(this.path);
    if (target.isSymbolicLink() || !target.isFile()) throw new Error("unsafe target");
    if (target.size > MAX_V2_DOCUMENT_BYTES) throw new Error("document too large");
    const encoded = await readFile(this.path);
    if (encoded.byteLength > MAX_V2_DOCUMENT_BYTES) throw new Error("document too large");
    const contents = decodeUtf8(encoded);
    const raw = parseStrictJson(contents);
    const version = recordField(raw, "version");
    const maximum = version === 1 ? MAX_V1_DOCUMENT_BYTES : MAX_V2_DOCUMENT_BYTES;
    const document = parseDocument(raw);
    validateBounds(document, encoded.byteLength, maximum);
    return { document, contents };
  }
}

function acceptAnswers(
  questions: readonly AdditionalInfoQuestion[],
  answers: readonly AdditionalInfoAnswer[],
): {
  accepted: AcceptedAdditionalInfoAnswer[];
  replacements: Array<readonly [AdditionalInfoQuestion, StoredFact]>;
} {
  if (questions.length < 1 || questions.length > 20 || answers.length !== questions.length) throw conflictError();
  const questionById = new Map<string, AdditionalInfoQuestion>();
  const scopedKeys = new Set<string>();
  for (const question of questions) {
    validateQuestion(question);
    const scopedKey = `${question.scope}\0${question.key}`;
    if (questionById.has(question.id) || scopedKeys.has(scopedKey)) throw conflictError();
    questionById.set(question.id, question);
    scopedKeys.add(scopedKey);
  }
  const answerById = new Map<string, AdditionalInfoAnswer>();
  for (const answer of answers) {
    if (!QUESTION_ID_PATTERN.test(answer.id)) throw conflictError();
    if (answerById.has(answer.id) || !questionById.has(answer.id)) throw conflictError();
    answerById.set(answer.id, answer);
  }
  if (answerById.size !== questionById.size) throw conflictError();

  const updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, (fraction) => fraction);
  const accepted: AcceptedAdditionalInfoAnswer[] = [];
  const replacements: Array<readonly [AdditionalInfoQuestion, StoredFact]> = [];
  for (const question of questions) {
    const answer = answerById.get(question.id)!;
    const semantic = semanticValue(question, answer);
    const result: AcceptedAdditionalInfoAnswer = answer.status === "declined"
      ? { id: question.id, key: question.key, scope: question.scope, answer_type: question.answer_type, status: "declined" }
      : { id: question.id, key: question.key, scope: question.scope, answer_type: question.answer_type, status: "answered", value: semantic as SavedValue };
    accepted.push(result);
    replacements.push([question, {
      saved: answer.status === "declined"
        ? { answer_type: question.answer_type, status: "declined" }
        : { answer_type: question.answer_type, status: "answered", value: semantic as SavedValue },
      question: question.question,
      updatedAt,
      ...(question.answer_type === "text" && answer.status === "answered" && "raw_value" in answer
        ? { rawValue: normalizeAnswerText(answer.raw_value) }
        : {}),
    }]);
  }
  return { accepted, replacements };
}


function validateQuestion(question: AdditionalInfoQuestion): void {
  if (
    !QUESTION_ID_PATTERN.test(question.id)
    || Array.from(question.key).length > 100
    || !KEY_PATTERN.test(question.key)
    || (question.scope !== "global" && question.scope !== "application")
    || !isAnswerType(question.answer_type)
    || question.question.trim() !== question.question
    || Array.from(question.question).length < 1
    || Array.from(question.question).length > 500
  ) throw conflictError();
  if (question.answer_type === "single_select" || question.answer_type === "multi_select") {
    const options = question.options;
    if (!options || options.length < 2 || options.length > 100) throw conflictError();
    const ids = new Set<string>();
    for (const option of options) {
      if (!QUESTION_ID_PATTERN.test(option.id) || ids.has(option.id) || option.label.trim() !== option.label || Array.from(option.label).length < 1 || Array.from(option.label).length > 200) throw conflictError();
      ids.add(option.id);
    }
  }
}
function semanticValue(question: AdditionalInfoQuestion, answer: AdditionalInfoAnswer): SavedValue | undefined {
  if (answer.status === "declined") return undefined;
  if (question.answer_type === "text" && "raw_value" in answer && typeof answer.value === "string") {
    normalizeAnswerText(answer.raw_value);
    return normalizeAnswerText(answer.value);
  }
  if (question.answer_type === "boolean" && "value" in answer && typeof answer.value === "boolean") return answer.value;
  const options = Object.fromEntries((question.options ?? []).map((option) => [option.id, option.label]));
  if (question.answer_type === "single_select" && "option_id" in answer && options[answer.option_id] !== undefined) return options[answer.option_id];
  if (question.answer_type === "multi_select" && "option_ids" in answer && answer.option_ids.length >= 1 && answer.option_ids.length <= MAX_SELECTED_OPTIONS && new Set(answer.option_ids).size === answer.option_ids.length && answer.option_ids.every((id) => options[id] !== undefined)) {
    return answer.option_ids.map((id) => options[id]!);
  }
  throw conflictError();
}


function normalizeAnswerText(value: unknown): string {
  if (typeof value !== "string") throw conflictError();
  const normalized = value.trim();
  if (Array.from(normalized).length < 1 || Array.from(normalized).length > 2_000) throw conflictError();
  return normalized;
}
function parseDocument(raw: unknown): DocumentModel {
  const root = requireRecord(raw);
  if (!hasExactKeys(root, ["version", "global", "applications"]) || (root.version !== 1 && root.version !== 2)) throw new Error("invalid root");
  const version = root.version;
  const globalFacts = parseFactMap(root.global, MAX_GLOBAL_FACTS, version);
  const applicationsRaw = requireRecord(root.applications);
  if (Object.keys(applicationsRaw).length > MAX_APPLICATIONS) throw new Error("too many applications");
  const applications: Record<string, Record<string, StoredFact>> = {};
  for (const [jobUrl, facts] of Object.entries(applicationsRaw)) {
    if (validateJobUrl(jobUrl) !== jobUrl) throw new Error("invalid application URL");
    applications[jobUrl] = parseFactMap(facts, MAX_APPLICATION_FACTS, version);
  }
  return { globalFacts, applications };
}

function parseFactMap(raw: unknown, maximum: number, version: 1 | 2): Record<string, StoredFact> {
  const map = requireRecord(raw);
  if (Object.keys(map).length > maximum) throw new Error("too many facts");
  const facts: Record<string, StoredFact> = {};
  for (const [key, value] of Object.entries(map)) {
    if (Array.from(key).length > 100 || !KEY_PATTERN.test(key)) throw new Error("invalid fact key");
    facts[key] = parseFact(value, version);
  }
  return facts;
}

function parseFact(raw: unknown, version: 1 | 2): StoredFact {
  const fact = requireRecord(raw);
  const answerType = fact.answer_type;
  const status = fact.status;
  if (!isAnswerType(answerType) || (status !== "answered" && status !== "declined")) throw new Error("invalid fact type");
  const textV2 = version === 2 && answerType === "text" && status === "answered";
  const expected = ["answer_type", "status", "question", "updated_at"];
  if (textV2) expected.push("raw_value", "sanitized_value");
  else if (status === "answered") expected.push("value");
  if (!hasExactKeys(fact, expected)) throw new Error("invalid fact fields");
  if (typeof fact.question !== "string" || fact.question.trim() !== fact.question || fact.question.length < 1 || Array.from(fact.question).length > 500) throw new Error("invalid question");
  if (!validTimestamp(fact.updated_at)) throw new Error("invalid timestamp");
  if (status === "declined") return { saved: { answer_type: answerType, status }, question: fact.question, updatedAt: fact.updated_at };
  if (textV2) {
    const rawValue = validateSavedValue("text", fact.raw_value) as string;
    const sanitized = validateSavedValue("text", fact.sanitized_value) as string;
    return { saved: { answer_type: answerType, status, value: sanitized }, question: fact.question, updatedAt: fact.updated_at, rawValue };
  }
  const value = validateSavedValue(answerType, fact.value);
  return {
    saved: { answer_type: answerType, status, value },
    question: fact.question,
    updatedAt: fact.updated_at,
    ...(answerType === "text" ? { rawValue: value as string } : {}),
  };
}

function validateSavedValue(answerType: AnswerType, value: unknown): SavedValue {
  if (answerType === "boolean") {
    if (typeof value !== "boolean") throw new Error("invalid boolean");
    return value;
  }
  if (answerType === "text" || answerType === "single_select") {
    const maximum = answerType === "text" ? 2_000 : 200;
    if (typeof value !== "string" || value.trim() !== value || Array.from(value).length < 1 || Array.from(value).length > maximum) throw new Error("invalid string value");
    return value;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SELECTED_OPTIONS || value.some((item) => typeof item !== "string" || item.trim() !== item || Array.from(item).length < 1 || Array.from(item).length > 200)) throw new Error("invalid multi-select");
  return value as string[];
}

function validateBounds(document: DocumentModel, encodedSize: number, maximum: number): void {
  if (encodedSize > maximum) throw new Error("document too large");
  validateProjection(document.globalFacts, {});
  for (const application of Object.values(document.applications)) validateProjection(document.globalFacts, application);
}

function validateProjection(globalFacts: Record<string, StoredFact>, applicationFacts: Record<string, StoredFact>): void {
  const global = taskProjection(savedProjection(globalFacts));
  const application = taskProjection(savedProjection(applicationFacts));
  if (compactSize(global) > MAX_PROJECTION_BYTES || compactSize(application) > MAX_PROJECTION_BYTES || compactSize({ saved_global: global, saved_application: application }) > MAX_SNAPSHOT_BYTES) throw new Error("projection too large");
}

function encodeAndValidate(document: DocumentModel): Buffer {
  if (Object.keys(document.globalFacts).length > MAX_GLOBAL_FACTS || Object.keys(document.applications).length > MAX_APPLICATIONS || Object.values(document.applications).some((facts) => Object.keys(facts).length > MAX_APPLICATION_FACTS)) throw new Error("too many facts");
  const disk = {
    version: 2,
    global: diskFactMap(document.globalFacts),
    applications: Object.fromEntries(Object.entries(document.applications).map(([url, facts]) => [url, diskFactMap(facts)])),
  };
  const encoded = Buffer.from(JSON.stringify(disk));
  validateBounds(document, encoded.byteLength, MAX_V2_DOCUMENT_BYTES);
  return encoded;
}

function diskFactMap(facts: Record<string, StoredFact>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(facts).map(([key, fact]) => {
    const base: Record<string, unknown> = { answer_type: fact.saved.answer_type, status: fact.saved.status };
    if (fact.saved.status === "answered" && fact.saved.answer_type === "text") {
      base.raw_value = fact.rawValue;
      base.sanitized_value = fact.saved.value;
    } else if (fact.saved.status === "answered") {
      base.value = fact.saved.value;
    }
    base.question = fact.question;
    base.updated_at = fact.updatedAt;
    return [key, base];
  }));
}

function savedProjection(facts: Record<string, StoredFact>): Record<string, SavedUserInfoFact> {
  return Object.fromEntries(Object.entries(facts).map(([key, fact]) => [key, fact.saved]));
}

function taskProjection(facts: Readonly<Record<string, SavedUserInfoFact>>): Record<string, SavedUserInfoFact> {
  return Object.fromEntries(Object.entries(facts).map(([key, fact]) => [key, fact.status === "answered"
    ? { answer_type: fact.answer_type, status: fact.status, value: Array.isArray(fact.value) ? [...fact.value] : fact.value }
    : { answer_type: fact.answer_type, status: fact.status }]));
}

function rawTextValues(...maps: Array<Record<string, StoredFact>>): string[] {
  const values = new Set<string>();
  for (const facts of maps) for (const fact of Object.values(facts)) {
    if (fact.saved.answer_type === "text" && fact.saved.status === "answered" && fact.rawValue) values.add(fact.rawValue);
  }
  return [...values];
}

function validateJobUrl(value: string): string {
  if (typeof value !== "string") throw new TypeError("job URL");
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (!url.hostname || url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error("invalid job URL");
  return value;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() === Number(year) && parsed.getUTCMonth() + 1 === Number(month) && parsed.getUTCDate() === Number(day) && parsed.getUTCHours() === Number(hour) && parsed.getUTCMinutes() === Number(minute) && parsed.getUTCSeconds() === Number(second);
}

function isAnswerType(value: unknown): value is AnswerType {
  return value === "text" || value === "boolean" || value === "single_select" || value === "multi_select";
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}

function recordField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function compactSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

async function createEmptyStore(path: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(EMPTY_DOCUMENT);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

function conflictError(): HarnessServiceError {
  return new HarnessServiceError(409, "command_conflict", "Additional information cannot be saved");
}

function internalError(): HarnessServiceError {
  return new HarnessServiceError(500, "internal_error", "Request failed");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
