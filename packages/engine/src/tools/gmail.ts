import type { TwinHttp } from "../http";
import {
  addressesIn,
  b64urlEncode,
  extractBodyText,
  forwardSubject,
  headerMap,
  replySubject,
  rfc822,
  type GmailMessage,
} from "../gmailMime";
import { fn, int, str, strList, type EngineTool, type ToolInput } from "./types";

// The twelve Gmail tools, carried over verbatim from the curated set in
// apps/gmail's src/lib/eval/agents.ts — the same names, the same descriptions,
// the same semantics — so a score from the mail-only eval and a score from a
// three-surface episode are measuring the same hand.
//
// The only change is the transport: these speak HTTP to the twin rather than
// going through googleapis, because a workspace package should not carry a
// 40 MB SDK to send twelve requests, and because the wire is the contract the
// twin actually promises.

const MAX_BODY = 4000;

export function gmailTools(http: TwinHttp, userId = "me"): EngineTool[] {
  const api = `/gmail/v1/users/${encodeURIComponent(userId)}`;
  let ownerAddress: string | undefined;

  /** The mailbox owner, as the From of anything the agent composes. */
  async function owner(): Promise<string> {
    if (!ownerAddress) {
      const profile = await http.get<{ emailAddress?: string }>(`${api}/profile`);
      ownerAddress = profile.emailAddress ?? "me";
    }
    return ownerAddress;
  }

  function describe(m: GmailMessage): Record<string, unknown> {
    const h = headerMap(m.payload);
    return {
      id: m.id,
      threadId: m.threadId,
      from: h.get("from") ?? "",
      to: h.get("to") ?? "",
      cc: h.get("cc") ?? "",
      date: h.get("date") ?? "",
      subject: h.get("subject") ?? "",
      labelIds: m.labelIds ?? [],
      body: extractBodyText(m.payload).slice(0, MAX_BODY),
    };
  }

  /** What a composed reply needs from the message it answers — one fetch, not three. */
  async function replyBasis(messageId: string) {
    const msg = await http.get<GmailMessage>(`${api}/messages/${encodeURIComponent(messageId)}`, {
      format: "full",
    });
    const h = headerMap(msg.payload);
    const msgId = h.get("message-id") ?? "";
    return {
      h,
      payload: msg.payload,
      threadId: msg.threadId,
      // Empty when the original carries no Message-ID; spread into the headers so
      // it simply contributes nothing in that case.
      threading: (msgId ? { "In-Reply-To": msgId, References: msgId } : {}) as Record<string, string>,
    };
  }

  function send(raw: string, threadId?: string) {
    return http.post<{ id?: string; threadId?: string }>(`${api}/messages/send`, {
      raw,
      ...(threadId ? { threadId } : {}),
    });
  }

  const tools: EngineTool[] = [
    {
      name: "list_messages",
      twin: "gmail",
      isMutation: false,
      def: fn(
        "list_messages",
        "List messages in the mailbox. Returns ids and thread ids only — call get_thread or " +
          "get_message to read content. Use a Gmail-style query (e.g. 'is:unread', " +
          "'from:x@y.com') or label ids to narrow the list.",
        {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query, e.g. 'is:unread'." },
            labelIds: {
              type: "array",
              items: { type: "string" },
              description: "Label ids to filter by, e.g. ['INBOX'].",
            },
            maxResults: { type: "integer", description: "Default 25." },
          },
        },
      ),
      async run(input: ToolInput) {
        const res = await http.get<{
          messages?: Array<{ id?: string; threadId?: string }>;
          resultSizeEstimate?: number;
        }>(`${api}/messages`, {
          q: input.query ? str(input.query) : undefined,
          labelIds: strList(input.labelIds),
          maxResults: int(input.maxResults, 25),
        });
        return { messages: res.messages ?? [], total: res.resultSizeEstimate ?? 0 };
      },
    },
    {
      name: "get_thread",
      twin: "gmail",
      isMutation: false,
      def: fn(
        "get_thread",
        "Read an entire conversation: every message in the thread with sender, date, labels " +
          "and body. Use this to understand history before acting.",
        { type: "object", properties: { threadId: { type: "string" } }, required: ["threadId"] },
      ),
      async run(input: ToolInput) {
        const res = await http.get<{ id?: string; messages?: GmailMessage[] }>(
          `${api}/threads/${encodeURIComponent(str(input.threadId))}`,
          { format: "full" },
        );
        const messages = (res.messages ?? []).map(describe);
        return { threadId: res.id, messageCount: messages.length, messages };
      },
    },
    {
      name: "get_message",
      twin: "gmail",
      isMutation: false,
      def: fn("get_message", "Read a single message: sender, recipients, date, labels and body.", {
        type: "object",
        properties: { messageId: { type: "string" } },
        required: ["messageId"],
      }),
      async run(input: ToolInput) {
        const msg = await http.get<GmailMessage>(
          `${api}/messages/${encodeURIComponent(str(input.messageId))}`,
          { format: "full" },
        );
        return describe(msg);
      },
    },
    {
      name: "list_labels",
      twin: "gmail",
      isMutation: false,
      def: fn("list_labels", "List all labels in the mailbox (system and user).", {
        type: "object",
        properties: {},
      }),
      async run() {
        const res = await http.get<{ labels?: Array<Record<string, unknown>> }>(`${api}/labels`);
        return {
          labels: (res.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })),
        };
      },
    },
    {
      name: "create_label",
      twin: "gmail",
      isMutation: true,
      def: fn("create_label", "Create a new user label and return its id.", {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      }),
      async run(input: ToolInput) {
        const res = await http.post<{ id?: string; name?: string }>(`${api}/labels`, {
          name: str(input.name),
        });
        return { id: res.id, name: res.name };
      },
    },
    {
      name: "modify_labels",
      twin: "gmail",
      isMutation: true,
      def: fn(
        "modify_labels",
        "Add and/or remove labels on a message. Use STARRED to star, IMPORTANT to mark " +
          "important, and remove UNREAD to mark as read.",
        {
          type: "object",
          properties: {
            messageId: { type: "string" },
            addLabelIds: { type: "array", items: { type: "string" } },
            removeLabelIds: { type: "array", items: { type: "string" } },
          },
          required: ["messageId"],
        },
      ),
      async run(input: ToolInput) {
        const res = await http.post<GmailMessage>(
          `${api}/messages/${encodeURIComponent(str(input.messageId))}/modify`,
          {
            addLabelIds: strList(input.addLabelIds),
            removeLabelIds: strList(input.removeLabelIds),
          },
        );
        return { id: res.id, labelIds: res.labelIds ?? [] };
      },
    },
    {
      name: "archive",
      twin: "gmail",
      isMutation: true,
      def: fn(
        "archive",
        "Archive a message — removes it from the inbox. Use for things needing no action.",
        { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"] },
      ),
      async run(input: ToolInput) {
        const res = await http.post<GmailMessage>(
          `${api}/messages/${encodeURIComponent(str(input.messageId))}/modify`,
          { removeLabelIds: ["INBOX"] },
        );
        return { id: res.id, labelIds: res.labelIds ?? [], archived: true };
      },
    },
    {
      name: "trash",
      twin: "gmail",
      isMutation: true,
      def: fn("trash", "Move a message to trash. Only for genuine junk.", {
        type: "object",
        properties: { messageId: { type: "string" } },
        required: ["messageId"],
      }),
      async run(input: ToolInput) {
        const res = await http.post<GmailMessage>(
          `${api}/messages/${encodeURIComponent(str(input.messageId))}/trash`,
        );
        return { id: res.id, labelIds: res.labelIds ?? [], trashed: true };
      },
    },
    {
      name: "send_reply",
      twin: "gmail",
      isMutation: true,
      def: fn(
        "send_reply",
        "Reply to a message in its thread. Recipient, subject and threading are derived from " +
          "the message you are replying to. Supply only the body text.",
        {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message being replied to." },
            body: { type: "string", description: "Plain-text reply body." },
          },
          required: ["messageId", "body"],
        },
      ),
      async run(input: ToolInput) {
        const { h, threadId, threading } = await replyBasis(str(input.messageId));
        const raw = b64urlEncode(
          rfc822(
            {
              From: await owner(),
              To: h.get("reply-to") || h.get("from") || "",
              Subject: replySubject(h.get("subject") ?? ""),
              ...threading,
            },
            str(input.body),
          ),
        );
        const sent = await send(raw, threadId);
        return { id: sent.id, threadId: sent.threadId, sent: true };
      },
    },
    {
      name: "reply_all",
      twin: "gmail",
      isMutation: true,
      def: fn(
        "reply_all",
        "Reply to everyone on a message: the sender plus everyone who was on To and Cc, minus " +
          "you. Threading and subject are derived. Use when the rest of the recipients need to " +
          "see the answer too; use send_reply when they do not.",
        {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message being replied to." },
            body: { type: "string", description: "Plain-text reply body." },
          },
          required: ["messageId", "body"],
        },
      ),
      async run(input: ToolInput) {
        const { h, threadId, threading } = await replyBasis(str(input.messageId));
        const me = await owner();
        const to = h.get("reply-to") || h.get("from") || "";
        // Everyone else the original went to, minus the owner (never Cc yourself)
        // and minus whoever is already on To — a duplicated recipient is the
        // classic reply-all mistake, and it is case-insensitive in practice.
        const seen = new Set([me, ...addressesIn(to)].map((a) => a.toLowerCase()));
        const cc: string[] = [];
        for (const addr of [...addressesIn(h.get("to") ?? ""), ...addressesIn(h.get("cc") ?? "")]) {
          if (seen.has(addr.toLowerCase())) continue;
          seen.add(addr.toLowerCase());
          cc.push(addr);
        }
        const raw = b64urlEncode(
          rfc822(
            {
              From: me,
              To: to,
              Cc: cc.join(", "),
              Subject: replySubject(h.get("subject") ?? ""),
              ...threading,
            },
            str(input.body),
          ),
        );
        const sent = await send(raw, threadId);
        return { id: sent.id, threadId: sent.threadId, to, cc, sent: true };
      },
    },
    {
      name: "forward",
      twin: "gmail",
      isMutation: true,
      def: fn(
        "forward",
        "Forward a message to someone else. The original is quoted below your note — use the " +
          "note to say why you are passing it on.",
        {
          type: "object",
          properties: {
            messageId: { type: "string", description: "The message being forwarded." },
            to: { type: "string", description: "Recipient address." },
            body: {
              type: "string",
              description: "Optional note, placed above the quoted original.",
            },
          },
          required: ["messageId", "to"],
        },
      ),
      async run(input: ToolInput) {
        const { h, payload } = await replyBasis(str(input.messageId));
        const subject = h.get("subject") ?? "";
        const note = str(input.body).trim();
        const quoted = [
          "---------- Forwarded message ----------",
          `From: ${h.get("from") ?? ""}`,
          `Date: ${h.get("date") ?? ""}`,
          `Subject: ${subject}`,
          `To: ${h.get("to") ?? ""}`,
          "",
          extractBodyText(payload),
        ].join("\r\n");
        const raw = b64urlEncode(
          rfc822(
            { From: await owner(), To: str(input.to), Subject: forwardSubject(subject) },
            note ? `${note}\r\n\r\n${quoted}` : quoted,
          ),
        );
        // No In-Reply-To/References and no threadId: a forward goes to a third
        // party, so it starts its own thread. Threading it onto the original would
        // make the observer read it as a reply to the sender, who never received
        // anything.
        const sent = await send(raw);
        return { id: sent.id, threadId: sent.threadId, to: str(input.to), sent: true };
      },
    },
    {
      name: "create_draft",
      twin: "gmail",
      isMutation: true,
      def: fn(
        "create_draft",
        "Write a message and save it as a draft WITHOUT sending it. Use when the answer needs " +
          "the user's own eyes or signature before it goes out — they get the words, you do " +
          "not commit them.",
        {
          type: "object",
          properties: {
            messageId: {
              type: "string",
              description:
                "The message being replied to. Supplies recipient, subject and threading — " +
                "omit for a brand-new message.",
            },
            to: { type: "string", description: "Recipient address. Defaults to the sender." },
            subject: { type: "string", description: "Defaults to 'Re: <original subject>'." },
            body: { type: "string", description: "Plain-text body." },
          },
          required: ["body"],
        },
      ),
      async run(input: ToolInput) {
        const basis = input.messageId ? await replyBasis(str(input.messageId)) : undefined;
        const h = basis?.h;
        const raw = b64urlEncode(
          rfc822(
            {
              From: await owner(),
              To: str(input.to) || h?.get("reply-to") || h?.get("from") || "",
              Subject: str(input.subject) || (h ? replySubject(h.get("subject") ?? "") : ""),
              ...(basis?.threading ?? {}),
            },
            str(input.body),
          ),
        );
        const res = await http.post<{ id?: string; message?: GmailMessage }>(`${api}/drafts`, {
          message: { raw, ...(basis?.threadId ? { threadId: basis.threadId } : {}) },
        });
        // `sent: false` is spelled out because the whole point of this tool is that
        // holding a reply reads differently from firing it — and that difference is
        // an autonomy signal the judge scores on.
        return {
          draftId: res.id,
          id: res.message?.id,
          threadId: res.message?.threadId,
          sent: false,
        };
      },
    },
  ];

  return tools;
}
