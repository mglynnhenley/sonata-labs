import { describe, it, expect } from "vitest";
import type { GoogleAdsSnapshot } from "@sonata/core";
import { diffGoogleAds, renderGoogleAdsDiff } from "../src/adapters/google-ads";

// The ad account diff, offline. Two properties are worth pinning: that a
// campaign re-pointed at a different budget of the same size is reported at all
// — it used to count as untouched, which is a mutation reading as silence — and
// that spend never appears, because spend rises when the day happens rather than
// when the agent acts.

type Campaign = GoogleAdsSnapshot["campaigns"][number];

const snap = (campaigns: Campaign[]): GoogleAdsSnapshot => ({
  twin: "google-ads",
  capturedAt: 0,
  campaigns,
});

const campaign = (over: Partial<Campaign> & { campaignId: string }): Campaign => ({
  name: "Brand",
  status: "ENABLED",
  budgetId: "b1",
  budgetMicros: 15_000_000,
  costMicros: 0,
  ...over,
});

describe("google-ads diff", () => {
  it("reports a campaign moved onto another budget of the same amount", () => {
    const before = snap([campaign({ campaignId: "c1" })]);
    const after = snap([campaign({ campaignId: "c1", budgetId: "b2" })]);
    const diff = diffGoogleAds(before, after);

    expect(diff.budgetChanged).toEqual([
      {
        campaignId: "c1",
        name: "Brand",
        fromBudgetId: "b1",
        toBudgetId: "b2",
        fromMicros: 15_000_000,
        toMicros: 15_000_000,
      },
    ]);
    // And it is not also counted as a campaign nothing happened to.
    expect(diff.unchangedCount).toBe(0);
  });

  it("reports an amount that moved on the same budget", () => {
    const before = snap([campaign({ campaignId: "c1" })]);
    const after = snap([campaign({ campaignId: "c1", budgetMicros: 42_000_000 })]);
    expect(diffGoogleAds(before, after).budgetChanged[0]).toMatchObject({
      fromBudgetId: "b1",
      toBudgetId: "b1",
      fromMicros: 15_000_000,
      toMicros: 42_000_000,
    });
  });

  it("never reports spend, because the day spends the money and not the agent", () => {
    const before = snap([campaign({ campaignId: "c1", costMicros: 0 })]);
    const after = snap([campaign({ campaignId: "c1", costMicros: 318_940_000 })]);
    const diff = diffGoogleAds(before, after);

    expect(diff.budgetChanged).toEqual([]);
    expect(diff.statusChanged).toEqual([]);
    expect(diff.unchangedCount).toBe(1);
  });

  it("renders the two budget moves as the different things they are", () => {
    const before = snap([
      campaign({ campaignId: "c1", name: "Brand" }),
      campaign({ campaignId: "c2", name: "Prospecting" }),
      campaign({ campaignId: "c3", name: "Retargeting" }),
    ]);
    const after = snap([
      campaign({ campaignId: "c1", name: "Brand", budgetId: "b2" }),
      campaign({ campaignId: "c2", name: "Prospecting", budgetMicros: 42_000_000 }),
      campaign({ campaignId: "c3", name: "Retargeting", status: "PAUSED" }),
    ]);

    expect(renderGoogleAdsDiff(diffGoogleAds(before, after))).toBe(
      [
        '~ paused "Retargeting" (was ENABLED)',
        '~ "Brand" moved onto another budget of the same 15.00 a day (budget b1 → b2)',
        '~ "Prospecting" daily budget 15.00 → 42.00 (15000000 → 42000000 micros)',
        "0 campaign(s) untouched",
      ].join("\n"),
    );
  });
});
