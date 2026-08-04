// Part 4 of the acceptance harness: the Events API. Stands up a real receiver
// that verifies signatures the way Slack's docs prescribe, and checks that
// mutations produce correctly-shaped, correctly-signed deliveries.
//
// Imported by smoke-sdk.ts.

import { createServer, type Server } from "node:http";
import type { WebClient } from "@slack/web-api";
import { verifySignature } from "../src/lib/events/signing.js";

interface Harness {
  client: WebClient;
  check: (name: string, cond: boolean, detail?: unknown) => void;
}

const ROOT_URL =
  process.env.SANDBOX_ROOT_URL || `http://localhost:${process.env.PORT || "3200"}`;
const LISTEN_PORT = Number(process.env.SMOKE_EVENT_PORT || 4399);

interface Received {
  type: string;
  event: Record<string, unknown>;
  signatureValid: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `predicate` holds or we time out (events are asynchronous). */
async function until(predicate: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

export async function part4Events({ client, check }: Harness): Promise<void> {
  console.log("\n\x1b[1mPart 4 — Events API\x1b[0m");

  const secret = (
    (await fetch(`${ROOT_URL}/api/sandbox/events`).then((r) => r.json())) as {
      signing_secret: string;
    }
  ).signing_secret;

  const received: Received[] = [];
  let handshakeSigned = false;
  let rejectedUnsigned = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const sig = String(req.headers["x-slack-signature"] ?? "");
      const ts = Number(req.headers["x-slack-request-timestamp"] ?? 0);
      const valid = verifySignature(raw, ts, sig, { secret });

      let body: { type?: string; challenge?: string; event?: Record<string, unknown> };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        res.writeHead(400).end();
        return;
      }

      if (body.type === "url_verification") {
        handshakeSigned = valid;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ challenge: body.challenge }));
        return;
      }

      if (!valid) {
        rejectedUnsigned++;
        res.writeHead(401).end();
        return;
      }

      received.push({
        type: String(body.event?.type ?? "?"),
        event: body.event ?? {},
        signatureValid: valid,
      });
      res.writeHead(200).end("ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(LISTEN_PORT, resolve));
  const url = `http://localhost:${LISTEN_PORT}/slack/events`;
  let subId: string | undefined;

  try {
    // --- subscription + handshake ---
    const sub = (await fetch(`${ROOT_URL}/api/sandbox/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }).then((r) => r.json())) as {
      ok: boolean;
      subscription: { id: string; active: boolean; lastError: string | null };
    };
    subId = sub.subscription?.id;
    check("url_verification handshake succeeds", sub.ok === true, sub.subscription?.lastError);
    check("handshake request is signed", handshakeSigned);

    const { channels } = await client.conversations.list({ types: "public_channel" });
    const eng = (channels ?? []).find((c) => c.name === "engineering")!;

    // --- message ---
    const posted = await client.chat.postMessage({ channel: eng.id!, text: "event smoke" });
    const gotMessage = await until(() =>
      received.some((r) => r.type === "message" && r.event.ts === posted.ts),
    );
    check("chat.postMessage delivers a `message` event", gotMessage);
    const msgEvent = received.find((r) => r.event.ts === posted.ts);
    check("event deliveries are signed", msgEvent?.signatureValid === true);
    check("message event carries channel/user/text",
      msgEvent?.event.channel === eng.id &&
        !!msgEvent?.event.user &&
        msgEvent?.event.text === "event smoke",
      msgEvent?.event,
    );
    check("message event has channel_type", msgEvent?.event.channel_type === "channel");

    // --- threaded reply carries thread_ts ---
    const reply = await client.chat.postMessage({
      channel: eng.id!,
      thread_ts: posted.ts as string,
      text: "event smoke reply",
    });
    await until(() => received.some((r) => r.event.ts === reply.ts));
    const replyEvent = received.find((r) => r.event.ts === reply.ts);
    check("threaded reply event carries thread_ts", replyEvent?.event.thread_ts === posted.ts);

    // --- reactions ---
    await client.reactions.add({
      channel: eng.id!,
      timestamp: posted.ts as string,
      name: "rocket",
    });
    const gotReaction = await until(() => received.some((r) => r.type === "reaction_added"));
    check("reactions.add delivers `reaction_added`", gotReaction);
    const reactEvent = received.find((r) => r.type === "reaction_added");
    check(
      "reaction event has item.{channel,ts} + reaction",
      reactEvent?.event.reaction === "rocket" &&
        (reactEvent?.event.item as { channel?: string })?.channel === eng.id,
      reactEvent?.event,
    );

    await client.reactions.remove({
      channel: eng.id!,
      timestamp: posted.ts as string,
      name: "rocket",
    });
    check(
      "reactions.remove delivers `reaction_removed`",
      await until(() => received.some((r) => r.type === "reaction_removed")),
    );

    // --- edit / delete subtypes ---
    await client.chat.update({
      channel: eng.id!,
      ts: posted.ts as string,
      text: "event smoke (edited)",
    });
    const gotChanged = await until(() =>
      received.some((r) => r.event.subtype === "message_changed"),
    );
    check("chat.update delivers subtype=message_changed", gotChanged);
    const changed = received.find((r) => r.event.subtype === "message_changed");
    check(
      "message_changed nests the new text under .message",
      (changed?.event.message as { text?: string })?.text === "event smoke (edited)",
    );

    await client.chat.delete({ channel: eng.id!, ts: posted.ts as string });
    const gotDeleted = await until(() =>
      received.some((r) => r.event.subtype === "message_deleted"),
    );
    check("chat.delete delivers subtype=message_deleted", gotDeleted);
    check(
      "message_deleted identifies the victim via deleted_ts",
      received.find((r) => r.event.subtype === "message_deleted")?.event.deleted_ts === posted.ts,
    );

    // --- channel lifecycle ---
    const chName = `evt-${Date.now().toString(36)}`;
    const created = await client.conversations.create({ name: chName });
    check(
      "conversations.create delivers `channel_created`",
      await until(() =>
        received.some(
          (r) =>
            r.type === "channel_created" &&
            (r.event.channel as { name?: string })?.name === chName,
        ),
      ),
    );
    await client.conversations.invite({ channel: created.channel!.id!, users: "U0PRIYA0001" });
    check(
      "conversations.invite delivers `member_joined_channel` with inviter",
      await until(() =>
        received.some(
          (r) => r.type === "member_joined_channel" && r.event.user === "U0PRIYA0001",
        ),
      ),
    );

    // --- filtering ---
    const filtered: string[] = [];
    const filterServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          type?: string;
          challenge?: string;
          event?: { type?: string };
        };
        if (body.type === "url_verification") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ challenge: body.challenge }));
          return;
        }
        filtered.push(String(body.event?.type));
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => filterServer.listen(LISTEN_PORT + 1, r));
    const fSub = (await fetch(`${ROOT_URL}/api/sandbox/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `http://localhost:${LISTEN_PORT + 1}/e`,
        events: ["reaction_added"],
      }),
    }).then((r) => r.json())) as { subscription: { id: string } };

    const p2 = await client.chat.postMessage({ channel: eng.id!, text: "filter check" });
    await client.reactions.add({
      channel: eng.id!,
      timestamp: p2.ts as string,
      name: "eyes",
    });
    await until(() => filtered.includes("reaction_added"));
    check(
      "event filters deliver only subscribed types",
      filtered.includes("reaction_added") && !filtered.includes("message"),
      filtered,
    );
    await fetch(`${ROOT_URL}/api/sandbox/events?id=${fSub.subscription.id}`, { method: "DELETE" });
    await new Promise<void>((r) => filterServer.close(() => r()));

    // --- forged deliveries are rejected by the receiver ---
    const before = rejectedUnsigned;
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "event_callback", event: { type: "message", text: "forged" } }),
    });
    check("receiver rejects unsigned deliveries", rejectedUnsigned === before + 1);

    // --- a broken subscriber cannot break the API ---
    const deadUrl = "http://127.0.0.1:9/dead"; // discard port: always refuses
    await fetch(`${ROOT_URL}/api/sandbox/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: deadUrl }),
    });
    const t0 = Date.now();
    const stillWorks = await client.chat.postMessage({
      channel: eng.id!,
      text: "isolation check",
    });
    const elapsed = Date.now() - t0;
    check("unreachable subscriber does not fail the API call", stillWorks.ok === true);
    check("unreachable subscriber does not block the API call", elapsed < 2000, `${elapsed}ms`);
  } finally {
    if (subId) {
      await fetch(`${ROOT_URL}/api/sandbox/events?id=${subId}`, { method: "DELETE" });
    }
    // Drop every subscription so later runs start clean.
    const all = (await fetch(`${ROOT_URL}/api/sandbox/events`).then((r) => r.json())) as {
      subscriptions: Array<{ id: string }>;
    };
    for (const s of all.subscriptions) {
      await fetch(`${ROOT_URL}/api/sandbox/events?id=${s.id}`, { method: "DELETE" });
    }
    await fetch(`${ROOT_URL}/api/sandbox/events?deliveries=1`, { method: "DELETE" });
    await new Promise<void>((r) => server.close(() => r()));
  }
}
