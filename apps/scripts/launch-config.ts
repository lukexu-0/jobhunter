import { resolve } from "node:path";

export interface LaunchConfiguration {
  readonly pipelinePort: number;
  readonly webPort: number;
  readonly pipelineOrigin: string;
  readonly webOrigin: string;
  readonly harnessOrigin: string;
  readonly pipelineDatabase: string;
  readonly contextDatabase: string;
  readonly authDatabase: string;
  readonly artifactRoot: string;
}

export function resolveLaunchConfiguration(
  mode: "dev" | "start",
  appsRoot: string,
): LaunchConfiguration {
  const development = mode === "dev";
  const pipelinePort = development ? 3557 : 3457;
  const webPort = development ? 3556 : 3456;
  return {
    pipelinePort,
    webPort,
    pipelineOrigin: `http://127.0.0.1:${pipelinePort}`,
    webOrigin: `http://127.0.0.1:${webPort}`,
    harnessOrigin: `http://127.0.0.1:${development ? 8865 : 8765}`,
    pipelineDatabase: resolve(
      appsRoot,
      `resume-tailoring/data/state/pipeline${development ? ".dev" : ""}.sqlite`,
    ),
    contextDatabase: resolve(
      appsRoot,
      `resume-tailoring/data/context/context${development ? ".dev" : ""}.sqlite`,
    ),
    authDatabase: resolve(
      appsRoot,
      `resume-tailoring/data/oauth/auth${development ? ".dev" : ""}.sqlite`,
    ),
    artifactRoot: resolve(appsRoot, development ? "../output/dev-runs" : "../output/runs"),
  };
}
