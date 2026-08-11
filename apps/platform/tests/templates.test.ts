import { describe, expect, it } from "vitest";
import { checklistShortfall } from "@sonata/world";
import { DEFAULT_MODELS, findModel } from "@/lib/models";
import { TEMPLATES, assembleTemplate, templateSummaries } from "../app/api/_lib/templates";

// THE DAY LENGTH THE USER PICKED IS THE DAY THEY GET.
//
// A description that the model could not turn into a scorable day falls back to
// the nearest template, and that fallback used to assemble the template against
// its OWN clock: pick "Short, 3 hours", describe a business, and a 24-tick day
// came back. Nothing said so. The preview showed six hours because the day WAS
// six hours — the answer was to a question nobody asked.
//
// So the clock travels with the request. The rest of this file is the other half
// of that claim: a shortened template day still has to be a day worth running.

/** The tick every DAY_LENGTHS entry is measured in: 15 simulated minutes. */
const SHORT = 12; // "Short — 3 hours, a morning"

describe("assembleTemplate", () => {
  it("assembles against the clock it was asked for", () => {
    for (const template of TEMPLATES) {
      const { spec, draft } = assembleTemplate(template, { ticks: SHORT });
      expect(spec.clock.ticks, template.id).toBe(SHORT);
      // The preview reads the draft, the engine reads the spec. They are the
      // same clock or the preview is lying about what will run.
      expect(draft.episode.ticks, template.id).toBe(SHORT);
    }
  });

  it("keeps the template's own clock when no length was asked for", () => {
    for (const template of TEMPLATES) {
      const { spec } = assembleTemplate(template);
      // The Templates grid is not a fallback: choosing that card IS choosing its
      // day, and the card's "6h day" has to keep meaning what it says.
      expect(spec.clock.ticks, template.id).toBe(template.ticks);
    }
    for (const summary of templateSummaries()) {
      const template = TEMPLATES.find((t) => t.id === summary.id);
      expect(summary.ticks, summary.id).toBe(template?.ticks);
    }
  });

  it("still fires every beat of a shortened day, inside its horizon", () => {
    for (const template of TEMPLATES) {
      const long = assembleTemplate(template);
      const short = assembleTemplate(template, { ticks: SHORT });

      // Nothing is dropped. Beats scheduled past the shorter horizon are pulled
      // onto its last tick, which is why the checklist below still binds: a
      // dropped beat would take its criterion with it.
      expect(short.spec.beats.length, template.id).toBe(long.spec.beats.length);
      for (const beat of short.spec.beats) {
        expect(beat.tick, `${template.id} ${beat.ref ?? beat.kind}`).toBeLessThan(SHORT);
        expect(beat.tick, `${template.id} ${beat.ref ?? beat.kind}`).toBeGreaterThanOrEqual(0);
      }
      // Beats keep their order, so a `move` never lands before the invite it
      // reschedules even when both are pushed onto the last tick.
      const ticks = short.spec.beats.map((b) => b.tick);
      expect([...ticks].sort((a, b) => a - b), template.id).toEqual(ticks);
    }
  });

  it("still scores a shortened day against the same checklist", () => {
    for (const template of TEMPLATES) {
      const long = assembleTemplate(template);
      const short = assembleTemplate(template, { ticks: SHORT });

      // The clock decides how long the day is, never what counts as doing the
      // job. Both halves of that: the same criteria bind, and the same ones are
      // rejected for reasons that have nothing to do with the clock.
      expect(
        short.spec.success.checklist.map((c) => c.description),
        template.id,
      ).toEqual(long.spec.success.checklist.map((c) => c.description));
      expect(
        short.unbound.map((c) => c.description),
        template.id,
      ).toEqual(long.unbound.map((c) => c.description));

      // And a shortened day is still a day worth scoring: `assembleTemplate` is
      // the fallback for a description the model could not turn into one, so a
      // template that stopped scoring at a shorter clock would hand back a
      // verdict about nothing.
      expect(checklistShortfall(short.spec.success.checklist), template.id).toBeUndefined();

      // Every criterion that names a beat still names one that will fire.
      const refs = new Set(short.spec.beats.map((b) => b.ref).filter(Boolean));
      for (const criterion of short.spec.success.checklist) {
        if (criterion.ref) expect(refs.has(criterion.ref), `${template.id}/${criterion.ref}`).toBe(true);
      }
    }
  });

  it("budgets the day it was asked for, not the one the template was written as", () => {
    const [template] = TEMPLATES;
    expect(template).toBeDefined();
    if (!template) return;
    const long = assembleTemplate(template).spec.termination;
    const short = assembleTemplate(template, { ticks: SHORT }).spec.termination;

    // The cost guard scales off the clock. Left on the template's clock, a
    // 3-hour day was handed a 6-hour day's budget — a runaway with twice the
    // room to run away in. (The wall-clock guard has a 20-minute floor that both
    // of these lengths sit under, so it is the same number either way.)
    expect(short?.maxCostUsd ?? 0).toBeLessThan(long?.maxCostUsd ?? 0);
    expect(short?.maxWallClockMs ?? 0).toBeLessThanOrEqual(long?.maxWallClockMs ?? 0);
  });

  it("says it was assembled offline, and why, without inventing anything else", () => {
    const [template] = TEMPLATES;
    expect(template).toBeDefined();
    if (!template) return;
    const { draft } = assembleTemplate(template, { ticks: SHORT, offlineReason: "the model 500'd" });
    expect(draft.offline).toBe(true);
    expect(draft.offlineReason).toBe("the model 500'd");
  });
});

describe("the default judge", () => {
  it("is a model that answers rather than one that thinks", () => {
    // Not a style preference. Sonnet 5 reasons whether or not it is asked to,
    // and the two automatic passes on this repo's disk that produced no
    // diagnosis at all were exactly that: the whole ceiling spent thinking.
    // Haiku 4.5 does no reasoning unless a request asks for it, and nothing in
    // this product asks. See `DEFAULT_MODELS` for the numbers.
    expect(DEFAULT_MODELS.judge).toBe("anthropic/claude-haiku-4.5");
    expect(findModel(DEFAULT_MODELS.judge)).toBeDefined();
  });
});
