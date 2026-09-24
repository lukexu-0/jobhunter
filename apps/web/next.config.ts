import type { NextConfig } from "next";

const pipelineOrigin = process.env.JOBHUNT_PIPELINE_ORIGIN ?? "http://127.0.0.1:3457";

const nextConfig: NextConfig = {
  async rewrites() {
    return [{
      source: "/api/pipeline/:path*",
      destination: `${pipelineOrigin}/v1/:path*`,
    }];
  },
};

export default nextConfig;
