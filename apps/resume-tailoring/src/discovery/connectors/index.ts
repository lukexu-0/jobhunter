import { z } from "zod";

import { canonicalizePublicHttpUrl } from "../../api/job-source";
import type { DiscoveryConnector } from "../types";
import { createAtsConnector } from "./ats";
import { createGitHubTableConnector } from "./github";
import type { GitHubTableConnectorConfig } from "./github";
import { createIndeedConnector } from "./indeed";
import type { IndeedAccessTokenResolver } from "./indeed";
import { SafePublicHttpClient } from "./http";
import type { ConnectorFetch, ResolveHost } from "./http";
import { createHtmlBoardConnector } from "./html-board";
import { createLinkedInConnector } from "./linkedin";
import { createWorkdayConnector } from "./workday";

export * from "./ats";
export * from "./github";
export * from "./indeed";
export * from "./html-board";
export * from "./http";
export * from "./linkedin";
export * from "./normalize";
export * from "./workday";

export interface DiscoveryConnectorFactoryOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly httpClient?: SafePublicHttpClient;
  readonly fetchImpl?: ConnectorFetch;
  readonly resolveHost?: ResolveHost;
  readonly indeedAccessTokenResolver?: IndeedAccessTokenResolver;
}

const SOURCE_ID = z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i);
const DISPLAY_NAME = z.string().trim().min(1).max(200);
const COMPANY = z.string().trim().min(1).max(200);
const IDENTIFIER = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/);
const MAX_JOBS = z.number().int().min(1).max(1_000).optional();
const MAX_PAGES = z.number().int().min(1).max(20).optional();
const SELECTOR = z.string().trim().min(1).max(200);
const ATTRIBUTE = z.string().trim().min(1).max(50).regex(/^[A-Za-z_:][-A-Za-z0-9_:.]*$/);

function isSyntacticallySafePublicUrl(value: string): boolean {
  try {
    return canonicalizePublicHttpUrl(value).protocol === "https:";
  } catch {
    return false;
  }
}

const PUBLIC_URL = z.string().trim().min(1).max(2_048).refine(isSyntacticallySafePublicUrl);
const PUBLIC_HOST = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/)
  .refine((host) => isSyntacticallySafePublicUrl(`https://${host}/`));
const COMMON_ATS = {
  id: SOURCE_ID,
  name: DISPLAY_NAME.optional(),
  company: COMPANY,
  maxJobs: MAX_JOBS,
} as const;
const ATS_SCHEMAS = [
  z.object({ ...COMMON_ATS, kind: z.literal("greenhouse"), boardToken: IDENTIFIER }).strict(),
  z.object({ ...COMMON_ATS, kind: z.literal("lever"), site: IDENTIFIER }).strict(),
  z.object({ ...COMMON_ATS, kind: z.literal("ashby"), boardName: IDENTIFIER }).strict(),
  z.object({ ...COMMON_ATS, kind: z.literal("smartrecruiters"), companyIdentifier: IDENTIFIER }).strict(),
  z.object({ ...COMMON_ATS, kind: z.literal("workable"), account: IDENTIFIER }).strict(),
  z.object({ ...COMMON_ATS, kind: z.literal("recruitee"), subdomain: IDENTIFIER }).strict(),
  z.object({
    ...COMMON_ATS,
    kind: z.literal("personio"),
    account: IDENTIFIER,
    domain: z.enum(["de", "com"]).optional(),
    language: z.string().trim().min(2).max(20).regex(/^[A-Za-z-]+$/).optional(),
  }).strict(),
] as const;
const WORKDAY_SCHEMA = z.object({
  kind: z.literal("workday"),
  id: SOURCE_ID,
  name: DISPLAY_NAME.optional(),
  host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+\.myworkdayjobs\.com$/i),
  tenant: IDENTIFIER,
  site: IDENTIFIER,
  searchText: z.string().trim().min(1).max(256),
  maxJobs: MAX_JOBS,
}).strict();
const LINKEDIN_URL = PUBLIC_URL.refine((value) => {
  const url = new URL(value);
  return url.port === ""
    && (url.hostname === "www.linkedin.com" || url.hostname === "linkedin.com")
    && /^\/jobs\/search\/?$/i.test(url.pathname);
});
const LINKEDIN_SCHEMA = z.object({
  kind: z.literal("linkedin"),
  id: SOURCE_ID,
  name: DISPLAY_NAME.optional(),
  searchUrls: z.array(LINKEDIN_URL).min(1).max(10),
  maxPages: z.number().int().min(1).max(5).optional(),
  maxJobs: z.number().int().min(1).max(100).optional(),
}).strict();
const INDEED_SEARCH_SCHEMA = z.object({
  query: z.string().trim().min(1).max(200),
  location: z.string().trim().min(1).max(200).optional(),
}).strict();
const INDEED_SCHEMA = z.object({
  kind: z.literal("indeed"),
  id: SOURCE_ID,
  name: DISPLAY_NAME.optional(),
  searches: z.array(INDEED_SEARCH_SCHEMA).min(1).max(10),
  maxJobs: z.number().int().min(1).max(100).optional(),
}).strict();
const SELECTOR_VALUE = z.object({
  selector: SELECTOR,
  attribute: ATTRIBUTE.optional(),
}).strict();
const URL_SELECTOR = z.object({
  selector: SELECTOR,
  attribute: ATTRIBUTE,
}).strict();
const HTML_BOARD_SCHEMA = z.object({
  kind: z.literal("job_board"),
  id: SOURCE_ID,
  name: DISPLAY_NAME,
  listUrl: PUBLIC_URL,
  allowedHosts: z.array(PUBLIC_HOST).min(1).max(10).optional(),
  maxPages: z.number().int().min(1).max(20),
  maxJobs: z.number().int().min(1).max(1_000),
  list: z.object({
    rowSelector: SELECTOR,
    title: SELECTOR_VALUE,
    company: SELECTOR_VALUE,
    detailUrl: URL_SELECTOR,
    applyUrl: URL_SELECTOR,
    location: SELECTOR_VALUE.optional(),
    date: SELECTOR_VALUE.optional(),
    id: SELECTOR_VALUE.optional(),
    nextPage: URL_SELECTOR.optional(),
  }).strict(),
  detail: z.object({
    descriptionSelector: SELECTOR,
    location: SELECTOR_VALUE.optional(),
    date: SELECTOR_VALUE.optional(),
  }).strict(),
}).strict();
const CONFIGURED_SOURCE_SCHEMA = z.discriminatedUnion("kind", [
  ...ATS_SCHEMAS,
  WORKDAY_SCHEMA,
  LINKEDIN_SCHEMA,
  INDEED_SCHEMA,
  HTML_BOARD_SCHEMA,
]);
const CONFIGURED_SOURCES_SCHEMA = z.array(CONFIGURED_SOURCE_SCHEMA).max(96);

