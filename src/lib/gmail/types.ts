import type { gmail_v1 } from "googleapis";

// Gmail resource shapes come straight from the official SDK's type defs
// (type-only import — no runtime dependency on googleapis in the server).
export type GmailMessage = gmail_v1.Schema$Message;
export type GmailPayload = gmail_v1.Schema$MessagePart;
export type GmailHeader = gmail_v1.Schema$MessagePartHeader;
export type GmailLabel = gmail_v1.Schema$Label;
export type GmailThread = gmail_v1.Schema$Thread;
export type GmailProfile = gmail_v1.Schema$Profile;
export type GmailDraft = gmail_v1.Schema$Draft;

// Row as stored in the messages table.
export interface MessageRow {
  id: string;
  thread_id: string;
  internal_date: number;
  history_id: number;
  size_estimate: number;
  snippet: string;
  subject: string | null;
  from_addr: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  bcc_addrs: string | null;
  rfc822_message_id: string | null;
  in_reply_to: string | null;
  has_attachment: number;
  body_text: string | null;
  raw_json: string;
  raw_rfc822: string | null;
  is_sandbox_created: number;
}

export interface LabelRow {
  id: string;
  name: string;
  type: string;
  message_list_visibility: string | null;
  label_list_visibility: string | null;
  color_json: string | null;
}

export type MessageFormat = "full" | "metadata" | "minimal" | "raw";

// Gmail's system labels. TRASH/SPAM are excluded from default listings.
export const SYSTEM_LABELS = [
  "INBOX",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "STARRED",
  "IMPORTANT",
  "UNREAD",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
] as const;

export type SystemLabel = (typeof SYSTEM_LABELS)[number];
