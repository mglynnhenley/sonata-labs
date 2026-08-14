import { describe, expect, it } from "vitest";
import type { WorldSeed } from "@sonata/core";
import { assembleCast, assembleWorld, companyDomain, generateWorld } from "../src/generate";
import type { CompleteJSON, CompleteJSONOptions } from "../src/llm";
import { DRAFT, NOW, SEEDS } from "./fixtures";
import { referencedPeople } from "./refs";

// A stub for the one model seam. Two calls, in order: the draft, then the twin
// seeds. Nothing here touches the network.
function stubComplete(): CompleteJSON & { prompts: string[] } {
  const prompts: string[] = [];
  const complete: CompleteJSON = async <T,>(opts: CompleteJSONOptions): Promise<T> => {
    prompts.push(opts.prompt);
    return (prompts.length === 1 ? DRAFT : SEEDS) as T;
  };
  return Object.assign(complete, { prompts });
}

function castIds(world: WorldSeed): Set<string> {
  return new Set(world.cast.map((p) => p.id));
}

describe("identity assembly", () => {
  it("puts colleagues on one company domain and outsiders on their own", () => {
    const cast = assembleCast(DRAFT);
    expect(companyDomain("Northwind Ledger")).toBe("northwindledger.com");
    // The outsider keeps their own employer's domain — an auditor writing from
    // the audited company's domain would be a tell.
    expect(cast.map((p) => p.email)).toEqual([
      "priya.raman@northwindledger.com",
      "marcus.bell@northwindledger.com",
      "gerald.pike@halloranpike.com",
    ]);
  });

  it("gives each person one id, one address and one Slack id", () => {
    const cast = assembleCast(DRAFT);
    expect(cast.map((p) => p.id)).toEqual(["priya", "marcus", "gerald"]);
    expect(cast.map((p) => p.slackUserId)).toEqual(["U01PRIYA", "U02MARCUS", "U03GERALD"]);
    expect(new Set(cast.map((p) => p.slackUserId)).size).toBe(cast.length);
  });

  it("keeps two people with the same first name apart", () => {
    const cast = assembleCast({
      ...DRAFT,
      people: [
        { name: "Priya Raman", org: "Northwind Ledger", role: "COS", relationship: "self", voice: "x" },
        { name: "Priya Shah", org: "Northwind Ledger", role: "Analyst", relationship: "peer", voice: "y" },
      ],
    });
    expect(cast.map((p) => p.id)).toEqual(["priya", "priya-2"]);
    expect(cast[0].email).not.toBe(cast[1].email);
  });
});

