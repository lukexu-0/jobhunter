import { createHash } from "node:crypto";
import type { DiscoveredJobInput } from "./types.ts";

const TRACKING_PARAMETER = /^(?:utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|referrer|source|src|campaign|tracking|trk)$/i;

function normalizedText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeRequisitionId(value: string | null | undefined): string | undefined {
  const normalized = normalizedText(value).replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeDiscoveryUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("discovery URL must be HTTP(S) without credentials");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith(".")) url.hostname = hostname.slice(0, -1);
  url.hash = "";
  const retained = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAMETER.test(name))
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [name, parameterValue] of retained) url.searchParams.append(name, parameterValue);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function atsKey(kind: string, tenant: string, identifier: string | undefined): string | undefined {
  const normalizedTenant = normalizedText(tenant).replace(/\s+/g, "");
  const normalizedIdentifier = normalizeRequisitionId(identifier);
  if (!normalizedTenant || !normalizedIdentifier) return undefined;
  return `${kind}:${normalizedTenant}:${normalizedIdentifier}`;
}

function hostnameMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function atsIdentity(urlValue: string): string | undefined {
  const url = new URL(urlValue);
  const hostname = url.hostname.toLowerCase();
  const segments: string[] = [];
  for (const segment of url.pathname.split("/").filter(Boolean)) {
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  if (hostname === "boards.greenhouse.io" || hostname === "job-boards.greenhouse.io") {
    const greenhouseId = url.searchParams.get("gh_jid") ?? undefined;
    if (greenhouseId) return atsKey("greenhouse", segments[0] ?? hostname, greenhouseId);
    const jobsIndex = segments.lastIndexOf("jobs");
    if (jobsIndex >= 0 && segments[jobsIndex + 1]) {
      return atsKey("greenhouse", segments[0] ?? hostname, segments[jobsIndex + 1]);
    }
  }
  if (hostnameMatches(hostname, "lever.co") && segments.length >= 2) {
    return atsKey("lever", segments[0]!, segments.at(-1));
  }
  if (hostnameMatches(hostname, "ashbyhq.com") && segments.length >= 2) {
    return atsKey("ashby", segments[0]!, segments.at(-1));
  }
  if (hostnameMatches(hostname, "smartrecruiters.com") && segments.length >= 2) {
    return atsKey("smartrecruiters", segments[0]!, segments.at(-1));
  }
  if (hostnameMatches(hostname, "myworkdayjobs.com") && segments.length > 0) {
    return atsKey("workday", hostname, segments.at(-1));
  }
  return undefined;
}

export function discoveryDedupeKeys(input: Pick<
  DiscoveredJobInput,
  "applyUrl" | "canonicalUrl" | "company" | "title" | "location" | "description"
  | "postedAt" | "requisitionId"
>): readonly string[] {
  const keys = new Set<string>();
  const requisitionId = normalizeRequisitionId(input.requisitionId);
  if (requisitionId) {
    keys.add(`requisition:${normalizedText(input.company).replace(/\s+/g, "")}:${requisitionId}`);
  }
  for (const urlValue of [input.applyUrl, input.canonicalUrl]) {
    const url = normalizeDiscoveryUrl(urlValue);
    keys.add(`url:${url}`);
    const ats = atsIdentity(url);
    if (ats && !ats.endsWith(":")) keys.add(ats);
  }
  if (
    input.postedAt !== null
    && input.postedAt !== undefined
    && input.description !== null
  ) {
    const postedDay = new Date(input.postedAt).toISOString().slice(0, 10);
    const descriptionFingerprint = createHash("sha256")
      .update(normalizedText(input.description))
      .digest("hex");
    keys.add(
      `fallback:${normalizedText(input.company)}|${normalizedText(input.title)}|${normalizedText(input.location)}|${postedDay}|${requisitionId ?? "no-requisition"}|${descriptionFingerprint}`,
    );
  }
  return [...keys].sort();
}
