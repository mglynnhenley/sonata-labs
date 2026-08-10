import type { NextConfig } from "next";

// The UI service has ZERO database access. It is a plain Next app whose server
// routes (BFF + OAuth callback + control-plane proxies) call the API service
// over HTTP. No native modules, so nothing to keep external.
const nextConfig: NextConfig = {};

export default nextConfig;
