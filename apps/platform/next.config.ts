import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The design system and the contracts ship as TypeScript source (no build
  // step), and @sonata/ui calls next/font — which only runs through Next's own
  // compiler. Both facts make transpiling them here mandatory, not optional.
  transpilePackages: ["@sonata/ui", "@sonata/core"],
  // better-sqlite3 is a native module; bundling it breaks the route handlers.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
