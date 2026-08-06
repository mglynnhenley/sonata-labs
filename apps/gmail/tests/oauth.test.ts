import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setMeta } from "@/lib/store/meta";
import { insertClient, getTokenByAccess, type ClientRow } from "@/lib/oauth/store";
import {
  issueAuthorizationCode,
  grantAuthorizationCode,
  grantRefreshToken,
  validateAccessToken,
  mintToken,
  ACCESS_TTL_MS,
  CODE_TTL_MS,
} from "@/lib/oauth/service";
import { validateAuthorize, isAuthorizeRequest } from "@/lib/oauth/authorize";
import { s256Challenge, verifyPkce, isValidCodeVerifier } from "@/lib/oauth/pkce";
import { hasScope, parseScopes, partitionScopes, GMAIL_SCOPE } from "@/lib/oauth/scopes";
import { revokeToken } from "@/lib/oauth/store";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const REDIRECT = "http://localhost:9999/cb";
const VERIFIER = "a".repeat(64); // valid unreserved verifier
const CHALLENGE = s256Challenge(VERIFIER);
const T0 = 1_000_000; // fixed base time for deterministic expiry

function makeDb(client: Partial<ClientRow> = {}): Database.Database {
  const db = new Database(":memory:");
  db.exec(schema);
  setMeta(db, "profile_email", "test@sandbox.local");
  insertClient(db, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    name: "Test Client",
    redirect_uris: JSON.stringify([REDIRECT]),
    confidential: 1,
    created_at: T0,
    ...client,
  });
  return db;
}

/** Issue a code for the standard test client. */
function issue(db: Database.Database, scope: string = GMAIL_SCOPE.modify, now = T0): string {
  return issueAuthorizationCode(db, {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    scope,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    now,
  });
}

describe("PKCE", () => {
  it("S256 challenge verifies against its verifier", () => {
    expect(verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
  });
  it("rejects a mismatched verifier", () => {
    expect(verifyPkce("b".repeat(64), CHALLENGE)).toBe(false);
  });
  it("validates verifier length/charset per RFC 7636", () => {
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("has spaces and !")).toBe(false);
  });
});

describe("scopes", () => {
  it("modify satisfies readonly/labels/send/compose (Google hierarchy)", () => {
    const g = GMAIL_SCOPE.modify;
    expect(hasScope(g, GMAIL_SCOPE.readonly)).toBe(true);
    expect(hasScope(g, GMAIL_SCOPE.labels)).toBe(true);
    expect(hasScope(g, GMAIL_SCOPE.send)).toBe(true);
    expect(hasScope(g, GMAIL_SCOPE.compose)).toBe(true);
    expect(hasScope(g, GMAIL_SCOPE.modify)).toBe(true);
  });
  it("readonly does NOT satisfy write scopes", () => {
    const g = GMAIL_SCOPE.readonly;
    expect(hasScope(g, GMAIL_SCOPE.send)).toBe(false);
    expect(hasScope(g, GMAIL_SCOPE.labels)).toBe(false);
    expect(hasScope(g, GMAIL_SCOPE.modify)).toBe(false);
    expect(hasScope(g, GMAIL_SCOPE.readonly)).toBe(true);
  });
  it("the full mail scope satisfies everything", () => {
    for (const s of Object.values(GMAIL_SCOPE)) expect(hasScope(GMAIL_SCOPE.full, s)).toBe(true);
  });
  it("partitions known vs unknown scopes", () => {
    const { granted, unknown } = partitionScopes([GMAIL_SCOPE.readonly, "https://evil/scope"]);
    expect(granted).toEqual([GMAIL_SCOPE.readonly]);
    expect(unknown).toEqual(["https://evil/scope"]);
  });
  it("parseScopes de-dupes and splits on whitespace", () => {
    expect(parseScopes("a  b a")).toEqual(["a", "b"]);
  });
});

