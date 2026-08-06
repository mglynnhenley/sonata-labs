// The product's actual use case: an AI-agent-style program that operates a
// mailbox using the OFFICIAL googleapis SDK — only rootUrl points at the
// sandbox. Watch it run live in the UI + activity panel.
//
//   PORT=3100 npm run demo
//
// Flow: list unread → read one → label it → archive it → reply in-thread.

import { google } from "googleapis";
import { b64urlEncode } from "../src/lib/gmail/base64.js";
import { obtainAccessToken } from "../src/lib/eval/client.js";

const PORT = process.env.PORT || "3100";
const ROOT = `http://localhost:${PORT}`;
// /gmail/v1/* is behind OAuth now — mint a provider access token via the
// admin-gated bridge, then hand it to the SDK the way a real agent would.
const auth = new google.auth.OAuth2();
auth.setCredentials({ access_token: await obtainAccessToken(ROOT) });
const gmail = google.gmail({ version: "v1", auth, rootUrl: ROOT });
const userId = "me";

const log = (s: string) => console.log(`\x1b[36m▸\x1b[0m ${s}`);

async function main() {
  // 1. List unread in the inbox.
  const list = await gmail.users.messages.list({
    userId,
    labelIds: ["INBOX", "UNREAD"],
    maxResults: 1,
  });
  const first = list.data.messages?.[0];
  if (!first) return log("No unread mail — nothing to do.");
  log(`Found ${list.data.resultSizeEstimate} unread; handling ${first.id}.`);

  // 2. Read it (full format).
  const msg = await gmail.users.messages.get({ userId, id: first.id!, format: "full" });
  const subject = msg.data.payload?.headers?.find((h) => h.name === "Subject")?.value ?? "(none)";
  const from = msg.data.payload?.headers?.find((h) => h.name === "From")?.value ?? "";
  const msgId = msg.data.payload?.headers?.find((h) => h.name?.toLowerCase() === "message-id")?.value;
  log(`Read: "${subject}" from ${from}`);

  // 3. Ensure an "Agent Reviewed" label and apply it; mark read.
  const labels = await gmail.users.labels.list({ userId });
  let reviewed = labels.data.labels?.find((l) => l.name === "Agent Reviewed");
  if (!reviewed) {
    reviewed = (await gmail.users.labels.create({ userId, requestBody: { name: "Agent Reviewed" } })).data;
    log(`Created label "Agent Reviewed".`);
  }
  await gmail.users.messages.modify({
    userId,
    id: first.id!,
    requestBody: { addLabelIds: [reviewed.id!], removeLabelIds: ["UNREAD"] },
  });
  log(`Labeled + marked read.`);

  // 4. Archive (remove INBOX).
  await gmail.users.messages.modify({ userId, id: first.id!, requestBody: { removeLabelIds: ["INBOX"] } });
  log(`Archived.`);

  // 5. Reply in-thread.
  const replyRaw = b64urlEncode(
    [
      `From: sandbox.user@gmail.com`,
      `To: ${from}`,
      `Subject: Re: ${subject.replace(/^Re:\s*/i, "")}`,
      `In-Reply-To: ${msgId ?? ""}`,
      `References: ${msgId ?? ""}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      `Thanks — reviewed and handled by the agent. (This never left the machine.)`,
    ].join("\r\n"),
  );
  const reply = await gmail.users.messages.send({
    userId,
    requestBody: { raw: replyRaw, threadId: first.threadId },
  });
  log(`Replied in thread ${reply.data.threadId} (new message ${reply.data.id}).`);
  log(`Done. Open ${ROOT} and the Activity panel to see all of the above logged.`);
}

main().catch((e) => {
  console.error("demo-agent failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
