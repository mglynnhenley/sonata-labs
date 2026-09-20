/** Match the browser-facing origin, which can differ from the app's internal proxy URL. */
export function allowedBrowserOrigin(
  req: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  try {
    // Only trusted configuration changes this boundary; forwarded Host headers do not.
    const expected = new URL(env.SANDBOX_PUBLIC_URL || req.url);
    if (expected.protocol !== "http:" && expected.protocol !== "https:") return false;
    return !origin || origin === expected.origin;
  } catch {
    return false;
  }
}

/** Next dev also checks browser asset origins; grant only the configured public hostname. */
export function allowedDevelopmentOrigins(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  if (!env.SANDBOX_PUBLIC_URL) return [];
  try {
    const url = new URL(env.SANDBOX_PUBLIC_URL);
    if (!["http:", "https:"].includes(url.protocol) || url.hostname.includes("*")) return [];
    return [url.hostname];
  } catch {
    return [];
  }
}
