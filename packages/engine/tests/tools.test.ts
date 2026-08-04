import { describe, it, expect } from "vitest";
import { TwinHttp } from "../src/http";
import { calendarTools, freeWindows, toolsFor } from "../src/tools";
import { fetchFake } from "./fixtures";

// The agent's hands. What matters here is the same thing that matters in the
// adapters: the request that goes out has to be one the twin's own route parses.

const MIN = 60_000;

function tool(name: string, fake: ReturnType<typeof fetchFake>) {
  const http = new TwinHttp({ baseUrl: "http://cal.test", fetchImpl: fake.fetch });
  const found = calendarTools(http).find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
}

const CALENDARS = {
  "/users/me/calendarList": {
    items: [
      { id: "other@northwind.test", summary: "Shared" },
      { id: "priya@northwind.test", summary: "Priya", primary: true },
    ],
  },
};

describe("freeWindows", () => {
  const from = Date.parse("2026-08-04T09:00:00Z");
  const to = Date.parse("2026-08-04T12:00:00Z");
  const at = (h: number, m = 0) => Date.parse(`2026-08-04T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);

  it("returns the gaps, not the meetings", () => {
    const free = freeWindows([{ start: at(10), end: at(11) }], from, to, 30 * MIN);
    expect(free).toEqual([
      { start: at(9), end: at(10) },
      { start: at(11), end: at(12) },
    ]);
  });

  it("merges back-to-back meetings, so no zero-length gap is offered as free", () => {
    const free = freeWindows(
      [
        { start: at(9), end: at(10) },
        { start: at(10), end: at(11) },
      ],
      from,
      to,
      30 * MIN,
    );
    expect(free).toEqual([{ start: at(11), end: at(12) }]);
  });

  it("merges overlapping and out-of-order blocks", () => {
    const free = freeWindows(
      [
        { start: at(10, 30), end: at(11, 30) },
        { start: at(10), end: at(11) },
      ],
      from,
      to,
      15 * MIN,
    );
    expect(free).toEqual([
      { start: at(9), end: at(10) },
      { start: at(11, 30), end: at(12) },
    ]);
  });

  it("clamps to the window and drops gaps shorter than the ask", () => {
    const free = freeWindows(
      [
        { start: at(7), end: at(9, 45) },
        { start: at(10), end: at(13) },
      ],
      from,
      to,
      30 * MIN,
    );
    // The 15 minutes at 09:45 is not half an hour, and nothing after 10:00 is free.
    expect(free).toEqual([]);
  });

  it("calls the whole window free when nothing is booked", () => {
    expect(freeWindows([], from, to, 30 * MIN)).toEqual([{ start: from, end: to }]);
  });
});

describe("the calendar tools", () => {
  it("expands recurrence and orders by start when listing a window", async () => {
    const fake = fetchFake({
      ...CALENDARS,
      "/events": { items: [{ id: "ev1", summary: "Standup", start: { dateTime: "2026-08-04T09:30:00Z" }, end: { dateTime: "2026-08-04T09:45:00Z" } }] },
    });
    const result = await tool("list_events", fake).run({
      timeMin: "2026-08-04T09:00:00Z",
      timeMax: "2026-08-04T17:00:00Z",
    });

    const url = fake.find("/events")?.url ?? "";
    expect(url).toContain("singleEvents=true");
    expect(url).toContain("orderBy=startTime");
    // Unqualified means the owner's own calendar, not the first one listed.
    expect(url).toContain(encodeURIComponent("priya@northwind.test"));
    expect(result).toEqual({
      calendarId: "priya@northwind.test",
      events: [
        {
          id: "ev1",
          summary: "Standup",
          start: "2026-08-04T09:30:00Z",
          end: "2026-08-04T09:45:00Z",
          status: "confirmed",
          organizer: "",
          attendees: [],
        },
      ],
    });
  });

  it("asks freeBusy about everyone at once and answers with free slots", async () => {
    const fake = fetchFake({
      ...CALENDARS,
      "/freeBusy": {
        calendars: {
          "priya@northwind.test": { busy: [{ start: "2026-08-04T10:00:00Z", end: "2026-08-04T11:00:00Z" }] },
          "dana@acme.test": { busy: [{ start: "2026-08-04T11:00:00Z", end: "2026-08-04T11:30:00Z" }] },
        },
      },
    });
    const result = await tool("find_free_time", fake).run({
      timeMin: "2026-08-04T09:00:00Z",
      timeMax: "2026-08-04T12:00:00Z",
      attendees: ["dana@acme.test"],
      durationMinutes: 30,
    });

    expect(fake.find("/freeBusy")?.body).toEqual({
      timeMin: "2026-08-04T09:00:00Z",
      timeMax: "2026-08-04T12:00:00Z",
      items: [{ id: "priya@northwind.test" }, { id: "dana@acme.test" }],
    });
    // Both people's busy blocks are honoured, and 10:00–11:30 is gone.
    expect(result).toEqual({
      free: [
        { start: "2026-08-04T09:00:00.000Z", end: "2026-08-04T10:00:00.000Z" },
        { start: "2026-08-04T11:30:00.000Z", end: "2026-08-04T12:00:00.000Z" },
      ],
    });
  });

  it("writes times in the shape the twin accepts, and sends only what changed", async () => {
    const fake = fetchFake({ ...CALENDARS, "/events": { id: "ev1", summary: "SLA review" } });
    const create = tool("create_event", fake);
    await create.run({
      summary: "SLA review",
      start: "2026-08-04T14:00:00Z",
      end: "2026-08-04T14:30:00Z",
      attendees: ["dana@acme.test"],
    });
    expect(fake.find("/events")?.method).toBe("POST");
    expect(fake.find("/events")?.body).toEqual({
      summary: "SLA review",
      start: { dateTime: "2026-08-04T14:00:00Z" },
      end: { dateTime: "2026-08-04T14:30:00Z" },
      attendees: [{ email: "dana@acme.test" }],
    });

    await tool("update_event", fake).run({ eventId: "ev1", start: "2026-08-04T15:00:00Z", end: "2026-08-04T15:30:00Z" });
    const patch = fake.find("/events/ev1");
    expect(patch?.method).toBe("PATCH");
    // A patch that carried an empty summary would blank the meeting's title.
    expect(patch?.body).toEqual({
      start: { dateTime: "2026-08-04T15:00:00Z" },
      end: { dateTime: "2026-08-04T15:30:00Z" },
    });
  });

  it("marks reads and writes apart, which is what separates looking from acting", () => {
    const http = new TwinHttp({ baseUrl: "http://cal.test", fetchImpl: fetchFake({}).fetch });
    const mutations = calendarTools(http).filter((t) => t.isMutation).map((t) => t.name);
    expect(mutations).toEqual(["create_event", "update_event", "delete_event"]);
    expect(calendarTools(http).every((t) => t.twin === "calendar")).toBe(true);
  });
});

describe("toolsFor", () => {
  it("hands the agent only the surfaces this episode uses", () => {
    const http = new TwinHttp({ baseUrl: "http://x.test", fetchImpl: fetchFake({}).fetch });
    const names = toolsFor(["gmail", "slack"], { gmail: http, slack: http, calendar: http });
    expect(new Set(names.map((t) => t.twin))).toEqual(new Set(["gmail", "slack"]));
    // A twin with no client is silently absent rather than a half-built tool.
    expect(toolsFor(["calendar"], {})).toEqual([]);
  });

  it("gives every tool a unique name, so dispatch cannot be ambiguous", () => {
    const http = new TwinHttp({ baseUrl: "http://x.test", fetchImpl: fetchFake({}).fetch });
    const all = toolsFor(["gmail", "slack", "calendar"], { gmail: http, slack: http, calendar: http });
    expect(new Set(all.map((t) => t.name)).size).toBe(all.length);
  });
});
