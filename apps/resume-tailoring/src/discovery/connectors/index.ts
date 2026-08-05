import type { DiscoveryConnector } from "../types";
import {
  createGitHubTableConnector,
  type GitHubTableConnectorConfig,
} from "./github";
import { SafePublicHttpClient } from "./http";
import type { ConnectorFetch, ResolveHost } from "./http";

export * from "./github";
export * from "./http";
export * from "./normalize";

export interface DiscoveryConnectorFactoryOptions {
  readonly env?: Readonly<Pick<NodeJS.ProcessEnv, "GITHUB_TOKEN">>;
  readonly httpClient?: SafePublicHttpClient;
  readonly fetchImpl?: ConnectorFetch;
  readonly resolveHost?: ResolveHost;
}

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
    id: "simplify-summer-2027-off-season",
    name: "Simplify Summer 2027 Off-Season Internships",
    kind: "simplify",
    owner: "SimplifyJobs",
    repo: "Summer2027-Internships",
    branch: "dev",
    path: "README-Off-Season.md",
  },
  {
    id: "zapply-underclassmen",
    name: "zapply 2027 Internships",
    kind: "zapply",
    owner: "zapplyjobs",
    repo: "Internships-2027",
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

export function createDiscoveryConnectors(
  options: DiscoveryConnectorFactoryOptions = {},
): readonly DiscoveryConnector[] {
  const env = options.env ?? process.env;
  const client = options.httpClient ?? new SafePublicHttpClient({
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.resolveHost === undefined ? {} : { resolveHost: options.resolveHost }),
  });
  const rawGithubToken = env.GITHUB_TOKEN?.trim();
  const githubToken = rawGithubToken && /^[\x21-\x7e]{1,512}$/.test(rawGithubToken)
    ? rawGithubToken
    : undefined;

  return BUILT_IN_GITHUB_SOURCES.map((config) => createGitHubTableConnector({
    ...config,
    ...(githubToken ? { githubToken } : {}),
  }, client));
}
