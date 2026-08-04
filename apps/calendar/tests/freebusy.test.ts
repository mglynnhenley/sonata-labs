import { describe, it, expect } from "vitest";
import { mergeBusy, freeGaps, busyBlocks } from "@/lib/calendar/freebusy";
import { makeTestDb, CORPUS, PRIMARY_ID, TZ, OWNER, at } from "./helpers";
import { declinedEventIds, listEventRows } from "@/lib/store/events";

describe("mergeBusy", () => {
  it("merges overlapping blocks", () => {
    const out = mergeBusy(
      [
        { startMs: at(1, 14), endMs: at(1, 15, 30) },
        { startMs: at(1, 14, 30), endMs: at(1, 16) },
      ],
      at(1, 0),
      at(2, 0),
    );
    expect(out).toEqual([{ startMs: at(1, 14), endMs: at(1, 16) }]);
  });

  it("merges back-to-back blocks so no zero-width gap survives", () => {
    const out = mergeBusy(
      [
        { startMs: at(1, 9), endMs: at(1, 10) },
        { startMs: at(1, 10), endMs: at(1, 11) },
      ],
      at(1, 0),
      at(2, 0),
    );
    expect(out).toEqual([{ startMs: at(1, 9), endMs: at(1, 11) }]);
  });

  it("clips to the window and drops blocks outside it", () => {
    const out = mergeBusy(
      [
        { startMs: at(1, 8), endMs: at(1, 10) },
        { startMs: at(0, 8), endMs: at(0, 9) },
      ],
      at(1, 9),
      at(1, 17),
    );
    expect(out).toEqual([{ startMs: at(1, 9), endMs: at(1, 10) }]);
  });
});

describe("freeGaps", () => {
  it("returns the whole window when nothing is booked", () => {
    expect(freeGaps([], at(1, 9), at(1, 17))).toEqual([
      { startMs: at(1, 9), endMs: at(1, 17) },
    ]);
  });

  it("finds the gap between two meetings and the tails either side", () => {
    const gaps = freeGaps(
      [
        { startMs: at(1, 10), endMs: at(1, 11) },
        { startMs: at(1, 14), endMs: at(1, 15) },
      ],
      at(1, 9),
      at(1, 17),
    );
    expect(gaps).toEqual([
      { startMs: at(1, 9), endMs: at(1, 10) },
      { startMs: at(1, 11), endMs: at(1, 14) },
      { startMs: at(1, 15), endMs: at(1, 17) },
    ]);
  });

  it("returns nothing when the window is fully booked", () => {
    expect(freeGaps([{ startMs: at(1, 8), endMs: at(1, 18) }], at(1, 9), at(1, 17))).toEqual([]);
  });
});

describe("busyBlocks", () => {
  const window = { start: at(1, 0), end: at(2, 0) };

  function rowsFor(db: ReturnType<typeof makeTestDb>, from: number, to: number) {
    return listEventRows(db, {
      calendarId: PRIMARY_ID,
      timeMinMs: from,
      timeMaxMs: to,
      includeRecurringMasters: true,
    });
  }

  it("expands recurrence into busy time", () => {
    const db = makeTestDb(CORPUS);
    const busy = busyBlocks(rowsFor(db, window.start, window.end), window.start, window.end, TZ);
    // Tuesday: the standup instance, then the overlapping QBR + Northwind call.
    expect(busy).toEqual([
      { startMs: at(1, 9, 30), endMs: at(1, 9, 45) },
      { startMs: at(1, 14), endMs: at(1, 15, 30) },
    ]);
  });

  it("ignores transparent events and ones the owner declined", () => {
    const db = makeTestDb(CORPUS);
    const from = at(2, 0);
    const to = at(3, 0);
    const declined = declinedEventIds(db, OWNER, PRIMARY_ID);
    const busy = busyBlocks(rowsFor(db, from, to), from, to, TZ, declined);
    // Only Wednesday's standup: the focus block is transparent, the rehearsal declined.
    expect(busy).toEqual([{ startMs: at(2, 9, 30), endMs: at(2, 9, 45) }]);
  });

  it("does not count a cancelled event as busy", () => {
    const db = makeTestDb([
      { id: "cancel01", summary: "Dropped", startMs: at(1, 10), endMs: at(1, 11), status: "cancelled" },
    ]);
    const rows = listEventRows(db, {
      calendarId: PRIMARY_ID,
      timeMinMs: window.start,
      timeMaxMs: window.end,
      showDeleted: true,
    });
    expect(busyBlocks(rows, window.start, window.end, TZ)).toEqual([]);
  });
});
