import { NextResponse } from "next/server";
import { requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { getDb } from "@/lib/db";
import { mintToken } from "@/lib/oauth/service";
import { HARNESS_CLIENT_ID } from "@/lib/oauth/clients";
import { GMAIL_SCOPE } from "@/lib/oauth/scopes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-gated OAuth token mint — the bridge that keeps the benchmark harness
// working after the provider API moved behind OAuth. The harness is an operator,
// not an agent: making it click through a consent screen would be ceremony with
// no fidelity payoff. It presents the admin token (like the rest of
// /api/sandbox/*) and receives a real access token for the requested scopes.
//
// Also the ergonomic answer for agent developers who want a token without the
// interactive flow — the consent screen exists for realism, this for ergonomics.
export async function POST(req: Request): Promise<NextResponse> {
  const authErr = requireSandboxToken(req);
  if (authErr) return authErr;
  try {
    const body = (await req.json().catch(() => ({}))) as { scope?: string | string[] };
    const scope = Array.isArray(body.scope)
      ? body.scope.join(" ")
      : body.scope || GMAIL_SCOPE.full; // default: full mailbox access, satisfies every route
    const grant = mintToken(getDb(), { clientId: HARNESS_CLIENT_ID, scope });
    return NextResponse.json({
      access_token: grant.access_token,
      refresh_token: grant.refresh_token,
      scope: grant.scope,
      expires_in: grant.expires_in,
      token_type: grant.token_type,
    });
  } catch (err) {
    return sandboxError(err);
  }
}
