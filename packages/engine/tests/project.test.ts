import { describe, it, expect } from "vitest";
import type { ToolCall } from "@sonata/core";
import { summarize } from "../src/project";

// What the judge is handed for one tool call. A mutation that projects as a bare
// tool name with the id dropped is the defect these cases exist to catch: the
// judge cites this line as evidence, and "created record" on its own names
// nothing a diff can be checked against.

function call(over: Partial<ToolCall> = {}): ToolCall {
  return {
    seq: 1,
    name: "create_record",
    args: {},
    result: {},
    isMutation: true,
    startedAt: 0,
    endedAt: 1,
    actionIds: [],
    ...over,
  };
}

describe("summarize, for a mutation", () => {
  it("finds the id whichever field the twin returned it in", () => {
    expect(
      summarize(call({ name: "create_record", result: { object: "deals", recordId: "cd0f", title: "Acme renewal" } })),
    ).toBe('created record cd0f — titled "Acme renewal"');
    expect(summarize(call({ name: "create_note", result: { noteId: "n7", title: "Call notes" } }))).toBe(
      'logged note on n7 — titled "Call notes"',
    );
    expect(summarize(call({ name: "complete_task", result: { taskId: "t3", isCompleted: true } }))).toBe(
      "completed task t3",
    );
    expect(
      summarize(call({ name: "create_document", result: { documentId: "1aB", title: "Brief", revisionId: "r1" } })),
    ).toBe('created document 1aB — titled "Brief"');
    expect(
      summarize(call({ name: "replace_text", result: { documentId: "1aB", occurrencesChanged: 2 } })),
    ).toBe("replaced text in document 1aB — 2 occurrence(s)");
    expect(
      summarize(call({ name: "set_campaign_status", result: { campaignId: "991", status: "PAUSED" } })),
    ).toBe("switched campaign 991 — now PAUSED");
    expect(
      summarize(
        call({ name: "set_campaign_budget", result: { campaignId: "991", budgetId: "7", toMicros: 250_000_000 } }),
      ),
    ).toBe("re-budgeted campaign 991 — daily budget 250.00");
    expect(
      summarize(call({ name: "create_post", result: { urn: "urn:li:share:12", lifecycleState: "PUBLISHED" } })),
    ).toBe("published post urn:li:share:12");
    expect(
      summarize(
        call({
          name: "create_comment",
          result: { commentUrn: "urn:li:comment:(a,b)", postUrn: "urn:li:activity:12", isReply: true },
        }),
      ),
    ).toBe("commented on urn:li:comment:(a,b) — on urn:li:activity:12");
  });

  it("says what a publish did, without saying it twice on a fresh post", () => {
    expect(
      summarize(call({ name: "update_post", result: { urn: "urn:li:share:12", lifecycleState: "PUBLISHED" } })),
    ).toBe("edited post urn:li:share:12 — now published");
  });

  // A calendar event's `status` is "confirmed" on every write, which is not
  // news; a campaign's is the whole point of the call. Same field name, two
  // meanings, so it is read per tool rather than per field.
  it("does not turn a calendar event's own status into a finding", () => {
    expect(
      summarize(call({ name: "create_event", result: { id: "evt-1", status: "confirmed", start: "09:00" } })),
    ).toBe("created event evt-1 — starts 09:00");
  });

  it("still reports a failure the twin answered 200 with", () => {
    expect(summarize(call({ result: { ok: false, error: "no such object" } }))).toBe(
      "error: no such object",
    );
  });
});

describe("summarize, for a read", () => {
  it("collapses a read to its shape rather than its payload", () => {
    expect(
      summarize(
        call({
          name: "search_records",
          isMutation: false,
          result: { matches: 2, object: "deals", records: [{}, {}] },
        }),
      ),
    ).toBe("2 deals");
    expect(
      summarize(
        call({ name: "read_document", isMutation: false, result: { title: "Brief", paragraphs: [{}], revisionId: "r1" } }),
      ),
    ).toBe('"Brief": 1 paragraphs, r1');
    expect(
      summarize(call({ name: "list_campaigns", isMutation: false, result: { campaigns: [{}, {}, {}] } })),
    ).toBe("3 campaigns");
    expect(
      summarize(
        call({
          name: "get_post_engagement",
          isMutation: false,
          result: { entityUrn: "urn:li:activity:12", comments: 3, topLevelComments: 2, reactions: 9 },
        }),
      ),
    ).toBe("3 comments (2 top-level), 9 reactions on urn:li:activity:12");
  });
});
