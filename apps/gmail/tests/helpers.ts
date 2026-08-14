import { afterAll } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { insertMessage } from "@/lib/store/messages";
import { setMeta } from "@/lib/store/meta";
import { buildPayload, computeSnippet } from "@/lib/gmail/mime";
import type { GmailMessage } from "@/lib/gmail/types";

const schema = readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8");

export interface TestMsg {
  id: string;
  threadId?: string;
  from: string;
  to?: string;
  subject: string;
  body?: string;
  labels: string[];
  date: number; // epoch ms
  hasAttachment?: boolean;
}

const TEST_LABELS: Array<[string, string, "system" | "user"]> = [
  ["INBOX", "INBOX", "system"],
  ["SENT", "SENT", "system"],
  ["TRASH", "TRASH", "system"],
  ["SPAM", "SPAM", "system"],
  ["STARRED", "STARRED", "system"],
  ["IMPORTANT", "IMPORTANT", "system"],
  ["UNREAD", "UNREAD", "system"],
  ["CATEGORY_PROMOTIONS", "CATEGORY_PROMOTIONS", "system"],
  ["Label_1", "Work", "user"],
  ["Label_2", "Travel", "user"],
];

export function makeTestDb(msgs: TestMsg[]): Database.Database {
  const db = trackDb(new Database(":memory:"));
  db.exec(schema);
  const insLabel = db.prepare(
    "INSERT INTO labels (id, name, type, message_list_visibility, label_list_visibility) VALUES (?, ?, ?, 'show', 'labelShow')",
  );
  for (const [id, name, type] of TEST_LABELS) insLabel.run(id, name, type);
  setMeta(db, "profile_email", "test@sandbox.local");

  let history = 1;
  for (const m of msgs) {
    const payload = buildPayload({
      from: m.from,
      to: m.to ?? "test@sandbox.local",
      subject: m.subject,
      date: new Date(m.date),
      text: m.body ?? "",
    });
    const resource: GmailMessage = {
      id: m.id,
      threadId: m.threadId ?? m.id,
      snippet: computeSnippet(m.body ?? ""),
      historyId: String(history),
      internalDate: String(m.date),
      sizeEstimate: 100,
      payload,
    };
    insertMessage(db, {
      id: m.id,
      threadId: m.threadId ?? m.id,
      internalDate: m.date,
      historyId: history++,
      sizeEstimate: 100,
      snippet: computeSnippet(m.body ?? ""),
      subject: m.subject,
      fromAddr: m.from,
      toAddrs: m.to ?? "test@sandbox.local",
      hasAttachment: m.hasAttachment,
      bodyText: m.body ?? "",
      rawJson: JSON.stringify(resource),
      labelIds: m.labels,
    });
  }
  return db;
}

const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

// A small, fixed corpus used across search tests.
export const CORPUS: TestMsg[] = [
  {
    id: "aaa1",
    from: "Priya Nair <priya@acme.co>",
    subject: "Quarterly report is ready",
    body: "revenue is up this quarter, please review the numbers",
    labels: ["INBOX", "UNREAD", "STARRED", "Label_1"],
    date: NOW - 1 * DAY,
  },
  {
    id: "aaa2",
    from: "GitHub <notifications@github.com>",
    subject: "Re: Flaky test in checkout",
    body: "reproduced the race condition locally",
    labels: ["INBOX", "IMPORTANT"],
    date: NOW - 2 * DAY,
  },
  {
    id: "aaa3",
    from: "newsletter@theverge.com",
    subject: "Big tech announcements today",
    body: "new laptops and a foldable phone",
    labels: ["INBOX", "CATEGORY_PROMOTIONS"],
    date: NOW - 5 * DAY,
  },
  {
    id: "aaa4",
    from: "me@sandbox.local",
    to: "priya@acme.co",
    subject: "Re: Quarterly report is ready",
    body: "thanks, looks good to me",
    labels: ["SENT"],
    date: NOW - 10 * DAY,
  },
  {
    id: "aaa5",
    from: "spammer@bad.example",
    subject: "You won a prize",
    body: "click here to claim",
    labels: ["SPAM"],
    date: NOW - 3 * DAY,
  },
  {
    id: "aaa6",
    from: "old@oldnews.example",
    subject: "We miss you",
    body: "come back for a discount",
    labels: ["TRASH"],
    date: NOW - 40 * DAY,
  },
  {
    id: "aaa7",
    from: "Booking <noreply@booking.com>",
    subject: "Your trip to Lisbon",
    body: "check-in details enclosed",
    labels: ["INBOX", "Label_2"],
    date: NOW - 8 * DAY,
    hasAttachment: true,
  },
];

// Every SQLite handle a test opens is closed when its FILE ends.
//
// better-sqlite3 is a native addon: a handle left to the garbage collector is
// finalized during worker teardown, and if Node has already torn the
// environment down the destructor trips `Assertion failed: (env) != nullptr`
// and kills the worker. Every test passes and the run still exits 1, which is
// the worst possible way for this to present. Registering the hook here means a
// file gets the cleanup simply by importing the fixtures it was going to import
// anyway. It is afterAll and not afterEach because several suites open one
// database per file and share it across their cases.
const openHandles = new Set<Database.Database>();

/** Track a handle a test opened directly, so it is closed with the rest. */
export function trackDb<T extends Database.Database>(db: T): T {
  openHandles.add(db);
  return db;
}

afterAll(() => {
  for (const db of openHandles) {
    try {
      db.close();
    } catch {
      // Already closed by the test, or by a reset that swapped the file. Either
      // way there is nothing left to release.
    }
  }
  openHandles.clear();
});
