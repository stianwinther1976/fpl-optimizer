import type { NextConfig } from "next";

// Baked into the client bundle at build time; compared against /api/version
// (which always answers from the newest deployment) to detect stale pages.
const buildId =
  process.env.VERCEL_GIT_COMMIT_SHA ?? `dev-${Math.floor(Date.now() / 1000)}`;

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
};

export default nextConfig;
