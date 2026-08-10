import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  validateAuthorize,
  isAuthorizeRequest,
  buildRedirect,
  type AuthorizeInput,
} from "@/lib/oauth/authorize";
import { issueAuthorizationCode } from "@/lib/oauth/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Where the consent screen posts. Allow → mint a single-use code and redirect
// back with code+state. Deny → redirect back with error=access_denied. Uses 303
// See Other so the POST turns into a GET on the redirect (correct for every
// client, not just browsers that treat 302 leniently). The request is
// re-validated here (a POST is the security boundary and could be forged).

export async function POST(req: Request): Promise<NextResponse> {
  const form = await req.formData();
  const get = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const input: AuthorizeInput = {
    response_type: get("response_type"),
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    scope: get("scope"),
    state: get("state"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
  };
  const decision = get("decision");

  const db = getDb();
  const result = validateAuthorize(db, input);

  if (!isAuthorizeRequest(result)) {
    if (result.kind === "redirectable") {
      return NextResponse.redirect(
        buildRedirect(result.redirectUri, {
          error: result.error,
          error_description: result.description,
          state: result.state,
        }),
        303,
      );
    }
    // Cannot trust the redirect target — refuse inline.
    return NextResponse.json({ error: "invalid_request", error_description: result.detail }, { status: 400 });
  }

  if (decision !== "allow") {
    return NextResponse.redirect(
      buildRedirect(result.redirectUri, { error: "access_denied", state: result.state }),
      303,
    );
  }

  const code = issueAuthorizationCode(db, {
    clientId: result.client.client_id,
    redirectUri: result.redirectUri,
    scope: result.scope,
    codeChallenge: result.codeChallenge,
    codeChallengeMethod: result.codeChallengeMethod,
  });

  return NextResponse.redirect(
    buildRedirect(result.redirectUri, { code, state: result.state }),
    303,
  );
}
