import { z } from "zod";
import type { RecruitingEventPreferences } from "../contracts";
import type { RecruitingEventCandidate } from "./repository.ts";

export interface LoadedRecruitingEventSource {
  readonly url: string;
  readonly lines: readonly string[];
  readonly jsonLd: readonly unknown[];
}

export interface RecruitingEventExtractionContext {
  readonly school: string | null;
  readonly sourceUrl: string;
  readonly now: number;
}

export type ExtractRecruitingEventsWithModel = (
  lines: readonly string[],
  context: RecruitingEventExtractionContext,
  signal?: AbortSignal,
) => Promise<readonly RecruitingEventCandidate[]>;

export interface RecruitingEventParseOptions {
  readonly preferences: RecruitingEventPreferences;
  readonly now: number;
  readonly extractWithModel: ExtractRecruitingEventsWithModel;
  readonly signal?: AbortSignal;
}

const CandidateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  organizer: z.string().trim().min(1).max(200),
  startAt: z.number().int().nonnegative(),
  endAt: z.number().int().nonnegative().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  location: z.string().trim().min(1).max(300).optional(),
  attendance: z.enum(["virtual", "in_person", "hybrid", "unknown"]),
  registrationUrl: z.string().url().max(2_048),
  description: z.string().trim().min(1).max(4_000).optional(),
  eligibilitySummary: z.string().trim().min(1).max(1_000).optional(),
  matchedForApplicant: z.boolean(),
}).strict().refine(
  ({ startAt, endAt }) => endAt === undefined || endAt >= startAt,
  { message: "Event end must not precede its start" },
);

function parsedCandidate(value: unknown): RecruitingEventCandidate | undefined {
  const parsed = CandidateSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const candidate = parsed.data;
  return {
    title: candidate.title,
    organizer: candidate.organizer,
    startAt: candidate.startAt,
    ...(candidate.endAt === undefined ? {} : { endAt: candidate.endAt }),
    ...(candidate.timezone === undefined ? {} : { timezone: candidate.timezone }),
    ...(candidate.location === undefined ? {} : { location: candidate.location }),
    attendance: candidate.attendance,
    registrationUrl: candidate.registrationUrl,
    ...(candidate.description === undefined ? {} : { description: candidate.description }),
    ...(candidate.eligibilitySummary === undefined
      ? {}
      : { eligibilitySummary: candidate.eligibilitySummary }),
    matchedForApplicant: candidate.matchedForApplicant,
  };
}

const EVENT_TYPES = new Set(["Event", "BusinessEvent", "EducationEvent", "SocialEvent"]);

function compact(value: string, maximum: number): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function typeIsEvent(value: unknown): boolean {
  if (typeof value === "string") return EVENT_TYPES.has(value.split("/").at(-1) ?? value);
  return Array.isArray(value) && value.some(typeIsEvent);
}

function collectEventObjects(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEventObjects(item, output);
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  if (typeIsEvent(object["@type"])) output.push(object);
  for (const child of Object.values(object)) collectEventObjects(child, output);
}

function namedValue(value: unknown): string | undefined {
  if (typeof value === "string") return compact(value, 300) || undefined;
  if (Array.isArray(value)) {
    const values = value.map(namedValue).filter((item): item is string => item !== undefined);
    return values.length === 0 ? undefined : compact(values.join(", "), 300);
  }
  const object = objectValue(value);
  if (!object) return undefined;
  return namedValue(object.name ?? object.description);
}

function locationValue(value: unknown): string | undefined {
  const object = objectValue(value);
  if (!object) return namedValue(value);
  const type = typeof object["@type"] === "string" ? object["@type"] : "";
  if (type.includes("VirtualLocation")) return "Online";
  const address = objectValue(object.address);
  const addressText = address
    ? [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode]
      .filter((part): part is string => typeof part === "string")
      .join(", ")
    : namedValue(object.address);
  const location = [namedValue(object.name), addressText]
    .filter((part): part is string => Boolean(part))
    .join(" — ");
  return compact(location, 300) || undefined;
}

