import { describe, expect, it } from "vitest";
import type { WorldSeed } from "@sonata/core";
import {
  assembleCast,
  assembleWorld,
  companyDomain,
  generateWorld,
  mergeStorylines,
  type StorylineWrite,
} from "../src/generate";
import type { CompleteJSON, CompleteJSONOptions } from "../src/llm";
import { AMBIENT, BOARD, BUSINESS, DRAFT, NOW, RENEWAL, SEEDS, SPINE, WRITES } from "./fixtures";
import { referencedPeople } from "./refs";

/**
 * A stub for the one model seam, answering by SCHEMA rather than by call order:
 * the storyline writers run in parallel, so their order is whatever the event
 * loop decides and a stub that counted calls would be testing that. Nothing here
 * touches the network.
 */
function stubComplete(
  fail: (schemaName: string, prompt: string) => string | undefined = () => undefined,
): CompleteJSON & { calls: CompleteJSONOptions[] } {
  const calls: CompleteJSONOptions[] = [];
  const complete: CompleteJSON = async <T,>(opts: CompleteJSONOptions): Promise<T> => {
    calls.push(opts);
    const name = opts.schemaName ?? "";
    const boom = fail(name, opts.prompt);
    if (boom) throw new Error(boom);
    if (name === "world_draft") return DRAFT as T;
    if (name === "world_spine") return SPINE as T;
    if (name === "ambient_seeds") return AMBIENT as T;
    if (name === "business_systems") return BUSINESS as T;
    if (name === "storyline_seeds") {
      const write = WRITES.find((w) => opts.prompt.includes(`YOUR STORYLINE — ${w.storylineId}:`));
      if (!write) throw new Error(`no fixture for this storyline prompt:\n${opts.prompt}`);
      return write.seeds as T;
    }
    throw new Error(`unexpected schema "${name}"`);
  };
  return Object.assign(complete, { calls });
}

function prompts(complete: { calls: CompleteJSONOptions[] }, schemaName: string): string[] {
  return complete.calls.filter((c) => c.schemaName === schemaName).map((c) => c.prompt);
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
});