const BUILT_IN_GITHUB_SOURCES: readonly Omit<GitHubTableConnectorConfig, "githubToken">[] = [
  {
    id: "simplify-summer-2027",
    name: "Simplify Summer 2027 Internships",
    kind: "simplify",
    owner: "SimplifyJobs",
    repo: "Summer2027-Internships",
    branch: "dev",
    path: "README.md",
  },
  {
    id: "zapply-underclassmen",
    name: "zapply Underclassmen Internships",
    kind: "zapply",
    owner: "zapplyjobs",
    repo: "underclassmen-internships",
    branch: "main",
    path: "README.md",
  },
  {
    id: "speedyapply-2027-swe",
    name: "speedyapply 2027 SWE College Jobs",
    kind: "speedyapply",
    owner: "speedyapply",
    repo: "2027-SWE-College-Jobs",
    branch: "main",
    path: "README.md",
  },
  {
    id: "speedyapply-2027-ai",
    name: "speedyapply 2027 AI College Jobs",
    kind: "speedyapply",
    owner: "speedyapply",
    repo: "2027-AI-College-Jobs",
    branch: "main",
    path: "README.md",
  },
];

function invalidConfiguration(): Error {
  return new Error("Invalid JOBHUNTER_DISCOVERY_SOURCES configuration");
}

async function defaultIndeedAccessTokenResolver(signal: AbortSignal): Promise<string> {
  const [{ getAuthStorage }, { resolveIndeedAccessToken }] = await Promise.all([
    import("../../auth/storage"),
    import("../../auth/indeed-oauth"),
  ]);
  return resolveIndeedAccessToken(await getAuthStorage(), signal);
}

export function createDiscoveryConnectorsFromEnvironment(
  options: DiscoveryConnectorFactoryOptions = {},
): readonly DiscoveryConnector[] {
  const env = options.env ?? process.env;
  const client = options.httpClient ?? new SafePublicHttpClient({
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
  });
  const rawGithubToken = env.GITHUB_TOKEN?.trim();
  const githubToken = rawGithubToken && /^[\x21-\x7e]{1,512}$/.test(rawGithubToken) ? rawGithubToken : undefined;
  const connectors: DiscoveryConnector[] = BUILT_IN_GITHUB_SOURCES.map((config) => createGitHubTableConnector({
    ...config,
    ...(githubToken ? { githubToken } : {}),
  }, client));
  const raw = env.JOBHUNTER_DISCOVERY_SOURCES?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidConfiguration();
    }
    const result = CONFIGURED_SOURCES_SCHEMA.safeParse(parsed);
    if (!result.success) throw invalidConfiguration();
    try {
      for (const source of result.data) {
        switch (source.kind) {
          case "greenhouse":
          case "lever":
          case "ashby":
          case "smartrecruiters":
          case "workable":
          case "recruitee":
          case "personio":
            connectors.push(createAtsConnector(source, client));
            break;
          case "workday": {
            const { kind: _kind, ...config } = source;
            connectors.push(createWorkdayConnector(config, client));
            break;
          }
          case "linkedin": {
            const { kind: _kind, ...config } = source;
            connectors.push(createLinkedInConnector(config, client));
            break;
          }
          case "job_board": {
            const { kind: _kind, ...config } = source;
            connectors.push(createHtmlBoardConnector(config, client));
            break;
          }
          case "indeed": {
            const { kind: _kind, ...config } = source;
            connectors.push(createIndeedConnector(
              config,
              options.indeedAccessTokenResolver ?? defaultIndeedAccessTokenResolver,
              client,
            ));
            break;
          }
        }
      }
    } catch {
      throw invalidConfiguration();
    }
  }
  const seen = new Set<string>();
  for (const connector of connectors) {
    if (seen.has(connector.id)) throw invalidConfiguration();
    seen.add(connector.id);
  }
  return connectors;
}
