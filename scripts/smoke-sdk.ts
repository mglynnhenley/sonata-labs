// Acceptance harness: drive the sandbox with the OFFICIAL googleapis SDK, the
// same way a real agent would — only rootUrl is overridden. If this passes, an
// agent using googleapis works against the sandbox unchanged.
//
//   PORT=3100 npm run smoke          # part 1 (reads) + part 2 (writes)
//   PORT=3100 npm run smoke -- reads # part 1 only
//
// Requires the server to be running (npm start) on $PORT and a seeded mailbox.

import { google, type gmail_v1 } from "googleapis";
import { b64urlDecodeToString } from "../src/lib/gmail/base64.js";

const OAuth2Client = google.auth.OAuth2;

const PORT = process.env.PORT || "3100";
const ROOT_URL = process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`;
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

// Pass an OAuth2Client with setCredentials — a string `auth` becomes a `key=`
// query param, NOT a bearer header (a classic footgun the plan calls out).
const auth = new OAuth2Client();
auth.setCredentials({ access_token: TOKEN });

const gmail = google.gmail({ version: "v1", auth, rootUrl: ROOT_URL });

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

async function main() {
  const mode = process.argv[2] || "all";
  await part1Reads();
  if (mode !== "reads") {
    try {
      const { part2Writes } = await import("./smoke-sdk-writes.js");
      await part2Writes({ gmail, check, expectError });
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        console.log("\n  (part 2 writes not yet implemented — skipping)");
      } else {
        throw e;
      }
    }
  }
  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Smoke harness crashed:", e);
  process.exit(2);
});
