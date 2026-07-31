// Acceptance harness: drive the sandbox with the OFFICIAL @slack/web-api SDK,
// the same way a real agent would — only slackApiUrl is overridden. If this
// passes, an agent using @slack/web-api works against the sandbox unchanged.
//
//   PORT=3100 npm run smoke          # part 1 (reads) + part 2 (writes)
//   PORT=3100 npm run smoke -- reads # part 1 only
//
// Requires the server to be running (npm run dev / start) on $PORT and a
// seeded workspace (npm run seed).

import { WebClient, ErrorCode, type CodedError } from "@slack/web-api";

const PORT = process.env.PORT || "3100";
const ROOT_URL = process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`;
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

const client = new WebClient(TOKEN, { slackApiUrl: `${ROOT_URL}/api/` });

let passed = 0;
let failed = 0;
export function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log("      detail:", JSON.stringify(detail)?.slice(0, 300));
  }
}

/** Expect the SDK to throw a platform error with the given Slack error code. */
export async function expectSlackError(
  name: string,
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
    check(name, false, "expected an error but call succeeded");
  } catch (e) {
    const coded = e as CodedError & { data?: { error?: string } };
    const got = coded.data?.error;
    check(name, coded.code === ErrorCode.PlatformError && got === code, {
      gotCode: coded.code,
      gotError: got,
      want: code,
    });
  }
}

interface Msg {
  ts: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  reactions?: Array<{ name: string; users: string[]; count: number }>;
  user?: string;
  bot_id?: string;
  files?: Array<{ id: string; name?: string }>;
  pinned_to?: string[];
}

async function part1Reads(): Promise<void> {
  console.log("\n\x1b[1mPart 1 — Reads (official SDK + slackApiUrl override)\x1b[0m");

  // auth.test — the first thing every agent does
  const auth = await client.auth.test();
  check("auth.test ok with user_id + team_id", !!auth.user_id && !!auth.team_id, auth);
  const selfId = auth.user_id as string;

  // users.list + cursor pagination via the SDK's own paginate()
  const users1 = await client.users.list({ limit: 3 });
  check("users.list returns members", (users1.members ?? []).length === 3);
  check(
    "users.list page 1 has non-empty next_cursor",
    !!users1.response_metadata?.next_cursor,
    users1.response_metadata,
  );
  const seen = new Set<string>();
  let pages = 0;
  for await (const page of client.paginate("users.list", { limit: 3 })) {
    pages++;
    for (const m of (page as { members?: Array<{ id: string }> }).members ?? []) {
      check(`paginate: no duplicate member ${m.id}`, !seen.has(m.id));
      seen.add(m.id);
    }
    if (pages > 10) break; // safety: a non-terminating cursor would loop forever
  }
  check("users.list paginate() terminates", pages >= 3 && pages <= 10, { pages });
  check("users.list paginate() covers all 8 users", seen.size === 8, [...seen]);

  // users.info
  const uinfo = await client.users.info({ user: selfId });
  check("users.info self resolves", uinfo.user?.name === auth.user, uinfo.user?.name);
  const bot = [...seen].find((id) => id.startsWith("U0DEPLOY"));
  if (bot) {
    const binfo = await client.users.info({ user: bot });
    check("users.info bot has is_bot", binfo.user?.is_bot === true);
  }

  // conversations.list — types filter
  const pub = await client.conversations.list({ types: "public_channel" });
  const pubNames = (pub.channels ?? []).map((c) => c.name).sort();
  check("conversations.list public channels", JSON.stringify(pubNames) === JSON.stringify(["engineering", "general", "random"]), pubNames);
  const general = (pub.channels ?? []).find((c) => c.is_general);
  check("conversations.list marks #general is_general", !!general);
  check("conversations.list includes is_member", general?.is_member === true);
  const ims = await client.conversations.list({ types: "im" });
  check("conversations.list types=im returns 2 DMs", (ims.channels ?? []).length === 2);
  const all = await client.conversations.list({
    types: "public_channel,private_channel,mpim,im",
  });
  check("conversations.list all types returns 7", (all.channels ?? []).length === 7, (all.channels ?? []).length);

  // conversations.info
  const eng = (pub.channels ?? []).find((c) => c.name === "engineering")!;
  const info = await client.conversations.info({ channel: eng.id! });
  check("conversations.info returns topic", !!info.channel?.topic?.value, info.channel?.topic);
  check("conversations.info num_members = 7", (info.channel as { num_members?: number })?.num_members === 7);

  // conversations.history — roots only, newest first, cursor paging
  const hist = await client.conversations.history({ channel: eng.id!, limit: 100 });
  const msgs = (hist.messages ?? []) as Msg[];
  check("history returns messages", msgs.length > 5);
  check(
    "history EXCLUDES thread replies (roots only)",
    msgs.every((m) => !m.thread_ts || m.thread_ts === m.ts),
  );
  const tss = msgs.map((m) => m.ts);
  check("history newest-first", JSON.stringify(tss) === JSON.stringify([...tss].sort().reverse()));
  const root = msgs.find((m) => (m.reply_count ?? 0) > 0)!;
  check("history root carries reply_count + latest_reply", !!root && !!root.latest_reply, root);

  // history cursor pagination: 2 pages, no overlap, terminates
  const h1 = await client.conversations.history({ channel: eng.id!, limit: 4 });
  check("history page 1 has_more", h1.has_more === true);
  const h2 = await client.conversations.history({
    channel: eng.id!,
    limit: 4,
    cursor: h1.response_metadata!.next_cursor!,
  });
  const ids1 = new Set(((h1.messages ?? []) as Msg[]).map((m) => m.ts));
  check(
    "history page 2 no overlap with page 1",
    ((h2.messages ?? []) as Msg[]).every((m) => !ids1.has(m.ts)),
  );

  // conversations.replies — parent first, then oldest-first replies
  const replies = await client.conversations.replies({ channel: eng.id!, ts: root.ts });
  const rmsgs = (replies.messages ?? []) as Msg[];
  check("replies parent first", rmsgs[0]?.ts === root.ts);
  check("replies count matches root.reply_count", rmsgs.length === (root.reply_count ?? 0) + 1, {
    got: rmsgs.length,
    want: (root.reply_count ?? 0) + 1,
  });
  check(
    "replies all carry thread_ts of root",
    rmsgs.every((m) => m.thread_ts === root.ts),
  );

  // conversations.members
  const members = await client.conversations.members({ channel: eng.id! });
  check("members returns 7 ids", (members.members ?? []).length === 7);

  // reactions hydrated on messages
  const genHist = await client.conversations.history({ channel: general!.id!, limit: 100 });
  const withReactions = ((genHist.messages ?? []) as Msg[]).find((m) => m.reactions?.length);
  check("history hydrates reactions[]", !!withReactions, withReactions?.reactions);
  check(
    "reaction has name/users/count",
    !!withReactions?.reactions?.[0]?.name &&
      withReactions!.reactions![0].count === withReactions!.reactions![0].users.length,
  );

  // pins
  const pins = await client.pins.list({ channel: general!.id! });
  const pinItems = (pins.items ?? []) as Array<{ message?: Msg }>;
  check("pins.list returns the pinned welcome", pinItems.length === 1 && !!pinItems[0].message?.pinned_to);

  // files
  const withFile = ((hist.messages ?? []) as Msg[]).find((m) => m.files?.length);
  check("history hydrates files[]", !!withFile, withFile);
  if (withFile?.files?.[0]) {
    const finfo = await client.files.info({ file: withFile.files[0].id });
    check("files.info resolves", finfo.file?.name?.includes("postmortem") === true, finfo.file?.name);
  }

  // bot message shape
  const botMsg = msgs.find((m) => m.bot_id);
  check("bot messages carry bot_id (no user)", !!botMsg && !botMsg.user, botMsg);

  // --- workspace metadata + convenience methods agents commonly reach for ---
  const team = await client.team.info();
  check("team.info returns id/name/domain", !!team.team?.id && !!team.team?.name, team.team?.name);

  const mine = await client.users.conversations({
    types: "public_channel,private_channel,im,mpim",
  });
  const mineIds = (mine.channels ?? []).map((c) => c.id);
  check("users.conversations returns only my conversations", mineIds.length > 0, mineIds.length);
  check(
    "users.conversations excludes channels I'm not in",
    !mineIds.includes("C0RANDOM001") || (await client.conversations.info({ channel: "C0RANDOM001" })).channel?.is_member === true,
  );

  const emoji = await client.emoji.list();
  check("emoji.list returns a map", Object.keys(emoji.emoji ?? {}).length > 20);
  check("emoji.list covers emoji the seed uses", !!(emoji.emoji as Record<string, string>)?.rocket);

  const lookup = await client.users.lookupByEmail({ email: "priya@sandbox.local" });
  check("users.lookupByEmail resolves", lookup.user?.name === "priya", lookup.user?.name);

  const presence = await client.users.getPresence({ user: selfId });
  check("users.getPresence returns a presence", !!presence.presence, presence.presence);

  // read state is exposed to agents on conversations.info
  const engInfo = await client.conversations.info({ channel: eng.id! });
  check(
    "conversations.info exposes unread_count + last_read",
    (engInfo.channel as { unread_count?: number })?.unread_count !== undefined &&
      (engInfo.channel as { last_read?: string })?.last_read !== undefined,
    engInfo.channel,
  );

  // negative tests — SDK must throw platform errors with the right codes
  await expectSlackError(
    "bad token → invalid_auth",
    () => new WebClient("wrong-token", { slackApiUrl: `${ROOT_URL}/api/` }).auth.test(),
    "invalid_auth",
  );
  await expectSlackError(
    "missing channel → channel_not_found",
    () => client.conversations.history({ channel: "C0DOESNOTEX" }),
    "channel_not_found",
  );
  await expectSlackError(
    "private channel invisible? no — self IS a member; missing user → user_not_found",
    () => client.users.info({ user: "U0DOESNOTEX" }),
    "user_not_found",
  );
  await expectSlackError(
    "missing thread → thread_not_found",
    () => client.conversations.replies({ channel: eng.id!, ts: "1111111111.000001" }),
    "thread_not_found",
  );
}

async function main() {
  const mode = process.argv[2] || "all";

  // Establish preconditions. Parts 2 and 4 create channels and messages, so
  // without this the harness only passes on a freshly-seeded DB — reset makes
  // `npm run smoke` repeatable, which is the whole point of having a snapshot.
  const reset = await fetch(`${ROOT_URL}/api/sandbox/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "smoke harness precondition" }),
  }).then((r) => r.json() as Promise<{ ok: boolean; messages?: number }>);
  if (!reset.ok) {
    console.error("Could not reset to snapshot — run `npm run seed` first.");
    process.exit(2);
  }
  console.log(`Reset to snapshot (${reset.messages} messages).`);

  await part1Reads();
  if (mode !== "reads") {
    try {
      const { part2Writes } = await import("./smoke-sdk-writes.js");
      await part2Writes({ client, check, expectSlackError });
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") {
        console.log("\n  (part 2 writes not yet implemented — skipping)");
      } else {
        throw e;
      }
    }
    const { part4Events } = await import("./smoke-sdk-events.js");
    await part4Events({ client, check });
    // Chaos runs last: it deliberately breaks the API, so anything after it
    // would be testing against a sabotaged sandbox.
    const { part3Chaos } = await import("./smoke-sdk-chaos.js");
    await part3Chaos({ client, check });
  }
  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Smoke harness crashed:", e);
  process.exit(2);
});
