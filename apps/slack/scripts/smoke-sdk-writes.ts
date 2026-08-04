// Part 2 of the acceptance harness: mutations via the OFFICIAL SDK, then the
// audit trail and reset. Imported by smoke-sdk.ts (which owns the client and
// the check helpers).

import type { WebClient } from "@slack/web-api";

interface Harness {
  client: WebClient;
  check: (name: string, cond: boolean, detail?: unknown) => void;
  expectSlackError: (name: string, fn: () => Promise<unknown>, code: string) => Promise<void>;
}

interface Msg {
  ts: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reply_users_count?: number;
  latest_reply?: string;
  edited?: { user?: string; ts: string };
  reactions?: Array<{ name: string; users: string[]; count: number }>;
  files?: Array<{ id: string; name?: string }>;
  pinned_to?: string[];
}

const ROOT_URL =
  process.env.SANDBOX_ROOT_URL || `http://localhost:${process.env.PORT || "3200"}`;

export async function part2Writes({ client, check, expectSlackError }: Harness): Promise<void> {
  console.log("\n\x1b[1mPart 2 — Writes (official SDK)\x1b[0m");

  const auth = await client.auth.test();
  const selfId = auth.user_id as string;
  const list = await client.conversations.list({ types: "public_channel" });
  const eng = (list.channels ?? []).find((c) => c.name === "engineering")!;

  // --- chat.postMessage ---
  const posted = await client.chat.postMessage({
    channel: eng.id!,
    text: "Smoke test: canary deploy check :rocket:",
  });
  check("postMessage returns ok + ts + channel", !!posted.ts && posted.channel === eng.id, posted.ts);
  const newTs = posted.ts as string;
  check("postMessage echoes the message", (posted.message as Msg)?.text?.includes("canary") === true);

  const hist = await client.conversations.history({ channel: eng.id!, limit: 5 });
  const inHistory = ((hist.messages ?? []) as Msg[]).find((m) => m.ts === newTs);
  check("posted message appears in history (newest first)", !!inHistory);
  check("posted message is the newest", (hist.messages as Msg[])[0].ts === newTs);

  // ts monotonicity: two rapid posts must differ and increase
  const p2 = await client.chat.postMessage({ channel: eng.id!, text: "second" });
  const p3 = await client.chat.postMessage({ channel: eng.id!, text: "third" });
  check("rapid posts mint distinct increasing ts", (p2.ts as string) < (p3.ts as string), {
    p2: p2.ts,
    p3: p3.ts,
  });

  // --- threaded reply + parent bookkeeping ---
  const reply = await client.chat.postMessage({
    channel: eng.id!,
    thread_ts: newTs,
    text: "Smoke test: reply in thread",
  });
  check("threaded reply ok", !!reply.ts);
  const afterReply = await client.conversations.history({ channel: eng.id!, limit: 10 });
  const parent = ((afterReply.messages ?? []) as Msg[]).find((m) => m.ts === newTs)!;
  check("parent reply_count incremented", parent.reply_count === 1, parent);
  check("parent latest_reply set to reply ts", parent.latest_reply === reply.ts);
  check("parent reply_users_count is 1", parent.reply_users_count === 1);
  check(
    "reply does NOT appear as a history root",
    !((afterReply.messages ?? []) as Msg[]).some((m) => m.ts === reply.ts),
  );
  const thread = await client.conversations.replies({ channel: eng.id!, ts: newTs });
  check("replies returns parent + 1 reply", (thread.messages ?? []).length === 2);

  // replying to a reply threads onto the ROOT, not the reply
  const nested = await client.chat.postMessage({
    channel: eng.id!,
    thread_ts: reply.ts as string,
    text: "Smoke test: nested reply flattens to root",
  });
  const thread2 = await client.conversations.replies({ channel: eng.id!, ts: newTs });
  check(
    "reply-to-a-reply threads onto the root",
    (thread2.messages ?? []).length === 3 &&
      ((thread2.messages ?? []) as Msg[]).every((m) => m.ts === newTs || m.thread_ts === newTs),
    (thread2.messages as Msg[]).map((m) => m.thread_ts),
  );
  void nested;

  // --- chat.update ---
  const updated = await client.chat.update({
    channel: eng.id!,
    ts: newTs,
    text: "Smoke test: canary deploy check (edited)",
  });
  check("update ok", updated.ok === true);
  const afterEdit = await client.conversations.history({ channel: eng.id!, limit: 10 });
  const edited = ((afterEdit.messages ?? []) as Msg[]).find((m) => m.ts === newTs)!;
  check("edited text persisted", edited.text?.includes("(edited)") === true);
  check("edited carries edited.{user,ts}", !!edited.edited?.ts && edited.edited?.user === selfId, edited.edited);
  check("edit preserves thread stats", edited.reply_count === 2, edited.reply_count);

  // edit is searchable under the new text, not the old
  const s1 = await client.search.messages({ query: '"canary deploy check"' });
  check("search finds edited message", (s1.messages?.total ?? 0) >= 1);

  // --- reactions ---
  await client.reactions.add({ channel: eng.id!, timestamp: newTs, name: "thumbsup" });
  const react = await client.reactions.get({ channel: eng.id!, timestamp: newTs });
  const rmsg = react.message as Msg;
  check("reactions.add then get shows reaction", rmsg.reactions?.[0]?.name === "thumbsup", rmsg.reactions);
  check("reaction lists self as user", rmsg.reactions?.[0]?.users.includes(selfId) === true);
  await expectSlackError(
    "duplicate reaction → already_reacted",
    () => client.reactions.add({ channel: eng.id!, timestamp: newTs, name: "thumbsup" }),
    "already_reacted",
  );
  await client.reactions.remove({ channel: eng.id!, timestamp: newTs, name: "thumbsup" });
  const afterUnreact = await client.reactions.get({ channel: eng.id!, timestamp: newTs });
  check("reaction removed", !(afterUnreact.message as Msg).reactions);
  await expectSlackError(
    "removing absent reaction → no_reaction",
    () => client.reactions.remove({ channel: eng.id!, timestamp: newTs, name: "thumbsup" }),
    "no_reaction",
  );

  // --- pins ---
  await client.pins.add({ channel: eng.id!, timestamp: newTs });
  const pins = await client.pins.list({ channel: eng.id! });
  check(
    "pins.add then list includes message",
    ((pins.items ?? []) as Array<{ message?: Msg }>).some((i) => i.message?.ts === newTs),
  );
  await expectSlackError(
    "duplicate pin → already_pinned",
    () => client.pins.add({ channel: eng.id!, timestamp: newTs }),
    "already_pinned",
  );
  await client.pins.remove({ channel: eng.id!, timestamp: newTs });
  const pins2 = await client.pins.list({ channel: eng.id! });
  check(
    "pin removed",
    !((pins2.items ?? []) as Array<{ message?: Msg }>).some((i) => i.message?.ts === newTs),
  );

  // --- conversations.create + invite + post ---
  const chName = `smoke-test-${Date.now().toString(36)}`;
  const created = await client.conversations.create({ name: chName });
  const chId = created.channel!.id!;
  check("conversations.create returns channel", !!chId && created.channel!.name === chName);
  check("creator is auto-joined", created.channel!.is_member === true);
  await expectSlackError(
    "duplicate channel name → name_taken",
    () => client.conversations.create({ name: chName }),
    "name_taken",
  );

  const invited = await client.conversations.invite({ channel: chId, users: "U0PRIYA0001,U0SAM000001" });
  check("invite bumps num_members to 3", (invited.channel as { num_members?: number })?.num_members === 3);
  await expectSlackError(
    "re-inviting → already_in_channel",
    () => client.conversations.invite({ channel: chId, users: "U0PRIYA0001" }),
    "already_in_channel",
  );
  const members = await client.conversations.members({ channel: chId });
  check("members reflects invites", (members.members ?? []).length === 3);

  await client.conversations.setTopic({ channel: chId, topic: "Smoke topic" });
  const chInfo = await client.conversations.info({ channel: chId });
  check("setTopic persisted", chInfo.channel?.topic?.value === "Smoke topic");

  // --- files.upload + share ---
  const upload = await client.files.upload({
    channels: chId,
    filename: "smoke.txt",
    title: "Smoke file",
    content: "hello from the smoke harness",
    initial_comment: "here is the file",
  });
  check("files.upload returns a file", !!upload.file?.id, upload.file?.name);
  const chHist = await client.conversations.history({ channel: chId, limit: 10 });
  const fileMsg = ((chHist.messages ?? []) as Msg[]).find((m) => m.files?.length);
  check("uploaded file is shared as a message with files[]", !!fileMsg, fileMsg?.files);
  if (upload.file?.id) {
    const finfo = await client.files.info({ file: upload.file.id });
    check("files.info shows the sharing channel", (finfo.file?.channels ?? []).includes(chId));
  }

  // --- archive blocks writes ---
  await client.conversations.archive({ channel: chId });
  await expectSlackError(
    "posting to archived channel → is_archived",
    () => client.chat.postMessage({ channel: chId, text: "should fail" }),
    "is_archived",
  );
  await expectSlackError(
    "archiving twice → already_archived",
    () => client.conversations.archive({ channel: chId }),
    "already_archived",
  );
  await client.conversations.unarchive({ channel: chId });
  const afterUnarchive = await client.chat.postMessage({ channel: chId, text: "works again" });
  check("unarchive restores posting", afterUnarchive.ok === true);
  await expectSlackError(
    "cannot archive #general → cant_archive_general",
    () => client.conversations.archive({ channel: (list.channels ?? []).find((c) => c.is_general)!.id! }),
    "cant_archive_general",
  );

  // --- scheduled messages ---
  const postAt = Math.floor(Date.now() / 1000) + 3600;
  const sched = await client.chat.scheduleMessage({ channel: chId, text: "scheduled hello", post_at: postAt });
  const schedId = sched.scheduled_message_id as string;
  check("scheduleMessage returns an id", !!schedId);
  const schedList = await client.chat.scheduledMessages.list({ channel: chId });
  check(
    "scheduledMessages.list includes it",
    (schedList.scheduled_messages ?? []).some((s) => s.id === schedId),
  );
  check(
    "scheduled message is NOT in history",
    !((await client.conversations.history({ channel: chId, limit: 20 })).messages as Msg[]).some(
      (m) => m.text === "scheduled hello",
    ),
  );
  await expectSlackError(
    "scheduling in the past → time_in_past",
    () => client.chat.scheduleMessage({ channel: chId, text: "nope", post_at: 100 }),
    "time_in_past",
  );
  await client.chat.deleteScheduledMessage({ channel: chId, scheduled_message_id: schedId });
  const schedList2 = await client.chat.scheduledMessages.list({ channel: chId });
  check("deleteScheduledMessage removes it", (schedList2.scheduled_messages ?? []).length === 0);

  // --- permalink ---
  const permalink = await client.chat.getPermalink({ channel: eng.id!, message_ts: newTs });
  check("getPermalink returns an archives URL", (permalink.permalink as string)?.includes("/archives/") === true);

  // --- chat.delete + thread cleanup ---
  const delTarget = await client.chat.postMessage({ channel: eng.id!, text: "to be deleted" });
  await client.chat.delete({ channel: eng.id!, ts: delTarget.ts as string });
  const afterDelete = await client.conversations.history({ channel: eng.id!, limit: 20 });
  check(
    "deleted message is gone from history",
    !((afterDelete.messages ?? []) as Msg[]).some((m) => m.ts === delTarget.ts),
  );
  await expectSlackError(
    "deleting a missing message → message_not_found",
    () => client.chat.delete({ channel: eng.id!, ts: "1111111111.000002" }),
    "message_not_found",
  );

  // deleting the only reply un-threads the parent
  const tRoot = await client.chat.postMessage({ channel: eng.id!, text: "thread root" });
  const tReply = await client.chat.postMessage({
    channel: eng.id!,
    thread_ts: tRoot.ts as string,
    text: "only reply",
  });
  await client.chat.delete({ channel: eng.id!, ts: tReply.ts as string });
  const h = await client.conversations.history({ channel: eng.id!, limit: 20 });
  const unthreaded = ((h.messages ?? []) as Msg[]).find((m) => m.ts === tRoot.ts)!;
  check(
    "deleting the last reply clears the parent's thread fields",
    !unthreaded.reply_count && !unthreaded.thread_ts,
    unthreaded,
  );

  // --- audit trail ---
  const activity = await fetch(`${ROOT_URL}/api/activity`).then((r) => r.json() as Promise<{
    sessions: Array<{ id: string; action_count: number }>;
    actions: Array<{ endpoint: string; summary: string; action_type: string }>;
  }>);
  check("activity endpoint returns a session", (activity.sessions ?? []).length >= 1);
  const endpoints = new Set((activity.actions ?? []).map((a) => a.endpoint));
  for (const m of [
    "chat.postMessage",
    "chat.update",
    "chat.delete",
    "reactions.add",
    "reactions.remove",
    "pins.add",
    "conversations.create",
    "conversations.invite",
    "files.upload",
  ]) {
    check(`audit logged ${m}`, endpoints.has(m));
  }
  const postAction = (activity.actions ?? []).find((a) => a.endpoint === "chat.postMessage");
  check("audit summary is human-readable", /posted to #engineering/.test(postAction?.summary ?? ""), postAction?.summary);
  const auditCountBefore = (activity.actions ?? []).length;

  // --- reset ---
  const snapshotCounts = await fetch(`${ROOT_URL}/api/health`).then((r) => r.json() as Promise<{ messages: number }>);
  const resetRes = await fetch(`${ROOT_URL}/api/sandbox/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ note: "smoke harness reset" }),
  }).then((r) => r.json() as Promise<{ ok: boolean; messages: number }>);
  check("reset ok", resetRes.ok === true);
  check("reset restores the pristine message count (45)", resetRes.messages === 45, {
    afterReset: resetRes.messages,
    beforeReset: snapshotCounts.messages,
  });
  const histAfterReset = await client.conversations.history({ channel: eng.id!, limit: 50 });
  check(
    "smoke-posted messages are gone after reset",
    !((histAfterReset.messages ?? []) as Msg[]).some((m) => m.text?.includes("Smoke test")),
  );
  await expectSlackError(
    "channel created during smoke is gone after reset",
    () => client.conversations.info({ channel: chId }),
    "channel_not_found",
  );

  // audit survives the reset (separate file) and gains a new session
  const activity2 = await fetch(`${ROOT_URL}/api/activity?all=1`).then((r) => r.json() as Promise<{
    sessions: Array<{ id: string; note: string | null }>;
    actions: Array<unknown>;
  }>);
  check("audit actions were recorded before the reset", auditCountBefore > 0, auditCountBefore);
  check(
    "audit trail SURVIVED the reset (all pre-reset actions still stored)",
    (activity2.actions ?? []).length >= auditCountBefore,
    { afterReset: (activity2.actions ?? []).length, beforeReset: auditCountBefore },
  );
  check(
    "reset started a new audit session",
    (activity2.sessions ?? []).some((s) => s.note === "smoke harness reset"),
    activity2.sessions?.map((s) => s.note),
  );
}
