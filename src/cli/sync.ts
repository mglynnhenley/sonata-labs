// Sync real Gmail into snapshot.db (READ-ONLY). Nothing is ever written back to
// Google.
//
//   npm run sync -- --query "newer_than:90d" --max 1000
//   npm run sync -- --attachment-cap 2 --attachment-budget 100   (MB)
//
// Idempotent: re-running rebuilds snapshot.db from scratch for the given query,
// then copies it to working.db. Run `npm run reset` any time to restore working.

import Database from "better-sqlite3";
import { copyFileSync, rmSync } from "node:fs";
import { google, type gmail_v1 } from "googleapis";
import {
  ensureDataDir,
  readSchema,
  SNAPSHOT_PATH,
  WORKING_PATH,
} from "../lib/db.js";
import { setMeta } from "../lib/store/meta.js";
import { insertMessage } from "../lib/store/messages.js";
import { insertAttachment } from "../lib/store/attachments.js";
import { messageToRow } from "../lib/sync/transform.js";
import { b64urlDecode } from "../lib/gmail/base64.js";
import { authorize } from "./google-auth.js";

interface Args {
  query: string;
  max: number;
  attachmentCap: number; // bytes
  attachmentBudget: number; // bytes
  concurrency: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : def;
  };
  return {
    query: get("--query", "newer_than:90d"),
    max: Number(get("--max", "1000")),
    attachmentCap: Number(get("--attachment-cap", "2")) * 1024 * 1024,
    attachmentBudget: Number(get("--attachment-budget", "100")) * 1024 * 1024,
    concurrency: Number(get("--concurrency", "5")),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry on 429 / 403 rateLimit with exponential backoff.
async function withBackoff<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let delay = 500;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: number; response?: { status?: number } };
      const status = e.response?.status ?? e.code;
      if ((status === 429 || status === 403) && attempt < 5) {
        console.warn(`  rate-limited on ${label}; backing off ${delay}ms`);
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`exhausted retries: ${label}`);
}

// Run tasks with a fixed concurrency pool.
async function pool<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const args = parseArgs();
  ensureDataDir();
  console.log(`Sync starting — query="${args.query}" max=${args.max}`);

  const auth = await authorize();
  const gmail = google.gmail({ version: "v1", auth });

  // Fresh snapshot for this query.
  for (const s of ["", "-wal", "-shm"]) rmSync(SNAPSHOT_PATH + s, { force: true });
  const db = new Database(SNAPSHOT_PATH);
  db.exec(readSchema());

  // Profile.
  const profile = await withBackoff(() => gmail.users.getProfile({ userId: "me" }), "getProfile");
  const email = profile.data.emailAddress || "me@unknown";
  setMeta(db, "profile_email", email);
  console.log(`  account: ${email}`);

  // Labels.
  const labelsRes = await withBackoff(() => gmail.users.labels.list({ userId: "me" }), "labels.list");
  const insLabel = db.prepare(
    `INSERT OR REPLACE INTO labels (id, name, type, message_list_visibility, label_list_visibility, color_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const l of labelsRes.data.labels ?? []) {
    insLabel.run(
      l.id,
      l.name,
      l.type ?? "user",
      l.messageListVisibility ?? null,
      l.labelListVisibility ?? null,
      l.color ? JSON.stringify(l.color) : null,
    );
  }
  console.log(`  labels: ${(labelsRes.data.labels ?? []).length}`);

  // Message ids (paginated).
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withBackoff(
      () =>
        gmail.users.messages.list({
          userId: "me",
          q: args.query,
          maxResults: 500,
          pageToken,
        }),
      "messages.list",
    );
    for (const m of res.data.messages ?? []) {
      if (m.id) ids.push(m.id);
      if (ids.length >= args.max) break;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < args.max);
  console.log(`  messages to fetch: ${ids.length}`);

  // Fetch full messages with concurrency + backoff, insert into snapshot.
  let maxHistory = 0;
  let attachmentBudgetUsed = 0;
  let done = 0;

  const insertOne = db.transaction((msg: gmail_v1.Schema$Message) => {
    const { input, labelIds, attachments } = messageToRow(msg);
    insertMessage(db, { ...input, labelIds });
    maxHistory = Math.max(maxHistory, input.historyId);
    return { attachments, id: input.id };
  });

  await pool(ids, args.concurrency, async (id) => {
    const res = await withBackoff(
      () => gmail.users.messages.get({ userId: "me", id, format: "full" }),
      `messages.get ${id}`,
    );
    const { attachments } = insertOne(res.data);

    // Fetch attachment bodies within caps/budget (lazy fetch would need real
    // creds at runtime, which the sandbox must never have).
    for (const att of attachments) {
      const withinCap = att.size <= args.attachmentCap;
      const withinBudget = attachmentBudgetUsed + att.size <= args.attachmentBudget;
      let data: Buffer | null = null;
      if (withinCap && withinBudget) {
        try {
          const body = await withBackoff(
            () =>
              gmail.users.messages.attachments.get({
                userId: "me",
                messageId: id,
                id: att.attachmentId,
              }),
            `attachment ${att.attachmentId}`,
          );
          if (body.data.data) {
            data = b64urlDecode(body.data.data);
            attachmentBudgetUsed += data.length;
          }
        } catch {
          data = null; // store metadata only on failure
        }
      }
      insertAttachment(db, {
        messageId: id,
        attachmentId: att.attachmentId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        data,
      });
    }

    done++;
    if (done % 50 === 0 || done === ids.length) {
      console.log(`  fetched ${done}/${ids.length}`);
    }
  });

  setMeta(db, "history_counter", String(maxHistory || 1));
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();

  // Copy snapshot → working so the UI shows synced mail immediately.
  for (const s of ["", "-wal", "-shm"]) rmSync(WORKING_PATH + s, { force: true });
  copyFileSync(SNAPSHOT_PATH, WORKING_PATH);

  console.log(
    `Done. Synced ${ids.length} messages (${(attachmentBudgetUsed / 1024 / 1024).toFixed(1)}MB attachments). ` +
      `Restart the server or it will pick up working.db on next reset.`,
  );
}

main().catch((err) => {
  console.error("Sync failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
