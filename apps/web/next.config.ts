import type { NextConfig } from "next";
import { DISCOVERY_WEB_PROXY_TIMEOUT_MS } from "@jobhunter/pipeline/discovery-config";

const pipelineOrigin = process.env.JOBHUNTER_PIPELINE_ORIGIN ?? "http://127.0.0.1:3457";

const nextConfig: NextConfig = {
  experimental: {
    proxyTimeout: DISCOVERY_WEB_PROXY_TIMEOUT_MS,
  },
  transpilePackages: ["@jobhunter/pipeline"],
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/api/pipeline/runs/:runId/application/events",
          destination: "/api/application-events/:runId",
        },
      ],
      afterFiles: [
        {
          source: "/api/pipeline/:path*",
          destination: `${pipelineOrigin}/v1/:path*`,
        },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
