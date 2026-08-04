import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — keep it external so Next doesn't try to
  // bundle it. Required for it to load inside route handlers.
  serverExternalPackages: ["better-sqlite3"],
  // Shared design-system package ships TS/JSX source, not build output.
  transpilePackages: ["@sonata/ui"],
};

export default nextConfig;
