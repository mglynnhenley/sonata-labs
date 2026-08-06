import type { Database } from "better-sqlite3";

// Data access for the OAuth tables. Pure row-level reads/writes — policy
// (expiry, single-use, PKCE, scope) lives in service.ts. Kept separate so the
// unit tests can exercise the store against an in-memory DB.

export interface ClientRow {
  client_id: string;
  client_secret: string | null;
  name: string;
  redirect_uris: string; // JSON array
  confidential: number;
  created_at: number;
}

export interface AuthCodeRow {
  code: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: number;
  used_at: number | null;
}

export interface TokenRow {
  access_token: string;
  refresh_token: string | null;
  client_id: string;
  scope: string;
  access_token_expires_at: number;
  refresh_token_expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

// --- clients -----------------------------------------------------------------

export function getClient(db: Database, clientId: string): ClientRow | undefined {
  return db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as
    | ClientRow
    | undefined;
}

export function insertClient(db: Database, row: ClientRow): void {
  db.prepare(
    `INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, confidential, created_at)
     VALUES (@client_id, @client_secret, @name, @redirect_uris, @confidential, @created_at)`,
  ).run(row);
}

/** Idempotent seed — used for the well-known dev client (survives reset). */
export function upsertClient(db: Database, row: ClientRow): void {
  db.prepare(
    `INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uris, confidential, created_at)
     VALUES (@client_id, @client_secret, @name, @redirect_uris, @confidential, @created_at)
     ON CONFLICT(client_id) DO UPDATE SET
       client_secret = excluded.client_secret,
       name          = excluded.name,
       redirect_uris = excluded.redirect_uris,
       confidential  = excluded.confidential`,
  ).run(row);
}

export function redirectUris(client: ClientRow): string[] {
  try {
    const parsed = JSON.parse(client.redirect_uris);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- authorization codes -----------------------------------------------------

export function insertAuthCode(db: Database, row: AuthCodeRow): void {
  db.prepare(
    `INSERT INTO oauth_authorization_codes
       (code, client_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at, used_at)
     VALUES (@code, @client_id, @redirect_uri, @scope, @code_challenge, @code_challenge_method, @expires_at, @used_at)`,
  ).run(row);
}

export function getAuthCode(db: Database, code: string): AuthCodeRow | undefined {
  return db.prepare("SELECT * FROM oauth_authorization_codes WHERE code = ?").get(code) as
    | AuthCodeRow
    | undefined;
}

/** Mark a code used. Returns true if THIS call was the one that consumed it —
 *  the `used_at IS NULL` guard makes redemption atomic against a concurrent reuse. */
export function markAuthCodeUsed(db: Database, code: string, at: number): boolean {
  const res = db
    .prepare("UPDATE oauth_authorization_codes SET used_at = ? WHERE code = ? AND used_at IS NULL")
    .run(at, code);
  return res.changes === 1;
}

// --- tokens ------------------------------------------------------------------

export function insertToken(db: Database, row: TokenRow): void {
  db.prepare(
    `INSERT INTO oauth_tokens
       (access_token, refresh_token, client_id, scope, access_token_expires_at, refresh_token_expires_at, revoked_at, created_at)
     VALUES (@access_token, @refresh_token, @client_id, @scope, @access_token_expires_at, @refresh_token_expires_at, @revoked_at, @created_at)`,
  ).run(row);
}

export function getTokenByAccess(db: Database, accessToken: string): TokenRow | undefined {
  return db.prepare("SELECT * FROM oauth_tokens WHERE access_token = ?").get(accessToken) as
    | TokenRow
    | undefined;
}

export function getTokenByRefresh(db: Database, refreshToken: string): TokenRow | undefined {
  return db.prepare("SELECT * FROM oauth_tokens WHERE refresh_token = ?").get(refreshToken) as
    | TokenRow
    | undefined;
}

export function revokeToken(db: Database, accessToken: string, at: number): void {
  db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE access_token = ?").run(at, accessToken);
}
