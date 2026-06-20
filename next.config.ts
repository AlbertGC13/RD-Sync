import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // bullmq and ioredis use native Node.js modules (net, tls, etc.) that cannot
  // be bundled by Turbopack/webpack.  Mark them as CJS externals so they are
  // required at runtime rather than inlined into the bundle.
  serverExternalPackages: ["bullmq", "ioredis"],
};

export default nextConfig;
