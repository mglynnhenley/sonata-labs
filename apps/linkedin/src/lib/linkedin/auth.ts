import type { NextResponse } from "next/server";
import { emptyToken, errorResponse, invalidToken, versionDeprecated } from "./errors";

// The provider gate and the two Rest.li header gates, in one file.
//
// Static bearer token auth for /v2/* and /rest/*. The sandbox is not protecting
// real data — it exists so a caller's OAuth path works unchanged, since what
// arrives on the wire from a real LinkedIn client is an `Authorization: Bearer`
// header either way. Configure via SANDBOX_TOKEN; defaults to a dev token.
export const SANDBOX_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

/**
 * The oldest LinkedIn-Version this clone answers. LinkedIn sunsets versions on
 * a rolling one-year window, so pinning a floor is faithful; pinning a floor
 * that LinkedIn has already retired would teach an agent a header that 426s
 * against the real API, which is why this tracks a currently-supported moniker
 * rather than the one the clone was written against.
 */
export const MIN_LINKEDIN_VERSION = 202506;

function bearerToken(req: Request): string | undefined {
  const header = req.headers.get("authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  return new URL(req.url).searchParams.get("access_token") || undefined;
}

/**
 * Returns null if authorized, or a 401 to return as-is. The two failures are
 * deliberately different responses: an agent distinguishes "I forgot the
 * header" from "my token is wrong" on exactly that, and retries differently.
 */
export function checkAuth(req: Request): NextResponse | null {
  const token = bearerToken(req);
  if (token === undefined) return emptyToken();
  return token === SANDBOX_TOKEN ? null : invalidToken();
}

/**
 * `LinkedIn-Version: YYYYMM`, required on every /rest/* call. The format is
 * documented as six digits and nothing else, so the check is exactly that.
 * These two messages are the clone's own — LinkedIn does not publish them
 * verbatim — and AGENTS.md says so.
 */
export function checkVersionHeader(req: Request): NextResponse | null {
  const raw = req.headers.get("linkedin-version");
  if (!raw) {
    return errorResponse(
      400,
      "A LinkedIn-Version header in the format YYYYMM is required for /rest/ requests.",
      "MISSING_VERSION",
    );
  }
  if (!/^\d{6}$/.test(raw)) {
    return errorResponse(400, `LinkedIn-Version ${raw} is not in the format YYYYMM.`, "INVALID_VERSION");
  }
  return Number(raw) < MIN_LINKEDIN_VERSION ? versionDeprecated(raw) : null;
}

/**
 * An ABSENT `X-Restli-Protocol-Version` is accepted. LinkedIn's own docs do
 * require it on the finders this clone ships, so this is a deliberate leniency
 * for the hand-written curl case: nothing here encodes differently under
 * Rest.li 1.0, so the omission changes no answer. A PRESENT value other than
 * 2.0.0 is a 400 — that caller believes they are speaking a protocol whose
 * responses would be shaped differently, and silently agreeing is how they end
 * up parsing the wrong thing.
 */
export function checkProtocolHeader(req: Request): NextResponse | null {
  const raw = req.headers.get("x-restli-protocol-version");
  if (raw === null || raw === "2.0.0") return null;
  return errorResponse(
    400,
    `X-Restli-Protocol-Version ${raw} is not supported; this API speaks 2.0.0.`,
    "INVALID_PROTOCOL_VERSION",
  );
}