describe("mergeStorylines", () => {
  const merged = mergeStorylines(SPINE, WRITES);

  it("is pure: same inputs, same company, whatever order the writers finished in", () => {
    const shuffled = [WRITES[2], WRITES[0], WRITES[1]];
    expect(mergeStorylines(SPINE, shuffled)).toEqual(merged);
    expect(mergeStorylines(SPINE, WRITES)).toEqual(merged);
  });

  it("does not touch what the writers handed it", () => {
    const before = JSON.stringify(WRITES);
    mergeStorylines(SPINE, WRITES);
    expect(JSON.stringify(WRITES)).toBe(before);
  });

  it("takes every channel from the spine, and its topic and purpose only from there", () => {
    expect(merged.seeds.slack.channels.map((c) => c.name)).toEqual([
      "audit-prep",
      "board",
      "random",
      // Off-roster, kept rather than deleted, and reported below.
      "ops",
    ]);
    const audit = merged.seeds.slack.channels[0];
    // The writer called it "#Audit Prep"; one channel, named by the spine.
    expect(audit.purpose).toBe("Evidence and gaps");
    expect(audit.messages).toHaveLength(1);
    expect(merged.warnings).toContain(
      "the ambient noise posted in #ops, which is not on the spine's roster.",
    );
  });

  it("keeps one meeting when two writers both invented it, with both guest lists", () => {
    const kickoffs = merged.seeds.calendar.events.filter((e) => e.summary === "Fieldwork kickoff");
    expect(kickoffs).toHaveLength(1);
    expect(kickoffs[0].attendeePersonIds).toEqual(["gerald", "priya"]);
    expect(merged.warnings.join("\n")).toContain('both scheduled "Fieldwork kickoff"');
  });

  it("caps how deep the double-bookings stack", () => {
    const summaries = merged.seeds.calendar.events.map((e) => e.summary);
    expect(summaries).not.toContain("Board meeting");
    expect(merged.warnings.join("\n")).toContain('dropped "Board meeting"');
  });

  it("measures a clash with the length the finished calendar gives a meeting", () => {
    // A writer that sizes an offsite at 1440 minutes gets ten hours in the
    // world, so a meeting fifteen hours out does not clash with it. Measuring
    // the clash against the unclamped number instead dropped that meeting for a
    // double-booking the world never has — the one place code throws writing
    // away, doing it on a calendar nobody would ever see.
    const day = (summary: string, startOffsetMin: number, durationMin: number) => ({
      summary,
      calendarName: "Priya Raman",
      startOffsetMin,
      durationMin,
      attendeePersonIds: ["priya"],
      location: "",
      recurrence: "",
      description: "",
    });
    const out = mergeStorylines(SPINE, [
      {
        storylineId: "renewal",
        seeds: { threads: [], channels: [], events: [day("Offsite", 0, 1440)] },
      },
      {
        storylineId: "board",
        seeds: {
          threads: [],
          channels: [],
          events: [day("All-day workshop", 30, 1440), day("Board review", 900, 60)],
        },
      },
    ]);
    expect(out.seeds.calendar.events.map((e) => e.summary)).toEqual([
      "Offsite",
      "All-day workshop",
      "Board review",
    ]);
    expect(out.warnings.join("\n")).not.toContain("dropped");
  });

  it("reports a fact spelled a writer's own way, and leaves the prose alone", () => {
    expect(merged.warnings).toContain(
      '"Board pack, draft 3" wrote "inv 2291" where the disputed invoice is "INV-2291". Left as written.',
    );
    const board = merged.seeds.gmail.threads.find((t) => t.subject === "Board pack, draft 3")!;
    expect(board.messages[0].body).toBe("inv 2291 needs a line in there. M");
  });

  it("reports a fact a storyline was given and never wrote", () => {
    expect(merged.warnings).toContain(
      '"Board pack, draft 3" turns on the fieldwork date ("Tuesday 14 April") and never writes it. Left as written.',
    );
  });

  it("reports somebody writing a fact they were never told", () => {
    expect(merged.warnings).toContain(
      'marcus writes the disputed invoice ("INV-2291") but is not one of the people who know it. Left as written.',
    );
  });

  it("names the ambient noise, so nothing downstream can depend on it", () => {
    expect(merged.ambient).toEqual({ threads: ["Coffee machine"], events: ["All-hands"] });
  });

  it("merges two writers who landed on the same subject into one thread", () => {
    const twice: StorylineWrite[] = [
      { storylineId: "renewal", seeds: RENEWAL },
      {
        storylineId: "board",
        seeds: {
          ...BOARD,
          threads: [{ ...RENEWAL.threads[0], subject: "Re: renewal terms", labels: ["INBOX"] }],
        },
      },
    ];
    const out = mergeStorylines(SPINE, twice);
    expect(out.seeds.gmail.threads.map((t) => t.subject)).toEqual(["Renewal terms"]);
    // The same message twice is one message; the warning is what survives.
    expect(out.seeds.gmail.threads[0].messages).toHaveLength(1);
    expect(out.warnings.join("\n")).toContain('both wrote a thread called "renewal terms"');
  });
});

