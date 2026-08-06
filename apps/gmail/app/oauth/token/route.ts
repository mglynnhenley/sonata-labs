import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  grantAuthorizationCode,
  grantRefreshToken,
  type GrantResult,
} from "@/lib/oauth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The OAuth2 token endpoint. Accepts form-encoded bodies — what googleapis'
// OAuth2Client actually POSTs. Supports the authorization_code and refresh_token
// grants; returns Google-shaped token JSON (or an {error, error_description}).

export async function POST(req: Request): Promise<NextResponse> {
  const form = await parseBody(req);
  const get = (k: string) => form.get(k) ?? undefined;

  // Client credentials may arrive in the body (googleapis) or HTTP Basic.
  const basic = parseBasicAuth(req.headers.get("authorization"));
  const clientId = get("client_id") ?? basic?.clientId;
  const clientSecret = get("client_secret") ?? basic?.clientSecret;
  const grantType = get("grant_type");

  if (!clientId) return oauthError("invalid_request", "Missing client_id.", 400);

  let result: GrantResult;
  if (grantType === "authorization_code") {
    result = grantAuthorizationCode(getDb(), {
      code: get("code") ?? "",
      redirectUri: get("redirect_uri") ?? "",
      clientId,
      clientSecret,
      codeVerifier: get("code_verifier"),
    });
  } else if (grantType === "refresh_token") {
    result = grantRefreshToken(getDb(), {
      refreshToken: get("refresh_token") ?? "",
      clientId,
      clientSecret,
      scope: get("scope"),
    });
  } else {
    return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType ?? "(none)"}.`, 400);
  }

  if (!result.ok) return oauthError(result.error, result.description, result.status);

  const g = result.grant;
  const body: Record<string, unknown> = {
    access_token: g.access_token,
    expires_in: g.expires_in,
    scope: g.scope,
    token_type: g.token_type,
  };
  if (g.refresh_token) body.refresh_token = g.refresh_token;
  return NextResponse.json(body, {
    status: 200,
    // OAuth2 §5.1: token responses must not be cached.
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}

async function parseBody(req: Request): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const json = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    for (const [k, v] of Object.entries(json)) if (v != null) map.set(k, String(v));
  } else {
    // Default: form-encoded (also handles multipart via formData()).
    const form = await req.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) if (typeof v === "string") map.set(k, v);
  }
  return map;
}

function parseBasicAuth(header: string | null): { clientId: string; clientSecret: string } | null {
  const m = header?.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  try {
    const [clientId, clientSecret] = Buffer.from(m[1], "base64").toString("utf8").split(":");
    if (clientId) return { clientId, clientSecret: clientSecret ?? "" };
  } catch {
    /* fall through */
  }
  return null;
}

function oauthError(error: string, description: string, status: number): NextResponse {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}
