import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@jobhunter/pipeline"],
  async rewrites() {
    return [
      {
        source: "/api/pipeline/:path*",
        destination: "http://127.0.0.1:3457/v1/:path*",
      },
    ];
  },
};

export default nextConfig;
