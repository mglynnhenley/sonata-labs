import { NextResponse } from "next/server";
import {
  API_URL,
  UI_CLIENT_ID,
  UI_REDIRECT_URI,
  UI_SCOPES,
} from "@/lib/oauth-config";
import { randomUrlSafe, s256Challenge } from "@/lib/pkce";
import { setFlow } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start the authorization-code flow. Generate PKCE + state, stash them in a
// short-lived HttpOnly cookie, and redirect the browser to the API's consent
// screen. The client_secret and code_verifier never leave the server.
export async function GET() {
  const verifier = randomUrlSafe(32);
  const state = randomUrlSafe(16);
  await setFlow({ state, verifier });

  const authorize = new URL(`${API_URL}/oauth/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", UI_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", UI_REDIRECT_URI);
  authorize.searchParams.set("scope", UI_SCOPES.join(" "));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", s256Challenge(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");

  return NextResponse.redirect(authorize.toString(), 302);
}
