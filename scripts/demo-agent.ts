// The product's actual use case: a small agent pointed at the sandbox, doing
// what an agent does — read the room, react, reply in thread, post a summary.
// Nothing here is sandbox-aware; the ONLY difference from talking to real Slack
// is `slackApiUrl`. Watch it land live in the UI at http://localhost:$PORT
// (open the "Agent activity" panel).
//
//   PORT=3200 npx tsx scripts/demo-agent.ts

import { WebClient } from "@slack/web-api";

const PORT = process.env.PORT || "3200";
const client = new WebClient(process.env.SANDBOX_TOKEN || "sandbox-token", {
  slackApiUrl: `${process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`}/api/`,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = async (msg: string) => {
  console.log(`\x1b[36m→\x1b[0m ${msg}`);
  await sleep(1200); // slow enough to watch in the UI
};

interface Msg {
  ts: string;
  text?: string;
  user?: string;
  reply_count?: number;
  thread_ts?: string;
}

async function main() {
  const me = await client.auth.test();
  await step(`Signed in as ${me.user} (${me.user_id}) in ${me.team}`);

  // 1. Find the engineering channel.
  const { channels } = await client.conversations.list({ types: "public_channel" });
  const eng = (channels ?? []).find((c) => c.name === "engineering");
  if (!eng?.id) throw new Error("#engineering not found — run `npm run seed` first");
  await step(`Found #${eng.name}`);

  // 2. Read recent history.
  const { messages } = await client.conversations.history({ channel: eng.id, limit: 20 });
  const history = (messages ?? []) as Msg[];
  await step(`Read ${history.length} messages`);

  // 3. Find the most recent question and react to show it's been seen.
  const question = history.find((m) => m.text?.includes("?"));
  if (question) {
    await client.reactions.add({ channel: eng.id, timestamp: question.ts, name: "eyes" });
    await step(`Reacted :eyes: to "${question.text?.slice(0, 60)}…"`);
  }

  // 4. Reply in the busiest thread.
  const busiest = history
    .filter((m) => (m.reply_count ?? 0) > 0)
    .sort((a, b) => (b.reply_count ?? 0) - (a.reply_count ?? 0))[0];
  if (busiest) {
    const { messages: thread } = await client.conversations.replies({
      channel: eng.id,
      ts: busiest.ts,
    });
    await step(`Walked a ${(thread ?? []).length}-message thread`);
    await client.chat.postMessage({
      channel: eng.id,
      thread_ts: busiest.ts,
      text:
        "Summarizing this thread for the record: root cause identified, rollback " +
        "completed, and a canary stage is the agreed follow-up. I've opened a " +
        "tracking task and will report back after the next deploy window.",
    });
    await step("Replied in thread with a summary");
  }

  // 5. Answer the open question in-channel.
  if (question) {
    await client.chat.postMessage({
      channel: eng.id,
      thread_ts: question.ts,
      text:
        "Looking at this now. Replica lag started climbing when the nightly ETL " +
        "began writing to the new warehouse schema — the orders table lost its " +
        "covering index in the migration. Rebuilding it should restore latency.",
    });
    await step("Answered the open question in its thread");
  }

  // 6. Post a standup-style summary.
  const posted = await client.chat.postMessage({
    channel: eng.id,
    text:
      "*Automated digest* — I reviewed the last 20 messages in this channel.\n" +
      "• 1 open question triaged (replica latency → missing index)\n" +
      "• 1 incident thread summarized with follow-ups\n" +
      "• No action needed from anyone before the next deploy window.",
  });
  await step("Posted a channel digest");

  // 7. Verify our own write is visible, then add a permalink for the record.
  const permalink = await client.chat.getPermalink({
    channel: eng.id,
    message_ts: posted.ts as string,
  });
  await step(`Digest permalink: ${permalink.permalink}`);

  console.log(
    "\n\x1b[32mDone.\x1b[0m Everything above hit only the local sandbox.\n" +
      `Open http://localhost:${PORT} → "Agent activity" to see the audit trail,\n` +
      "then press \x1b[1mReset to snapshot\x1b[0m to undo it all.",
  );
}

main().catch((e) => {
  console.error("Demo agent failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
