import { describe, expect, test } from "bun:test";
import { resolveLaunchConfiguration } from "./launch-config.ts";

describe("workspace launch configuration", () => {
  test("development uses isolated loopback ports and writable storage", () => {
    expect(resolveLaunchConfiguration("dev", "/srv/jobhunter/apps")).toEqual({
      pipelinePort: 3557,
      webPort: 3556,
      pipelineOrigin: "http://127.0.0.1:3557",
      webOrigin: "http://127.0.0.1:3556",
      pipelineDatabase: "/srv/jobhunter/apps/resume-tailoring/data/state/pipeline.dev.sqlite",
      contextDatabase: "/srv/jobhunter/apps/resume-tailoring/data/context/context.dev.sqlite",
      authDatabase: "/srv/jobhunter/apps/resume-tailoring/data/oauth/auth.dev.sqlite",
      artifactRoot: "/srv/jobhunter/output/dev-runs",
    });
  });

  test("stable start keeps the production ports and current database", () => {
    expect(resolveLaunchConfiguration("start", "/srv/jobhunter/apps")).toEqual({
      pipelinePort: 3457,
      webPort: 3456,
      pipelineOrigin: "http://127.0.0.1:3457",
      webOrigin: "http://127.0.0.1:3456",
      pipelineDatabase: "/srv/jobhunter/apps/resume-tailoring/data/state/pipeline.sqlite",
      contextDatabase: "/srv/jobhunter/apps/resume-tailoring/data/context/context.sqlite",
      authDatabase: "/srv/jobhunter/apps/resume-tailoring/data/oauth/auth.sqlite",
      artifactRoot: "/srv/jobhunter/output/runs",
    });
  });
});
