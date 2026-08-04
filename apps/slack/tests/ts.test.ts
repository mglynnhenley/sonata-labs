import { describe, it, expect } from "vitest";
import { makeEmptyDb } from "./helpers";
import { formatTs, msToTs, tsToMs, bumpTs, compareTs, mintTs } from "@/lib/slack/ts";
import { insertMessage } from "@/lib/store/messages";

describe("ts helpers", () => {
  it("formats seconds.micros with six-digit micros", () => {
    expect(formatTs(1699999999, 1200)).toBe("1699999999.001200");
    expect(formatTs(1699999999, 0)).toBe("1699999999.000000");
  });

  it("round-trips ms", () => {
    const ms = Date.UTC(2026, 6, 28, 9, 0, 0) + 123;
    expect(tsToMs(msToTs(ms))).toBe(ms);
  });

  it("bumpTs adds one microsecond and carries", () => {
    expect(bumpTs("1699999999.000001")).toBe("1699999999.000002");
    expect(bumpTs("1699999999.999999")).toBe("1700000000.000000");
  });

  it("lexical order equals numeric order", () => {
    const a = "1699999999.999999";
    const b = "1700000000.000000";
    expect(compareTs(a, b)).toBe(-1);
    expect(a < b).toBe(true);
  });

  it("mintTs never reuses or goes backwards", () => {
    const db = makeEmptyDb();
    const now = Date.UTC(2026, 6, 28, 9, 0, 0);
    const t1 = mintTs(db, "C1", now);
    insertMessage(db, { channelId: "C1", ts: t1, text: "a", rawJson: "{}" });
    // Same wall-clock instant → must mint strictly greater ts.
    const t2 = mintTs(db, "C1", now);
    expect(compareTs(t2, t1)).toBe(1);
    insertMessage(db, { channelId: "C1", ts: t2, text: "b", rawJson: "{}" });
    // Clock going BACKWARDS must still mint forward.
    const t3 = mintTs(db, "C1", now - 5000);
    expect(compareTs(t3, t2)).toBe(1);
    // Other channels are independent.
    const other = mintTs(db, "C2", now);
    expect(other).toBe(msToTs(now));
  });
});