describe("assembleWorld", () => {
  const built = assembleWorld("a fintech before an audit", DRAFT, SEEDS, { now: NOW });

  it("is deterministic: the same draft always builds the same world", () => {
    const again = assembleWorld("a fintech before an audit", DRAFT, SEEDS, { now: NOW });
    expect(again).toEqual(built);
  });

  it("names the mailbox owner from the draft", () => {
    expect(built.world.mailboxOwner).toBe("priya");
    expect(built.id).toBe("northwind-ledger");
    expect(built.world.timezone).toBe("America/New_York");
  });

  it("references only people who exist — the whole point of one cast", () => {
    const ids = castIds(built.world);
    for (const ref of referencedPeople(built)) expect(ids.has(ref)).toBe(true);
    expect(referencedPeople(built)).not.toContain("sasha");
  });

  it("drops a thread whose only sender was invented", () => {
    expect(built.gmail.threads.map((t) => t.subject)).not.toContain("Entirely ghost thread");
  });

  it("orders thread messages oldest first and strips the Re: the model added", () => {
    const thread = built.gmail.threads.find((t) => t.subject.includes("SOC 2"))!;
    expect(thread.subject).toBe("SOC 2 evidence request");
    expect(thread.messages.map((m) => m.minutesAgo)).toEqual([2800, 1600, 200]);
  });

  it("normalizes labels and never leaves a thread out of every view", () => {
    const [soc, board] = built.gmail.threads.filter((t) => t.subject !== "Entirely ghost thread");
    expect(soc.labels).toEqual(["INBOX", "UNREAD", "Audit"]);
    expect(board.labels).toEqual(["INBOX"]);
  });

  it("puts the owner on every thread and in every channel", () => {
    for (const thread of built.gmail.threads) expect(thread.participants).toContain("priya");
    for (const channel of built.slack.channels) expect(channel.members).toContain("priya");
  });

  it("makes channel names something Slack would accept, and ids to match", () => {
    expect(built.slack.channels.map((c) => c.name)).toEqual(["audit-prep"]);
    expect(built.world.channels.map((c) => c.id)).toEqual(["C01AUDITPRE"]);
    expect(built.world.channels[0].members).toEqual(built.slack.channels[0].members);
  });

  it("never lets a thread reply predate its parent", () => {
    const message = built.slack.channels[0].messages.find((m) => m.text.includes("auditors"))!;
    expect(message.minutesAgo).toBe(600);
    expect(message.threadReplies).toHaveLength(1);
    expect(message.threadReplies![0].minutesAgo).toBe(600);
  });

  it("repairs calendar entries rather than dropping them", () => {
    const [standup, fieldwork] = built.calendar.events;
    // An unknown calendar name falls back to the primary one, a zero duration to
    // something a person could attend, and a malformed rule to no recurrence.
    expect(standup.calendarName).toBe("Priya Raman");
    expect(standup.durationMin).toBe(30);
    expect(fieldwork.recurrence).toBe("");
    expect(fieldwork.attendeePersonIds).toEqual(["priya", "gerald"]);
  });

  it("sorts events by when they happen", () => {
    const offsets = built.calendar.events.map((e) => e.startOffsetMin);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it("drops a CRM row that points at a company or a person nobody wrote", () => {
    // Two contacts named the same auditor and one named nobody; only the first
    // survives, and a deal at a company the seed never created goes with it.
    expect(built.attio.contacts.map((c) => c.personId)).toEqual(["gerald"]);
    expect(built.attio.deals.map((d) => d.name)).toEqual(["Vantage renewal"]);
    expect(built.attio.notes.map((n) => n.title)).toEqual(["Escalation call"]);
  });

  it("repairs a deal rather than dropping it: the stage and the owner both exist", () => {
    const [deal] = built.attio.deals;
    // "Negotiation" is not in this CRM's pipeline, and a deal parked at a stage
    // the twin has no status row for is a 400.
    expect(deal.stage).toBe("In Progress");
    // Owned by nobody becomes owned by the mailbox owner, because a deal has to
    // be owned by a workspace member.
    expect(deal.ownerPersonId).toBe("priya");
    expect(deal.contactPersonIds).toEqual(["gerald"]);
    expect(built.attio.tasks[0].assigneePersonId).toBe("priya");
  });

  it("splits a document paragraph at every newline and keeps the style on the first", () => {
    expect(built.googleDocs.documents.map((d) => d.title)).toEqual(["Evidence tracker"]);
    expect(built.googleDocs.documents[0].paragraphs).toEqual([
      { text: "Evidence tracker", namedStyleType: "TITLE" },
      { text: "Outstanding", namedStyleType: "HEADING_1" },
      { text: "Restore test — TBC", namedStyleType: "" },
    ]);
  });

  it("keeps an ad account inside what the API can express", () => {
    const [treasury, ghost] = built.googleAds.campaigns;
    expect(treasury.status).toBe("ENABLED");
    expect(treasury.channel).toBe("SEARCH");
    // More clicks than impressions is not a busy day, it is a broken row.
    expect(treasury.adGroups[0].dailyClicks).toBe(100);
    // A campaign with nothing to spend is not a state Google Ads has.
    expect(ghost.dailyBudget).toBe(1);
    expect(ghost.channel).toBe("SEARCH");
  });

  it("flattens a LinkedIn thread to the one level LinkedIn has", () => {
    const [post] = built.linkedin.posts;
    // Written by nobody, so written by the company page.
    expect(post.personId).toBe("");
    const [comment] = post.comments!;
    expect(comment.replies!.map((r) => r.text)).toEqual([
      "It is.",
      "Depth two, which does not exist.",
    ]);
    // A reply cannot predate the comment it answers.
    expect(comment.replies!.map((r) => r.minutesAgo)).toEqual([1000, 900]);
    // One reaction per person, and only people the page has heard of.
    expect(post.reactedByPersonIds).toEqual(["marcus"]);
  });

  it("leaves a draft with no engagement, the only state an unpublished post has", () => {
    const draft = built.linkedin.posts.find((p) => p.isDraft)!;
    expect(draft.comments).toEqual([]);
    expect(draft.reactedByPersonIds).toEqual([]);
  });

  it("drops a post on a colleague's own feed, which nothing downstream can read", () => {
    // The page and the mailbox owner are the only two feeds the snapshot, the
    // diff and the agent's tools can reach — LinkedIn has no directory to
    // enumerate an employer's people — so a colleague's post would be a row in
    // SQLite and nothing else. The two that survive are the page's and Priya's.
    expect(built.linkedin.posts.map((p) => p.personId)).toEqual(["", "priya"]);
    expect(built.linkedin.posts.map((p) => p.commentary)).not.toContain(
      "Posted by a colleague, on a feed nobody can read.",
    );
  });
});

describe("generateWorld", () => {
  it("runs exactly two model calls and hands the roster to the second", async () => {
    const complete = stubComplete();
    const generated = await generateWorld("a 12-person fintech, the week before an audit", {
      complete,
      now: NOW,
    });

    expect(complete.prompts).toHaveLength(2);
    expect(complete.prompts[0]).toContain("a 12-person fintech, the week before an audit");
    // The narrative pass must see the real ids, or it invents its own.
    expect(complete.prompts[1]).toContain("priya — Priya Raman");
    expect(complete.prompts[1]).toContain("MAILBOX OWNER");
    expect(generated.world.business.name).toBe("Northwind Ledger");
    expect(generated.generatedAtISO).toBe(new Date(NOW).toISOString());
  });

  it("produces the same world as assembling the same two outputs by hand", async () => {
    const generated = await generateWorld("x", { complete: stubComplete(), now: NOW });
    expect(generated).toEqual(assembleWorld("x", DRAFT, SEEDS, { now: NOW }));
  });

  it("reports progress for the dashboard's clone step", async () => {
    const lines: string[] = [];
    await generateWorld("x", { complete: stubComplete(), now: NOW, say: (m) => lines.push(m) });
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.join("\n")).toContain("Northwind Ledger");
  });
});
