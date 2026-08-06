import type { Database } from "better-sqlite3";
import { getClient, redirectUris, type ClientRow } from "./store";
import { parseScopes, partitionScopes, serializeScopes } from "./scopes";

// Validation shared by the consent page (GET) and the decision route (POST).
// Both must run it: the page so it never renders consent for a bad request, the
// route because a POST is the real security boundary and could be forged.

export interface AuthorizeInput {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  scope?: string | null;
  state?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
}

export interface AuthorizeRequest {
  client: ClientRow;
  redirectUri: string;
  scope: string; // space-delimited, granted subset
  requestedScopes: string[];
  state?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

/** A request so broken we cannot trust the redirect_uri — must be shown inline. */
export interface FatalError {
  kind: "fatal";
  title: string;
  detail: string;
}

/** A valid-enough request to safely redirect the error back to the client. */
export interface RedirectableError {
  kind: "redirectable";
  redirectUri: string;
  state?: string;
  error: string; // OAuth error code
  description: string;
}

export type AuthorizeResult = AuthorizeRequest | FatalError | RedirectableError;

export function isAuthorizeRequest(r: AuthorizeResult): r is AuthorizeRequest {
  return !("kind" in r);
}

export function validateAuthorize(db: Database, input: AuthorizeInput): AuthorizeResult {
  const clientId = input.client_id?.trim();
  if (!clientId) return fatal("Missing client_id", "The authorization request did not name a client.");

  const client = getClient(db, clientId);
  if (!client) return fatal("Unknown client", `No client is registered with id "${clientId}".`);

  // redirect_uri: EXACT match against a registered URI. Never redirect to an
  // unregistered URI — that is the open-redirect that makes OAuth dangerous.
  const redirectUri = input.redirect_uri?.trim();
  const registered = redirectUris(client);
  if (!redirectUri || !registered.includes(redirectUri)) {
    return fatal(
      "Invalid redirect URI",
      "The redirect_uri does not exactly match a URI registered for this client.",
    );
  }

  // From here the redirect_uri is trusted, so protocol errors go back to it.
  const state = input.state?.trim() || undefined;

  if (input.response_type !== "code") {
    return redirectable(redirectUri, state, "unsupported_response_type", "Only response_type=code is supported.");
  }

  const challenge = input.code_challenge?.trim();
  const method = (input.code_challenge_method?.trim() || "").toUpperCase();
  if (!challenge) {
    return redirectable(redirectUri, state, "invalid_request", "PKCE code_challenge is required.");
  }
  if (method !== "S256") {
    return redirectable(redirectUri, state, "invalid_request", "code_challenge_method must be S256.");
  }

  const requestedScopes = parseScopes(input.scope);
  if (requestedScopes.length === 0) {
    return redirectable(redirectUri, state, "invalid_scope", "At least one scope is required.");
  }
  const { granted, unknown } = partitionScopes(requestedScopes);
  if (unknown.length > 0) {
    return redirectable(
      redirectUri,
      state,
      "invalid_scope",
      `Unsupported scope(s): ${unknown.join(", ")}.`,
    );
  }

  return {
    client,
    redirectUri,
    scope: serializeScopes(granted),
    requestedScopes: granted,
    state,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  };
}

function fatal(title: string, detail: string): FatalError {
  return { kind: "fatal", title, detail };
}

function redirectable(
  redirectUri: string,
  state: string | undefined,
  error: string,
  description: string,
): RedirectableError {
  return { kind: "redirectable", redirectUri, state, error, description };
}

/** Build a redirect URL back to the client, appending query params safely. */
export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}
