// A minimal Events API receiver — the shape a real event-driven agent has.
// Run it, then do things in the sandbox UI (or run `npm run demo`) and watch
// events arrive.
//
//   PORT=3200 npx tsx scripts/demo-event-receiver.ts
//   PORT=3200 npx tsx scripts/demo-event-receiver.ts --port 4000 --unsigned
//
// It does what Slack's docs tell receivers to do:
//   1. answer the url_verification challenge
//   2. VERIFY X-Slack-Signature before trusting anything
//   3. ack fast (200) and process afterwards

import { createServer } from "node:http";
import { verifySignature } from "../src/lib/events/signing.js";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const LISTEN_PORT = Number(arg("port", "4100"));
const SANDBOX = process.env.SANDBOX_ROOT_URL || `http://localhost:${process.env.PORT || 3200}`;
const SKIP_VERIFY = process.argv.includes("--unsigned");

let secret = process.env.SANDBOX_SIGNING_SECRET || "sandbox-signing-secret";
let received = 0;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");

    // --- 2. verify the signature BEFORE parsing/trusting the body ---
    if (!SKIP_VERIFY) {
      const sig = String(req.headers["x-slack-signature"] ?? "");
      const ts = Number(req.headers["x-slack-request-timestamp"] ?? 0);
      if (!verifySignature(raw, ts, sig, { secret })) {
        console.log("\x1b[31m✗ rejected: bad signature\x1b[0m");
        res.writeHead(401).end("bad signature");
        return;
      }
    }

    let body: {
      type?: string;
      challenge?: string;
      event?: { type?: string; [k: string]: unknown };
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }

    // --- 1. the handshake ---
    if (body.type === "url_verification") {
      console.log("\x1b[36m↔\x1b[0m url_verification — echoing challenge");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ challenge: body.challenge }));
      return;
    }

    // --- 3. ack immediately, then process ---
    res.writeHead(200).end("ok");

    received++;
    const e = body.event ?? {};
    // message_changed carries the new text in event.message, and
    // message_deleted identifies the victim via deleted_ts.
    const nested = (e.message as { text?: string } | undefined)?.text;
    const detail =
      e.type === "message"
        ? `${e.subtype ? `[${e.subtype}] ` : ""}${String(
            e.text ?? nested ?? e.deleted_ts ?? "",
          ).slice(0, 60)}`
        : e.type === "reaction_added" || e.type === "reaction_removed"
          ? `:${String(e.reaction)}: by ${String(e.user)}`
          : e.type === "member_joined_channel"
            ? `${String(e.user)} joined ${String(e.channel)}`
            : e.type === "channel_created"
              ? `#${String((e.channel as { name?: string })?.name)}`
              : e.type === "pin_added" || e.type === "pin_removed"
                ? `${String(e.channel_id)} by ${String(e.user)}`
                : JSON.stringify(e).slice(0, 70);
    console.log(
      `\x1b[32m✓\x1b[0m #${String(received).padStart(3)} \x1b[1m${e.type}\x1b[0m ${detail}`,
    );
  });
});

server.listen(LISTEN_PORT, async () => {
  const url = `http://localhost:${LISTEN_PORT}/slack/events`;
  console.log(`Receiver listening on ${url}`);
  console.log(`Signature verification: ${SKIP_VERIFY ? "OFF" : "ON"}`);

  // Fetch the sandbox's signing secret, then subscribe.
  try {
    const info = (await fetch(`${SANDBOX}/api/sandbox/events`).then((r) => r.json())) as {
      signing_secret: string;
    };
    if (info.signing_secret) secret = info.signing_secret;

    const res = (await fetch(`${SANDBOX}/api/sandbox/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }).then((r) => r.json())) as {
      ok: boolean;
      subscription: { id: string; active: boolean; lastError: string | null };
    };

    if (res.ok) {
      console.log(`Subscribed (${res.subscription.id}). Waiting for events…\n`);
      console.log("Try:  npm run demo     — or post a message in the UI\n");
    } else {
      console.error(`Subscription failed: ${res.subscription?.lastError}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`Could not reach the sandbox at ${SANDBOX}:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
});
