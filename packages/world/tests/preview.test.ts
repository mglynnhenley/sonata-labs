import { describe, expect, it } from "vitest";
import { assembleWorld } from "../src/generate";
import { previewWorld } from "../src/preview";
import { TEMPLATES } from "../src/templates/index";
import { DRAFT, NOW, SEEDS } from "./fixtures";

// The preview is what a user reads before they commit to loading a world into
// three apps, so its numbers have to be the numbers that will actually appear.
// Everything here counts the seeds a second way and compares.

const built = assembleWorld("a fintech before an audit", DRAFT, SEEDS, { now: NOW });

describe("previewWorld", () => {
  const preview = previewWorld(built);

  it("counts what survived assembly, not what the model wrote", () => {
    // The fixture's ghost thread and ghost sender are gone by now; the preview
    // must not promise the two messages that went with them.
    expect(preview.people).toBe(3);
    expect(preview.threads).toBe(2);
    expect(preview.messages).toBe(4);
    expect(preview.channels).toBe(1);
    expect(preview.slackMessages).toBe(3);
    expect(preview.events).toBe(2);
    // Two companies, one surviving contact and one surviving deal.
    expect(preview.records).toBe(4);
    expect(preview.documents).toBe(1);
    expect(preview.campaigns).toBe(2);
    expect(preview.posts).toBe(2);
  });

  it("names the later surfaces, and only when the world carries them", () => {
    expect(preview.sentence).toContain(
      "Also 4 CRM records, 1 document, 2 ad campaigns, 2 LinkedIn posts.",
    );
    // A company that runs no advertising is a real company, not a failed
    // generation, so nothing is claimed about a surface with nothing on it.
    const quiet = previewWorld({ ...built, googleAds: { campaigns: [] } });
    expect(quiet.sentence).not.toContain("ad campaign");
    expect(quiet.sentence).toContain("Also 4 CRM records, 1 document, 2 LinkedIn posts.");
  });

  it("names the identity the agent will operate as", () => {
    expect(preview.business).toBe("Northwind Ledger");
    expect(preview.owner).toBe("Priya Raman — Chief of Staff");
    expect(preview.sentence).toContain("Northwind Ledger");
    expect(preview.sentence).toContain("You are Priya Raman.");
  });

  it("reads as English for one of anything", () => {
    const single = previewWorld({
      ...built,
      gmail: { threads: [built.gmail.threads[0]] },
    });
    expect(single.sentence).toContain("1 email thread (");
    expect(single.sentence).not.toContain("1 email threads");
  });

  it("reports how far back the world reaches", () => {
    // Oldest fixture item is an email 2800 minutes back; the furthest-out event
    // is four days ahead and must not be read as history.
    expect(preview.spanDays).toBe(2);
    expect(previewWorld({ ...built, calendar: { calendars: [], events: [] } }).spanDays).toBe(2);
  });

  it("survives a world with nothing in it rather than dividing by zero", () => {
    const empty = previewWorld({
      ...built,
      gmail: { threads: [] },
      slack: { channels: [] },
      calendar: { calendars: [], events: [] },
    });
    expect(empty.spanDays).toBe(0);
    expect(empty.sentence).toContain("0 email threads");
  });
});

describe("previewWorld over the shipped templates", () => {
  for (const template of TEMPLATES) {
    it(`agrees with a hand count of ${template.id}`, () => {
      const preview = previewWorld(template);
      expect(preview.people).toBe(template.world.cast.length);
      expect(preview.threads).toBe(template.gmail.threads.length);
      expect(preview.messages).toBe(
        template.gmail.threads.reduce((n, t) => n + t.messages.length, 0),
      );
      expect(preview.channels).toBe(template.slack.channels.length);
      expect(preview.slackMessages).toBe(
        template.slack.channels.reduce(
          (n, c) => n + c.messages.reduce((m, msg) => m + 1 + (msg.threadReplies?.length ?? 0), 0),
          0,
        ),
      );
      expect(preview.events).toBe(template.calendar.events.length);
      // A template that previews as a couple of days of history is one a user
      // will believe; one that reaches back a month is a fixture.
      expect(preview.spanDays).toBeGreaterThanOrEqual(1);
      expect(preview.spanDays).toBeLessThanOrEqual(7);
    });
  }
});