describe("authorization code grant", () => {
  let db: Database.Database;
  beforeEach(() => (db = makeDb()));

  it("exchanges a valid code for an access + refresh token", () => {
    const code = issue(db);
    const res = grantAuthorizationCode(db, {
      code,
      redirectUri: REDIRECT,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      codeVerifier: VERIFIER,
      now: T0,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.grant.access_token).toBeTruthy();
    expect(res.grant.refresh_token).toBeTruthy();
    expect(res.grant.scope).toBe(GMAIL_SCOPE.modify);
    expect(res.grant.token_type).toBe("Bearer");
  });

  it("rejects a reused code (single-use)", () => {
    const code = issue(db);
    const first = grantAuthorizationCode(db, base(code));
    expect(first.ok).toBe(true);
    const second = grantAuthorizationCode(db, base(code));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("invalid_grant");
  });

  it("rejects an expired code", () => {
    const code = issue(db, GMAIL_SCOPE.modify, T0);
    const res = grantAuthorizationCode(db, { ...base(code), now: T0 + CODE_TTL_MS + 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_grant");
  });

  it("rejects a mismatched redirect_uri", () => {
    const code = issue(db);
    const res = grantAuthorizationCode(db, { ...base(code), redirectUri: "http://localhost:9999/other" });
    expect(res.ok).toBe(false);
  });

  it("rejects a wrong client secret", () => {
    const code = issue(db);
    const res = grantAuthorizationCode(db, { ...base(code), clientSecret: "nope" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_client");
  });

  it("rejects a bad PKCE verifier", () => {
    const code = issue(db);
    const res = grantAuthorizationCode(db, { ...base(code), codeVerifier: "b".repeat(64) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_grant");
  });

  it("requires a PKCE verifier", () => {
    const code = issue(db);
    const res = grantAuthorizationCode(db, { ...base(code), codeVerifier: undefined });
    expect(res.ok).toBe(false);
  });

  function base(code: string) {
    return {
      code,
      redirectUri: REDIRECT,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      codeVerifier: VERIFIER,
      now: T0,
    };
  }
});

describe("refresh grant", () => {
  let db: Database.Database;
  let refresh: string;
  beforeEach(() => {
    db = makeDb();
    const code = issue(db, `${GMAIL_SCOPE.modify} ${GMAIL_SCOPE.readonly}`);
    const res = grantAuthorizationCode(db, {
      code,
      redirectUri: REDIRECT,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      codeVerifier: VERIFIER,
      now: T0,
    });
    if (!res.ok) throw new Error("setup failed");
    refresh = res.grant.refresh_token!;
  });

  it("mints a fresh access token from a refresh token", () => {
    const res = grantRefreshToken(db, { refreshToken: refresh, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now: T0 + 5 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.grant.refresh_token).toBe(refresh); // refresh token is not rotated
  });

  it("allows scope narrowing but not widening", () => {
    const narrow = grantRefreshToken(db, { refreshToken: refresh, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scope: GMAIL_SCOPE.readonly, now: T0 });
    expect(narrow.ok).toBe(true);
    const widen = grantRefreshToken(db, { refreshToken: refresh, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scope: GMAIL_SCOPE.full, now: T0 });
    expect(widen.ok).toBe(false);
    if (!widen.ok) expect(widen.error).toBe("invalid_scope");
  });

  it("rejects a revoked/unknown refresh token", () => {
    const res = grantRefreshToken(db, { refreshToken: "nope", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, now: T0 });
    expect(res.ok).toBe(false);
  });
});

describe("access token validation", () => {
  let db: Database.Database;
  beforeEach(() => (db = makeDb()));

  it("accepts a live token and rejects expiry/revocation/unknown", () => {
    const grant = mintToken(db, { clientId: CLIENT_ID, scope: GMAIL_SCOPE.modify, now: T0 });
    const at = grant.access_token;

    expect(validateAccessToken(db, at, T0).ok).toBe(true);
    expect(validateAccessToken(db, undefined, T0)).toMatchObject({ ok: false, reason: "missing" });
    expect(validateAccessToken(db, "unknown", T0)).toMatchObject({ ok: false, reason: "unknown" });
    expect(validateAccessToken(db, at, T0 + ACCESS_TTL_MS + 1)).toMatchObject({ ok: false, reason: "expired" });

    revokeToken(db, at, T0 + 1);
    expect(validateAccessToken(db, at, T0 + 2)).toMatchObject({ ok: false, reason: "revoked" });
    // sanity: the row exists (revocation, not deletion)
    expect(getTokenByAccess(db, at)).toBeTruthy();
  });
});

describe("authorize request validation", () => {
  let db: Database.Database;
  beforeEach(() => (db = makeDb()));

  const valid = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: GMAIL_SCOPE.modify,
    state: "xyz",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  };

  it("accepts a well-formed request", () => {
    const r = validateAuthorize(db, valid);
    expect(isAuthorizeRequest(r)).toBe(true);
  });

  it("is fatal (never redirects) for an unknown client", () => {
    const r = validateAuthorize(db, { ...valid, client_id: "ghost" });
    expect(isAuthorizeRequest(r)).toBe(false);
    if (!isAuthorizeRequest(r)) expect(r.kind).toBe("fatal");
  });

  it("is fatal for a redirect_uri that is not an exact match (open-redirect guard)", () => {
    const r = validateAuthorize(db, { ...valid, redirect_uri: REDIRECT + "/../evil" });
    expect(isAuthorizeRequest(r)).toBe(false);
    if (!isAuthorizeRequest(r)) expect(r.kind).toBe("fatal");
  });

  it("redirects protocol errors back (bad response_type, missing PKCE, unknown scope)", () => {
    for (const bad of [
      { ...valid, response_type: "token" },
      { ...valid, code_challenge: undefined },
      { ...valid, code_challenge_method: "plain" },
      { ...valid, scope: "https://evil/scope" },
    ]) {
      const r = validateAuthorize(db, bad);
      expect(isAuthorizeRequest(r)).toBe(false);
      if (!isAuthorizeRequest(r)) expect(r.kind).toBe("redirectable");
    }
  });
});
