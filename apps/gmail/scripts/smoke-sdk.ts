// Acceptance harness: drive the sandbox with the OFFICIAL googleapis SDK, the
// same way a real agent would — only rootUrl is overridden. If this passes, an
// agent using googleapis works against the sandbox unchanged.
//
//   PORT=3100 npm run smoke          # part 1 (reads) + part 2 (writes)
//   PORT=3100 npm run smoke -- reads # part 1 only
//
// Requires the server to be running (npm start) on $PORT and a seeded mailbox.

import { google, type gmail_v1 } from "googleapis";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { b64urlDecodeToString } from "../src/lib/gmail/base64.js";
import { s256Challenge } from "../src/lib/oauth/pkce.js";
import {
  DEV_UI_CLIENT_ID,
  DEV_UI_CLIENT_SECRET,
  DEV_UI_REDIRECT_URI,
} from "../src/lib/oauth/clients.js";
import { GMAIL_SCOPE } from "../src/lib/oauth/scopes.js";

const OAuth2Client = google.auth.OAuth2;

const PORT = process.env.PORT || "3100";
const ROOT_URL = process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`;

// The scopes the smoke exercises — everything the read+write checks touch.
const ALL_SCOPES = [
  GMAIL_SCOPE.readonly,
  GMAIL_SCOPE.modify,
  GMAIL_SCOPE.labels,
  GMAIL_SCOPE.send,
  GMAIL_SCOPE.compose,
];

// Pass an OAuth2Client with setCredentials — a string `auth` becomes a `key=`
// query param, NOT a bearer header (a classic footgun the plan calls out).
const auth = new OAuth2Client();
const gmail = google.gmail({ version: "v1", auth, rootUrl: ROOT_URL });

// --- real OAuth2 handshake ---------------------------------------------------
// Drive the sandbox's own authorization server exactly as the UI (or any
// third-party client) would: PKCE authorize → consent Allow → code → token
// exchange. This is the strongest regression signal — it proves the SDK's
// OAuth2Client path works end-to-end against the twin.

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** POST a form without following redirects, so we can read the 302 Location. */
function postFormRaw(
  urlStr: string,
  form: Record<string, string>,
): Promise<{ status: number; location?: string; body: string }> {
  const body = new URLSearchParams(form).toString();
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Run the full authorization-code + PKCE flow; return an access token. */
async function handshake(scopes: string[]): Promise<string> {
  const verifier = b64url(randomBytes(32));
  const challenge = s256Challenge(verifier);
  const state = b64url(randomBytes(9));

  // 1. Consent decision (Allow) → 302 back to redirect_uri with code+state.
  const decision = await postFormRaw(`${ROOT_URL}/oauth/authorize/decision`, {
    client_id: DEV_UI_CLIENT_ID,
    redirect_uri: DEV_UI_REDIRECT_URI,
    scope: scopes.join(" "),
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    decision: "allow",
  });
  if (!decision.location) {
    throw new Error(`authorize decision did not redirect (${decision.status}): ${decision.body.slice(0, 200)}`);
  }
  const redirect = new URL(decision.location);
  const code = redirect.searchParams.get("code");
  if (redirect.searchParams.get("state") !== state) throw new Error("state mismatch on redirect");
  if (!code) throw new Error(`no code in redirect: ${decision.location}`);

  // 2. Exchange the code (with the PKCE verifier + client secret) for a token.
  const tokenRes = await fetch(`${ROOT_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: DEV_UI_REDIRECT_URI,
      client_id: DEV_UI_CLIENT_ID,
      client_secret: DEV_UI_CLIENT_SECRET,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`);
  const tok = (await tokenRes.json()) as { access_token?: string };
  if (!tok.access_token) throw new Error("token response missing access_token");
  return tok.access_token;
}

/** Handshake for the given scopes and point the shared SDK client at the token. */
async function authorize(scopes: string[]): Promise<string> {
  const token = await handshake(scopes);
  auth.setCredentials({ access_token: token });
  return token;
}

/**
 * Cancel on the consent screen. The client must be sent back to its redirect_uri
 * carrying `error=access_denied` and its `state` — never a code, and never an
 * inline error page, because a client that cannot distinguish "the user said no"
 * from "the server broke" cannot recover.
 */
async function partConsentDenial(): Promise<void> {
  console.log("\n\x1b[1mConsent denial\x1b[0m");
  const state = b64url(randomBytes(9));
  const res = await postFormRaw(`${ROOT_URL}/oauth/authorize/decision`, {
    client_id: DEV_UI_CLIENT_ID,
    redirect_uri: DEV_UI_REDIRECT_URI,
    scope: GMAIL_SCOPE.readonly,
    response_type: "code",
    code_challenge: s256Challenge(b64url(randomBytes(32))),
    code_challenge_method: "S256",
    state,
    decision: "deny",
  });

  check("Deny redirects rather than erroring inline", !!res.location, {
    status: res.status,
    body: res.body.slice(0, 120),
  });
  if (!res.location) return;
  const back = new URL(res.location);
  check("Deny returns error=access_denied", back.searchParams.get("error") === "access_denied", {
    got: back.searchParams.get("error"),
  });
  check("Deny echoes state, so the client can match the request", back.searchParams.get("state") === state);
  check("Deny issues no authorization code", back.searchParams.get("code") === null);
  check(
    "Deny lands on the registered redirect_uri",
    `${back.origin}${back.pathname}` === DEV_UI_REDIRECT_URI,
    { got: `${back.origin}${back.pathname}` },
  );
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log("      detail:", JSON.stringify(detail)?.slice(0, 300));
  }
}
async function expectError(name: string, fn: () => Promise<unknown>, code: number) {
  try {
    await fn();
    check(name, false, "expected an error but call succeeded");
  } catch (e) {
    const status = (e as { response?: { status?: number }; code?: number }).response?.status ??
      (e as { code?: number }).code;
    check(name, status === code, { got: status, want: code });
  }
}

function findData(payload: gmail_v1.Schema$MessagePart | undefined): string | undefined {
  if (!payload) return undefined;
  if (payload.body?.data) return payload.body.data;
  for (const p of payload.parts ?? []) {
    const d = findData(p);
    if (d) return d;
  }
  return undefined;
}

async function part1Reads(): Promise<void> {
  console.log("\n\x1b[1mPart 1 — Reads (official SDK + rootUrl override)\x1b[0m");

  // profile
  const profile = await gmail.users.getProfile({ userId: "me" });
  check("getProfile returns emailAddress", !!profile.data.emailAddress, profile.data);
  check("getProfile messagesTotal > 0", (profile.data.messagesTotal ?? 0) > 0);

  // labels.list omits counts; labels.get includes them
  const labels = await gmail.users.labels.list({ userId: "me" });
  const labelList = labels.data.labels ?? [];
  check("labels.list returns labels", labelList.length > 0);
  check(
    "labels.list omits counts",
    labelList.every((l) => l.messagesTotal === undefined),
  );
  const inbox = await gmail.users.labels.get({ userId: "me", id: "INBOX" });
  check("labels.get INBOX includes messagesTotal", inbox.data.messagesTotal !== undefined, inbox.data);
  check("labels.get INBOX includes threadsUnread", inbox.data.threadsUnread !== undefined);

  // messages.list — items are {id, threadId} ONLY
  const list = await gmail.users.messages.list({ userId: "me", labelIds: ["INBOX"], maxResults: 3 });
  const items = list.data.messages ?? [];
  check("messages.list returns items", items.length > 0);
  check(
    "messages.list items are {id, threadId} only",
    items.every((m) => m.id && m.threadId && Object.keys(m).length === 2),
    items[0],
  );
  check("messages.list has nextPageToken (more than 3 in inbox)", !!list.data.nextPageToken);

  // pagination across 2 pages, no overlap
  const page2 = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults: 3,
    pageToken: list.data.nextPageToken!,
  });
  const ids1 = new Set(items.map((m) => m.id));
  const overlap = (page2.data.messages ?? []).some((m) => ids1.has(m.id!));
  check("pagination page 2 does not overlap page 1", !overlap);

  // messages.get full — payload present, body.data decodes as base64url
  const firstId = items[0].id!;
  const full = await gmail.users.messages.get({ userId: "me", id: firstId, format: "full" });
  check("messages.get full has payload", !!full.data.payload, Object.keys(full.data));
  check("messages.get full has labelIds", (full.data.labelIds ?? []).includes("INBOX"));
  const data = findData(full.data.payload);
  check("messages.get full body.data present", !!data);
  if (data) {
    const decoded = b64urlDecodeToString(data);
    check("body.data decodes as base64url to non-empty text", decoded.length > 0, decoded.slice(0, 60));
  }

  // metadata — headers present, no body.data
  const meta = await gmail.users.messages.get({ userId: "me", id: firstId, format: "metadata" });
  check("messages.get metadata has header list", (meta.data.payload?.headers ?? []).length > 0);
  check("messages.get metadata strips body.data", !findData(meta.data.payload));

  // minimal — no payload
  const min = await gmail.users.messages.get({ userId: "me", id: firstId, format: "minimal" });
  check("messages.get minimal omits payload", !min.data.payload);
  check("messages.get minimal keeps snippet", min.data.snippet !== undefined);

  // threads
  const threads = await gmail.users.threads.list({ userId: "me", labelIds: ["INBOX"], maxResults: 5 });
  check("threads.list returns threads", (threads.data.threads ?? []).length > 0);
  const tid = threads.data.threads![0].id!;
  const thread = await gmail.users.threads.get({ userId: "me", id: tid });
  check("threads.get returns messages", (thread.data.messages ?? []).length > 0);
  check(
    "threads.get messages all share threadId",
    (thread.data.messages ?? []).every((m) => m.threadId === tid),
  );

  // negative tests
  await expectError("bad token → 401", async () => {
    const bad = new OAuth2Client();
    bad.setCredentials({ access_token: "wrong" });
    const g2 = google.gmail({ version: "v1", auth: bad, rootUrl: ROOT_URL });
    await g2.users.getProfile({ userId: "me" });
  }, 401);
  await expectError("missing message → 404", () =>
    gmail.users.messages.get({ userId: "me", id: "deadbeefdeadbeef" }), 404);
  await expectError("raw on synced message → 400", () =>
    gmail.users.messages.get({ userId: "me", id: firstId, format: "raw" }), 400);
}

// Per-route scope enforcement: a token that lacks a scope is refused with
// Google's 403, even though it is a perfectly valid token.
async function partScopeDenial(): Promise<void> {
  console.log("\n\x1b[1mScope enforcement (per-route)\x1b[0m");
  const readonlyToken = await handshake([GMAIL_SCOPE.readonly]);
  check("readonly handshake issues a token", !!readonlyToken);
  const ro = new OAuth2Client();
  ro.setCredentials({ access_token: readonlyToken });
  const roGmail = google.gmail({ version: "v1", auth: ro, rootUrl: ROOT_URL });

  const prof = await roGmail.users.getProfile({ userId: "me" });
  check("readonly token can read (getProfile)", !!prof.data.emailAddress);

  await expectError("readonly token cannot create a label → 403", () =>
    roGmail.users.labels.create({ userId: "me", requestBody: { name: `Denied ${Date.now()}` } }), 403);
  await expectError("readonly token cannot send → 403", () =>
    roGmail.users.messages.send({ userId: "me", requestBody: { raw: "" } }), 403);
}

async function main() {
  const mode = process.argv[2] || "all";
  // Establish a session through the real OAuth flow before any API call.
  const token = await authorize(ALL_SCOPES);
  check("OAuth handshake yields an access token", !!token);
  await part1Reads();
  if (mode !== "reads") {
    try {
      const { part2Writes } = await import("./smoke-sdk-writes.js");
      // part2 resets the sandbox mid-run, which wipes OAuth tokens; `reauth`
      // lets it re-establish a session the way a client would on a 401.
      await part2Writes({ gmail, check, expectError, reauth: () => authorize(ALL_SCOPES) });
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        console.log("\n  (part 2 writes not yet implemented — skipping)");
      } else {
        throw e;
      }
    }
    await partScopeDenial();
    await partConsentDenial();
  }
  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Smoke harness crashed:", e);
  process.exit(2);
});
