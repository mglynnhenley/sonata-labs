import { allowedDevelopmentOrigins } from "@sonata/core/browserOrigin";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: allowedDevelopmentOrigins(),
  // better-sqlite3 is a native module — keep it external so Next doesn't try to
  // bundle it. Required for it to load inside route handlers.
  serverExternalPackages: ["better-sqlite3"],
  // The dev build indicator floats over the sidebar footer, which breaks the
  // side-by-side screenshot comparison against real Slack.
  devIndicators: false,
};

export default nextConfig;