function attendanceValue(value: unknown): RecruitingEventCandidate["attendance"] {
  const values = Array.isArray(value) ? value : [value];
  const joined = values.filter((item): item is string => typeof item === "string").join(" ");
  if (/MixedEventAttendanceMode|hybrid/i.test(joined)) return "hybrid";
  if (/OnlineEventAttendanceMode|virtual|online/i.test(joined)) return "virtual";
  if (/OfflineEventAttendanceMode|in.?person/i.test(joined)) return "in_person";
  return "unknown";
}

function resolvedUrl(value: unknown, base: string): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function registrationUrl(event: Record<string, unknown>, base: string): string {
  const offers = Array.isArray(event.offers) ? event.offers : [event.offers];
  for (const offerValue of offers) {
    const offer = objectValue(offerValue);
    const url = resolvedUrl(offer?.url, base);
    if (url) return url;
  }
  return resolvedUrl(event.url, base) ?? base;
}

function schoolTerms(school: string | null): readonly string[] {
  if (!school) return [];
  const normalized = compact(school, 200).toLocaleLowerCase("en-US");
  const initials = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !new Set(["of", "the", "and", "at"]).has(word))
    .map((word) => word[0])
    .join("");
  return initials.length >= 2 ? [normalized, initials] : [normalized];
}

function matchesSchool(eligibility: string | undefined, school: string | null): boolean {
  if (!eligibility) return true;
  const normalized = eligibility.toLocaleLowerCase("en-US");
  const terms = schoolTerms(school);
  return terms.length === 0 || terms.some((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(normalized));
}

function parseDate(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function structuredCandidate(
  event: Record<string, unknown>,
  sourceUrl: string,
  school: string | null,
): RecruitingEventCandidate | undefined {
  const title = namedValue(event.name);
  const organizer = namedValue(event.organizer ?? event.performer);
  const startAt = parseDate(event.startDate);
  if (!title || !organizer || startAt === undefined) return undefined;
  const endAt = parseDate(event.endDate);
  const description = typeof event.description === "string"
    ? compact(event.description, 4_000) || undefined
    : undefined;
  const eligibilitySummary = namedValue(event.audience ?? event.typicalAgeRange);
  return parsedCandidate({
    title,
    organizer,
    startAt,
    ...(endAt === undefined ? {} : { endAt }),
    ...(locationValue(event.location) ? { location: locationValue(event.location) } : {}),
    attendance: attendanceValue(event.eventAttendanceMode),
    registrationUrl: registrationUrl(event, sourceUrl),
    ...(description ? { description } : {}),
    ...(eligibilitySummary ? { eligibilitySummary } : {}),
    matchedForApplicant: matchesSchool(eligibilitySummary, school),
  });
}

function upcoming(
  candidates: readonly RecruitingEventCandidate[],
  now: number,
): RecruitingEventCandidate[] {
  return candidates
    .map(parsedCandidate)
    .filter((candidate): candidate is RecruitingEventCandidate => candidate !== undefined)
    .filter((candidate) => (candidate.endAt ?? candidate.startAt) >= now);
}

export interface RecruitingEventParseResult {
  readonly parser: "deterministic" | "llm";
  readonly candidates: readonly RecruitingEventCandidate[];
}

export async function parseRecruitingEventSource(
  source: LoadedRecruitingEventSource,
  options: RecruitingEventParseOptions,
): Promise<RecruitingEventParseResult> {
  options.signal?.throwIfAborted();
  const eventObjects: Record<string, unknown>[] = [];
  for (const value of source.jsonLd) collectEventObjects(value, eventObjects);
  if (eventObjects.length > 0) {
    const candidates = eventObjects
      .map((event) => structuredCandidate(event, source.url, options.preferences.school))
      .filter((candidate): candidate is RecruitingEventCandidate => candidate !== undefined);
    if (candidates.length > 0) {
      return { parser: "deterministic", candidates: upcoming(candidates, options.now) };
    }
  }

  const modelCandidates = await options.extractWithModel(
    source.lines,
    { school: options.preferences.school, sourceUrl: source.url, now: options.now },
    options.signal,
  );
  return { parser: "llm", candidates: upcoming(modelCandidates, options.now) };
}
