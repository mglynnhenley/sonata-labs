// Sync a REAL Slack workspace into data/snapshot.db (one way, read only).
//
//   SLACK_TOKEN=xoxp-... npm run sync
//   npm run sync -- --since 30d --max-per-channel 500 --types public_channel,im
//   npm run sync -- --no-files            # skip file downloads entirely
//
// The token is used ONLY here — the sandbox runtime never sees it and nothing is
// ever written back to Slack. Required read scopes:
//   users:read channels:read groups:read im:read mpim:read
//   channels:history groups:history im:history mpim:history
//   reactions:read files:read pins:read
//
// Re-running is idempotent (upserts by id / (channel,ts)), so this doubles as
// incremental sync. After syncing, run `npm run reset` to load the snapshot
// into the working DB.

import Database from "better-sqlite3";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { WebClient, ErrorCode, type CodedError } from "@slack/web-api";
import { ensureDataDir, readSchema, SNAPSHOT_PATH, DATA_DIR } from "../lib/db.js";
import { insertUser } from "../lib/store/users.js";
import { insertConversation, addMember } from "../lib/store/conversations.js";
import { insertMessage, refreshThreadStats } from "../lib/store/messages.js";
import { addReaction } from "../lib/store/reactions.js";
import { addPin } from "../lib/store/pins.js";
import { insertFile, linkFileToMessage } from "../lib/store/files.js";
import { setSelf } from "../lib/store/meta.js";
import {
  userToRow,
  conversationToRow,
  messageToRow,
  fileToRow,
} from "../lib/sync/transform.js";
import type { SlackConversation, SlackFile, SlackMessage, SlackUser } from "../lib/slack/types.js";

// --- args -------------------------------------------------------------------