describe("generateWorld", () => {
  it("runs one call per storyline, plus the spine and the noise", async () => {
    const complete = stubComplete();
    const generated = await generateWorld("a 12-person fintech, the week before an audit", {
      complete,
      now: NOW,
    });

    expect(complete.calls.map((c) => c.schemaName)).toEqual([
      "world_draft",
      "world_spine",
      "storyline_seeds",
      "storyline_seeds",
      "ambient_seeds",
      "business_systems",
    ]);
    expect(prompts(complete, "world_draft")[0]).toContain(
      "a 12-person fintech, the week before an audit",
    );
    // Every writer sees the real ids, or it invents its own.
    for (const prompt of complete.calls.slice(1).map((c) => c.prompt)) {
      expect(prompt).toContain("priya — Priya Raman");
      expect(prompt).toContain("MAILBOX OWNER");
    }
    expect(generated.world.business.name).toBe("Northwind Ledger");
    expect(generated.generatedAtISO).toBe(new Date(NOW).toISOString());
  });

  it("gives every writer the whole spine, and its own facts to spell", async () => {
    const complete = stubComplete();
    await generateWorld("x", { complete, now: NOW });
    const [renewal, board] = prompts(complete, "storyline_seeds");

    for (const prompt of [renewal, board, prompts(complete, "ambient_seeds")[0]]) {
      expect(prompt).toContain("#audit-prep — Evidence and gaps");
      expect(prompt).toContain('the disputed invoice: "INV-2291" (known by: priya, gerald)');
    }
    expect(renewal).toContain('spell these character for character, every time: "INV-2291"');
    expect(board).toContain('"INV-2291", "Tuesday 14 April"');
  });

  it("produces the same world as merging and assembling the same outputs by hand", async () => {
    const generated = await generateWorld("x", { complete: stubComplete(), now: NOW });
    const merged = mergeStorylines(SPINE, WRITES, BUSINESS);
    expect(generated).toEqual({
      ...assembleWorld("x", DRAFT, merged.seeds, { now: NOW }),
      warnings: merged.warnings,
      ambient: merged.ambient,
    });
  });

  it("loses one storyline to a failed writer, not the company", async () => {
    const lines: string[] = [];
    const generated = await generateWorld("x", {
      now: NOW,
      say: (m) => lines.push(m),
      complete: stubComplete((schema, prompt) =>
        schema === "storyline_seeds" && prompt.includes("YOUR STORYLINE — board:")
          ? "502 from the provider"
          : undefined,
      ),
    });

    expect(generated.warnings?.[0]).toBe(
      '"Board pack, draft 3" was never written: 502 from the provider',
    );
    expect(lines.join("\n")).toContain('lost "Board pack, draft 3"');
    // The rest of the company is still here.
    expect(generated.gmail.threads.map((t) => t.subject)).toContain("Renewal terms");
    expect(generated.gmail.threads.map((t) => t.subject)).toContain("Coffee machine");
  });

  it("loses the business systems to a failed pass 5, not the company", async () => {
    const lines: string[] = [];
    const generated = await generateWorld("x", {
      now: NOW,
      say: (m) => lines.push(m),
      complete: stubComplete((schema) =>
        schema === "business_systems" ? "502 from the provider" : undefined,
      ),
    });

    // The degradation contract, both halves: the CRM is EMPTY and the gap is the
    // same sentence in the warnings and on the terminal — an empty pipeline with
    // no warning would read as a company that plausibly has no deals.
    const warning = "the business systems were never written: 502 from the provider";
    expect(generated.warnings).toContain(warning);
    expect(lines).toContain(warning);
    expect(generated.attio.deals).toEqual([]);
    expect(generated.googleDocs.documents).toEqual([]);
    // The storyline core is untouched.
    expect(generated.gmail.threads.map((t) => t.subject)).toContain("Renewal terms");
    expect(generated.calendar.events.length).toBeGreaterThan(0);
  });

  it("reports progress per storyline, which is the first time this step can", async () => {
    const lines: string[] = [];
    await generateWorld("x", { complete: stubComplete(), now: NOW, say: (m) => lines.push(m) });
    expect(lines.join("\n")).toContain("2 storylines, 3 channels and 2 facts");
    expect(lines.join("\n")).toContain('wrote "The Halloran renewal"');
    expect(lines.join("\n")).toContain("wrote the ambient noise");
    expect(lines.join("\n")).toContain("Northwind Ledger");
  });

  it("says every warning, because a count is not a contradiction anyone can read", async () => {
    const lines: string[] = [];
    const generated = await generateWorld("x", {
      complete: stubComplete(),
      now: NOW,
      say: (m) => lines.push(m),
    });
    for (const warning of generated.warnings ?? []) expect(lines).toContain(warning);
    expect(lines.join("\n")).toContain('both scheduled "Fieldwork kickoff"');
  });

  it("names an empty plan rather than crashing on a spine that came back short", async () => {
    // Providers soft-honour structured output, which is why `completeJSON`
    // parses loosely. A spine missing a list used to take out every writer at
    // once inside the prompt builder, so the sentence written for this case
    // could never be the one anybody saw.
    const complete: CompleteJSON = async <T,>(opts: CompleteJSONOptions): Promise<T> =>
      (opts.schemaName === "world_draft" ? DRAFT : {}) as T;
    await expect(
      generateWorld("x", { complete, now: NOW, channels: ["ops"] }),
    ).rejects.toThrow(/came back with no storylines/);
  });

  it("keeps every pinned channel, so a day's beats still have somewhere to land", async () => {
    const complete = stubComplete();
    const generated = await generateWorld("x", {
      complete,
      now: NOW,
      channels: ["audit-prep", "escalations"],
    });
    expect(prompts(complete, "world_spine")[0]).toContain("#audit-prep, #escalations");
    expect(generated.slack.channels.map((c) => c.name)).toContain("escalations");
  });
});
