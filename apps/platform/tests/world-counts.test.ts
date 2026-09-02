import { describe, expect, it } from "vitest";
import { episodeTwins } from "@sonata/core";
import { TEMPLATES as WORLD_TEMPLATES } from "@sonata/world";
import { actualCounts } from "@/lib/engine/clone";
import { TEMPLATES, assembleTemplate } from "../app/api/_lib/templates";

// WHAT A CLONE CONTAINS, on all five surfaces.
//
// `WorldCounts` is filled twice from two different directions — `plannedCounts`
// off a day's beats, `actualCounts` off the backlog a model wrote — and the two
// used to stop at the calendar. Now that a generated world seeds the CRM and the
// documents too, a number that stops at three surfaces is a company card
// describing part of the company it is next to.

describe("actualCounts", () => {
  it("counts every surface of a backlog, not the first three", () => {
    for (const template of WORLD_TEMPLATES) {
      const counts = actualCounts(template);
      expect(counts.threads, template.id).toBe(template.gmail.threads.length);
      expect(counts.channels, template.id).toBe(template.slack.channels.length);
      expect(counts.events, template.id).toBe(template.calendar.events.length);
      // The CRM's size is the whole pipeline, which is how @sonata/world's own
      // preview counts it: three record types a person would call "the CRM".
      expect(counts.records, template.id).toBe(
        template.attio.companies.length +
          template.attio.contacts.length +
          template.attio.deals.length,
      );
      expect(counts.documents, template.id).toBe(template.googleDocs.documents.length);
    }
  });

  it("finds something on every surface of every shipped world", () => {
    // The shipped worlds are what a first run gets, and a surface that came back
    // empty in all four of them would mean the templates were widened in the
    // type and not in the content.
    for (const template of WORLD_TEMPLATES) {
      const counts = actualCounts(template);
      for (const [what, n] of Object.entries(counts)) {
        expect(n, `${template.id}.${what}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("a template's planned day", () => {
  it("counts what the day creates on the later surfaces, and admits zero", () => {
    for (const template of TEMPLATES) {
      const { draft } = assembleTemplate(template);
      // None of the shipped days scripts a beat on the two later surfaces yet,
      // and 0 is the true answer to "how many records does this day open" — it
      // is not a stand-in for "we did not look".
      expect(draft.counts.records, template.id).toBe(0);
      expect(draft.counts.documents, template.id).toBe(0);
      // And the day's own surfaces still count, so a zero above is a fact about
      // the CRM rather than a counter that stopped working.
      expect(draft.counts.messages, template.id).toBeGreaterThan(0);
    }
  });

  it("lists the same twins the run will start", () => {
    for (const template of TEMPLATES) {
      const { spec, draft } = assembleTemplate(template);
      // The preview used to hold its own list of three surfaces while the engine
      // derived the real one from the beats and the checklist. A day that files
      // a note in the CRM would have shown two chips and started three twins.
      expect(draft.episode.twins, template.id).toEqual(episodeTwins(spec));
    }
  });
});
