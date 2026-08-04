import type { Args } from "./args";

// Static token auth on /api/*. The SDK sends `Authorization: Bearer <token>`;
// some tooling passes `token` as a form arg instead — accept both, like Slack.

export const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

/** @returns a Slack error code ('not_authed' | 'invalid_auth') or null if ok. */
export function checkToken(req: Request, args: Args): string | null {
  const header = req.headers.get("authorization");
  let token: string | undefined;
  if (header && header.toLowerCase().startsWith("bearer ")) {
    token = header.slice(7).trim();
  } else if (typeof args.token === "string" && args.token) {
    token = args.token;
  }
  if (!token) return "not_authed";
  if (token !== SANDBOX_TOKEN) return "invalid_auth";
  return null;
}
