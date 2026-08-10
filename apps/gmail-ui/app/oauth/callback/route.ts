import { NextResponse } from "next/server";
import {
  API_URL,
  UI_CLIENT_ID,
  UI_CLIENT_SECRET,
  UI_REDIRECT_URI,
} from "@/lib/oauth-config";
import { setSession, takeFlow, safeNextPath } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The redirect target of the OAuth flow. Verifies the state, exchanges the code
// for tokens SERVER-SIDE (client_secret + code_verifier never touch the browser),
// and seals the token pair into an HttpOnly cookie. No sessions table needed.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const params = url.searchParams;
  const flow = await takeFlow();

  const error = params.get("error");
  if (error) return fail(url.origin, `Authorization was ${error}.`);
  if (!flow) return fail(url.origin, "No in-flight authorization request (the login link expired).");

  const state = params.get("state");
  if (!state || state !== flow.state) return fail(url.origin, "State mismatch — possible CSRF, request rejected.");

  const code = params.get("code");
  if (!code) return fail(url.origin, "Authorization response had no code.");

  const res = await fetch(`${API_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: UI_REDIRECT_URI,
      client_id: UI_CLIENT_ID,
      client_secret: UI_CLIENT_SECRET,
      code_verifier: flow.verifier,
    }).toString(),
  });
  if (!res.ok) return fail(url.origin, `Token exchange failed (${res.status}).`);

  const tok = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    scope?: string;
    expires_in?: number;
  };
  await setSession({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    scope: tok.scope ?? "",
    expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
  });

  // Re-validate on the way out: the cookie is sealed, but the destination is
  // still user-supplied input and this is the redirect that actually fires.
  return NextResponse.redirect(new URL(safeNextPath(flow.next) ?? "/", url.origin), 302);
}

function fail(origin: string, message: string): NextResponse {
  const to = new URL("/signed-out", origin);
  to.searchParams.set("reason", message);
  return NextResponse.redirect(to, 302);
}