function argValue(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const SINCE = argValue("since", "90d");
const TYPES = argValue("types", "public_channel,private_channel,mpim,im");
const SKIP_FILES = hasFlag("no-files");

function parseSince(v: string): number {
  const m = /^(\d+)([dwmy])$/.exec(v);
  if (!m) {
    // Fail with a usage message, not a stack trace (this runs before main()).
    console.error(`Invalid --since "${v}" — expected a form like 90d, 4w, 6m, or 1y.`);
    process.exit(1);
  }
  const n = Number(m[1]);
  const ms = { d: 86_400_000, w: 604_800_000, m: 2_592_000_000, y: 31_536_000_000 }[
    m[2] as "d" | "w" | "m" | "y"
  ];
  return Date.now() - n * ms;
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid --${name} "${raw}" — expected a positive number.`);
    process.exit(1);
  }
  return Math.floor(n);
}

const OLDEST_TS = (parseSince(SINCE) / 1000).toFixed(6);
const MAX_PER_CHANNEL = positiveInt("max-per-channel", argValue("max-per-channel", "1000"));
const FILE_CAP = positiveInt("file-cap", argValue("file-cap", String(2 * 1024 * 1024)));
const FILE_BUDGET = positiveInt("file-budget", argValue("file-budget", String(100 * 1024 * 1024)));

// --- token ------------------------------------------------------------------

const TOKEN_FILE = path.join(DATA_DIR, "slack-token.json");

function loadToken(): string {
  if (process.env.SLACK_TOKEN) return process.env.SLACK_TOKEN;
  if (existsSync(TOKEN_FILE)) {
    const parsed = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as { token?: string };
    if (parsed.token) return parsed.token;
  }
  console.error(
    [
      "No Slack token found.",
      "",
      "  Provide one of:",
      "    SLACK_TOKEN=xoxp-... npm run sync",
      `    echo '{"token":"xoxp-..."}' > ${TOKEN_FILE}`,
      "",
      "  Create a user or bot token at https://api.slack.com/apps with READ scopes only:",
      "    users:read channels:read groups:read im:read mpim:read",
      "    channels:history groups:history im:history mpim:history",
      "    reactions:read files:read pins:read",
    ].join("\n"),
  );
  process.exit(1);
}

// --- rate limiting ----------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Slack's tier-3 methods are ~50 req/min and reply 429 with Retry-After. The
 * SDK retries some of these itself; this wrapper adds our own backoff so a big
 * workspace can't blow through the budget mid-sync.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as CodedError & {
        data?: { error?: string; retry_after?: number };
        retryAfter?: number;
      };
      const isRate =
        err.code === ErrorCode.RateLimitedError || err.data?.error === "ratelimited";
      if (isRate && attempt < tries) {
        const wait = (err.retryAfter ?? err.data?.retry_after ?? 5 * attempt) * 1000;
        console.log(`    rate limited on ${label}; waiting ${Math.round(wait / 1000)}s…`);
        await sleep(wait);
        continue;
      }
      // Missing scope / not_in_channel are expected for some conversations —
      // report and continue rather than aborting the whole sync.
      const code = err.data?.error ?? err.code ?? "unknown";
      throw new Error(`${label}: ${code}`);
    }
  }
}

/** Walk a cursor-paginated method, accumulating up to `max` items. */
async function paginate<T>(
  label: string,
  call: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  max = Infinity,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await withRetry(label, () => call(cursor));
    out.push(...page.items);
    cursor = page.nextCursor || undefined;
    if (out.length >= max) return out.slice(0, max);
  } while (cursor);
  return out;
}

// --- main -------------------------------------------------------------------

async function main() {
  const token = loadToken();
  const client = new WebClient(token, { retryConfig: { retries: 0 } });

  console.log("Slack sandbox sync");
  console.log(
    `  since=${SINCE} max-per-channel=${MAX_PER_CHANNEL} types=${TYPES} files=${SKIP_FILES ? "off" : "on"}`,
  );

  const auth = await withRetry("auth.test", () => client.auth.test());
  console.log(`  authenticated as ${auth.user} (${auth.user_id}) in ${auth.team}`);

  ensureDataDir();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(SNAPSHOT_PATH + suffix, { force: true });
  const db = new Database(SNAPSHOT_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(readSchema());

  setSelf(db, {
    teamId: (auth.team_id as string) ?? "T00000000",
    teamName: (auth.team as string) ?? "Workspace",
    teamDomain: ((auth.url as string) ?? "").replace(/^https?:\/\/|\.slack\.com\/?$/g, "") || "workspace",
    userId: (auth.user_id as string) ?? "U00000000",
    userName: (auth.user as string) ?? "user",
  });

  // --- users ---
  const users = await paginate<SlackUser>("users.list", async (cursor) => {
    const res = await client.users.list({ limit: 200, cursor });
    return {
      items: (res.members ?? []) as SlackUser[],
      nextCursor: res.response_metadata?.next_cursor,
    };
  });
  db.transaction(() => {
    for (const u of users) insertUser(db, userToRow(u));
  })();
  console.log(`  users: ${users.length}`);

  // --- conversations ---
  const convs = await paginate<SlackConversation>("conversations.list", async (cursor) => {
    const res = await client.conversations.list({ types: TYPES, limit: 200, cursor });
    return {
      items: (res.channels ?? []) as SlackConversation[],
      nextCursor: res.response_metadata?.next_cursor,
    };
  });
  db.transaction(() => {
    for (const c of convs) insertConversation(db, conversationToRow(c));
  })();
  console.log(`  conversations: ${convs.length}`);

  // --- per-conversation: members, history, replies, reactions, pins, files ---
  const seenFiles = new Map<string, SlackFile>();
  let fileBudgetUsed = 0;
  let totalMessages = 0;
  let totalReplies = 0;
  const skipped: string[] = [];

  for (const [idx, c] of convs.entries()) {
    const label = c.name ? `#${c.name}` : c.id;
    process.stdout.write(`  [${idx + 1}/${convs.length}] ${label} … `);
    try {
      // members (ims report none)
      if (!c.is_im) {
        const members = await paginate<string>(
          `conversations.members ${label}`,
          async (cursor) => {
            const res = await client.conversations.members({
              channel: c.id,
              limit: 200,
              cursor,
            });
            return {
              items: res.members ?? [],
              nextCursor: res.response_metadata?.next_cursor,
            };
          },
        );
        db.transaction(() => {
          for (const m of members) addMember(db, c.id, m);
        })();
      } else if (c.user) {
        db.transaction(() => {
          addMember(db, c.id, c.user as string);
          addMember(db, c.id, auth.user_id as string);
        })();
      }

      // history (roots + standalone messages)
      const history = await paginate<SlackMessage>(
        `conversations.history ${label}`,
        async (cursor) => {
          const res = await client.conversations.history({
            channel: c.id,
            limit: 200,
            oldest: OLDEST_TS,
            cursor,
          });
          return {
            items: (res.messages ?? []) as SlackMessage[],
            nextCursor: res.response_metadata?.next_cursor,
          };
        },
        MAX_PER_CHANNEL,
      );

      const threadRoots: string[] = [];
      const pendingFiles: SlackFile[] = [];

      const writeMessages = (msgs: SlackMessage[]) => {
        db.transaction(() => {
          for (const m of msgs) {
            if (!m.ts) continue;
            const parts = messageToRow(c.id, m);
            insertMessage(db, parts.input);
            for (const r of parts.reactions) {
              for (const u of r.users) addReaction(db, c.id, m.ts, r.name, u);
            }
            for (const f of parts.files) {
              if (!seenFiles.has(f.id)) seenFiles.set(f.id, f);
              pendingFiles.push(f);
              linkFileToMessage(db, c.id, m.ts, f.id);
            }
            if (parts.threadRootTs) threadRoots.push(parts.threadRootTs);
          }
        })();
      };
      writeMessages(history);
      totalMessages += history.length;

      // replies per threaded root
      for (const rootTs of threadRoots) {
        const replies = await paginate<SlackMessage>(
          `conversations.replies ${label}`,
          async (cursor) => {
            const res = await client.conversations.replies({
              channel: c.id,
              ts: rootTs,
              limit: 200,
              cursor,
            });
            return {
              items: (res.messages ?? []) as SlackMessage[],
              nextCursor: res.response_metadata?.next_cursor,
            };
          },
        );
        // The first item is the parent (already stored) — skip it.
        const onlyReplies = replies.filter((r) => r.ts !== rootTs);
        writeMessages(onlyReplies);
        totalReplies += onlyReplies.length;
        db.transaction(() => refreshThreadStats(db, c.id, rootTs))();
      }

      // pins
      try {
        const pins = await withRetry(`pins.list ${label}`, () =>
          client.pins.list({ channel: c.id }),
        );
        db.transaction(() => {
          for (const item of (pins.items ?? []) as Array<{
            message?: { ts?: string };
            created?: number;
            created_by?: string;
          }>) {
            if (item.message?.ts) {
              addPin(db, c.id, item.message.ts, item.created_by ?? "", item.created ?? 0);
            }
          }
        })();
      } catch {
        // pins:read may be absent; not fatal
      }

      // files referenced by this channel's messages
      if (!SKIP_FILES) {
        for (const f of pendingFiles) {
          if (db.prepare("SELECT 1 FROM files WHERE id = ?").get(f.id)) continue;
          let data: Buffer | null = null;
          const size = f.size ?? 0;
          if (size > 0 && size <= FILE_CAP && fileBudgetUsed + size <= FILE_BUDGET && f.url_private) {
            try {
              const res = await fetch(f.url_private, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (res.ok) {
                data = Buffer.from(await res.arrayBuffer());
                fileBudgetUsed += data.length;
              }
            } catch {
              // leave metadata-only
            }
          }
          db.transaction(() => insertFile(db, fileToRow(f, data)))();
        }
      } else {
        for (const f of pendingFiles) {
          if (!db.prepare("SELECT 1 FROM files WHERE id = ?").get(f.id)) {
            db.transaction(() => insertFile(db, fileToRow(f, null)))();
          }
        }
      }

      console.log(`${history.length} msgs`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`skipped (${msg})`);
      skipped.push(`${label}: ${msg}`);
    }
  }

  db.pragma("wal_checkpoint(TRUNCATE)");
  const counts = {
    users: (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n,
    conversations: (db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n,
    messages: (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n,
    reactions: (db.prepare("SELECT COUNT(*) AS n FROM reactions").get() as { n: number }).n,
    files: (db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n,
  };
  db.close();

  console.log("\nSnapshot written:", SNAPSHOT_PATH);
  console.log(
    `  ${counts.users} users, ${counts.conversations} conversations, ` +
      `${counts.messages} messages (${totalReplies} thread replies), ` +
      `${counts.reactions} reactions, ${counts.files} files ` +
      `(${(fileBudgetUsed / 1024 / 1024).toFixed(1)} MB downloaded)`,
  );
  if (skipped.length) {
    console.log(`\n  ${skipped.length} conversation(s) skipped:`);
    for (const s of skipped.slice(0, 20)) console.log(`    - ${s}`);
  }
  console.log("\nRun `npm run reset` to load this snapshot into the working DB.");
  void totalMessages;
}

main().catch((e) => {
  console.error("\nSync failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
