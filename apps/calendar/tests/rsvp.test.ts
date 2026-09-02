import { describe, it, expect, afterEach } from "vitest";
import type { Database } from "better-sqlite3";
import { makeTestDb, at, OWNER, PRIMARY_ID, TEAM_ID, TZ, type TestEvent } from "./helpers";
import { getEventRow, listAttendees, setAttendeeResponse } from "@/lib/store/events";
import { shapeEvent } from "@/lib/calendar/shape";
import { POST } from "../app/api/sandbox/inject/route";

// Somebody in the world answering an invite. The path used to throw on every
// call, so both halves are covered here: the targeted store write, and the
// inject route branch the engine's calendar adapter posts to.

const DANA = "dana@acme.test";
const PRIYA = "priya@acme.test";
const CLIVE = "clive@northwind.test";

/** Three guests with three different answers — the state an RSVP must not flatten. */
const REVIEW: TestEvent = {
  id: "review01",
  summary: "SLA review",
  startMs: at(0, 14),
  endMs: at(0, 15),
  organizer: PRIYA,
  attendees: [
    { email: OWNER, displayName: "Sandbox User", responseStatus: "accepted" },
    { email: PRIYA, displayName: "Priya Nair", responseStatus: "accepted" },
    { email: DANA, displayName: "Dana Reyes", responseStatus: "needsAction", optional: true },
  ],
};

function responses(db: Database, eventId: string): Record<string, string> {
  return Object.fromEntries(
    listAttendees(db, eventId).map((a) => [a.email, a.response_status]),
  );
}

// getDb() memoises its handle on globalThis (see lib/db.ts), which is also the
// hook that lets a route handler run against an in-memory database here.
const g = globalThis as unknown as { __calendarSandboxWorking?: Database };

function useDb(db: Database): Database {
  g.__calendarSandboxWorking = db;
  return db;
}

afterEach(() => {
  g.__calendarSandboxWorking = undefined;
});

function inject(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost:3400/api/sandbox/inject", {
      method: "POST",
      headers: { "content-type": "application/json", "x-sandbox-token": "sandbox-token" },
      body: JSON.stringify(body),
    }),
  );
}

describe("setAttendeeResponse", () => {
  it("records one answer and leaves every other guest exactly as they were", () => {
    const db = makeTestDb([REVIEW]);
    expect(
      setAttendeeResponse(db, PRIMARY_ID, "review01", DANA, "declined", undefined, at(0, 9)),
    ).toBe(true);

    expect(responses(db, "review01")).toEqual({
      [OWNER]: "accepted",
      [PRIYA]: "accepted",
      [DANA]: "declined",
    });
    // The whole point of not going through replaceAttendees: it deletes and
    // re-inserts the list, so the other guests' names and flags would go too.
    const priya = listAttendees(db, "review01").find((a) => a.email === PRIYA);
    expect(priya?.display_name).toBe("Priya Nair");
    const dana = listAttendees(db, "review01").find((a) => a.email === DANA);
    expect(dana?.display_name).toBe("Dana Reyes");
    expect(dana?.optional).toBe(1);
  });

  it("refuses an address that is not on the event, and adds nobody", () => {
    const db = makeTestDb([REVIEW]);
    expect(setAttendeeResponse(db, PRIMARY_ID, "review01", CLIVE, "accepted")).toBe(false);
    expect(listAttendees(db, "review01").map((a) => a.email)).not.toContain(CLIVE);
    expect(listAttendees(db, "review01")).toHaveLength(3);
  });

  it("moves the etag and `updated`, so a re-read does not claim nothing happened", () => {
    const db = makeTestDb([REVIEW]);
    const shape = (): { etag?: string; updated?: string } =>
      shapeEvent(getEventRow(db, PRIMARY_ID, "review01")!, listAttendees(db, "review01"), {
        ownerEmail: OWNER,
        calendarTimeZone: TZ,
      });

    const before = shape();
    setAttendeeResponse(db, PRIMARY_ID, "review01", DANA, "tentative", undefined, at(0, 10));
    const after = shape();

    // Asserted through the resource an agent actually reads rather than through
    // the column, because the column is only a defect if these two fields lie.
    expect(after.etag).not.toBe(before.etag);
    expect(after.updated).not.toBe(before.updated);
    expect(getEventRow(db, PRIMARY_ID, "review01")!.updated_ms).toBe(at(0, 10));
  });

  it("matches the address case-insensitively, the way Calendar does", () => {
    const db = makeTestDb([REVIEW]);
    expect(setAttendeeResponse(db, PRIMARY_ID, "review01", "DANA@Acme.Test", "accepted")).toBe(
      true,
    );
    expect(responses(db, "review01")[DANA]).toBe("accepted");
  });

  it("will not answer for an event that lives on another calendar", () => {
    const db = makeTestDb([REVIEW]);
    expect(setAttendeeResponse(db, TEAM_ID, "review01", DANA, "declined")).toBe(false);
    expect(responses(db, "review01")[DANA]).toBe("needsAction");
  });

  it("keeps an earlier note when a later answer carries none, and clears it on empty", () => {
    const db = makeTestDb([REVIEW]);
    const noteOf = (): string | null | undefined =>
      listAttendees(db, "review01").find((a) => a.email === DANA)?.comment;

    setAttendeeResponse(db, PRIMARY_ID, "review01", DANA, "declined", "board runs till 3");
    expect(noteOf()).toBe("board runs till 3");

    // Undefined means "say nothing about the note", not "there is no note" —
    // otherwise every plain accept would silently erase the reason someone gave.
    setAttendeeResponse(db, PRIMARY_ID, "review01", DANA, "tentative");
    expect(noteOf()).toBe("board runs till 3");

    // Empty string is the deliberate retraction, and has to stay distinguishable
    // from the above or nobody could ever take a stale reason back.
    setAttendeeResponse(db, PRIMARY_ID, "review01", DANA, "accepted", "");
    expect(noteOf() ?? "").toBe("");
  });
});

describe("POST /api/sandbox/inject — rsvps", () => {
  it("records the answer and reports what it answered", async () => {
    const db = useDb(makeTestDb([REVIEW]));
    const res = await inject({
      rsvps: [{ eventId: "review01", calendarId: PRIMARY_ID, email: DANA, response: "declined" }],
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      answered: [{ id: "review01", calendarId: PRIMARY_ID, email: DANA }],
    });
    expect(responses(db, "review01")).toEqual({
      [OWNER]: "accepted",
      [PRIYA]: "accepted",
      [DANA]: "declined",
    });
  });

  it("defaults to the primary calendar, like the other branches", async () => {
    const db = useDb(makeTestDb([REVIEW]));
    const res = await inject({ rsvps: [{ eventId: "review01", email: PRIYA, response: "tentative" }] });
    expect(res.status).toBe(200);
    expect(responses(db, "review01")[PRIYA]).toBe("tentative");
  });

  it("400s an RSVP from someone who was never invited, rather than inviting them", async () => {
    const db = useDb(makeTestDb([REVIEW]));
    const res = await inject({
      rsvps: [{ eventId: "review01", email: CLIVE, response: "accepted" }],
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("is not on event review01"),
    });
    // Silently adding him would have handed the agent a `calendar:invited` pass.
    expect(listAttendees(db, "review01").map((a) => a.email)).not.toContain(CLIVE);
    expect(getEventRow(db, PRIMARY_ID, "review01")!.updated_ms).toBe(at(-7, 9));
  });

  it("rolls the whole batch back when one RSVP in it is bad", async () => {
    const db = useDb(makeTestDb([REVIEW]));
    const res = await inject({
      rsvps: [
        { eventId: "review01", email: DANA, response: "accepted" },
        { eventId: "review01", email: CLIVE, response: "accepted" },
      ],
    });

    expect(res.status).toBe(400);
    // Named, so this test cannot be satisfied by the route rejecting the whole
    // body for some other reason — a branch that did not exist would 400 too.
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining(CLIVE),
    });
    expect(responses(db, "review01")[DANA]).toBe("needsAction");
  });

  it("400s an unknown event and an unknown response status", async () => {
    useDb(makeTestDb([REVIEW]));
    const missing = await inject({
      rsvps: [{ eventId: "nope0001", email: DANA, response: "declined" }],
    });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "unknown event nope0001" });

    const maybe = await inject({
      rsvps: [{ eventId: "review01", email: DANA, response: "maybe" }],
    });
    expect(maybe.status).toBe(400);
    await expect(maybe.json()).resolves.toMatchObject({
      error: expect.stringContaining("Invalid attendee response status"),
    });
  });

  it("400s an rsvp with no response at all, rather than reading it as needsAction", async () => {
    const db = useDb(makeTestDb([REVIEW]));
    const res = await inject({ rsvps: [{ eventId: "review01", email: PRIYA }] });
    expect(res.status).toBe(400);
    // The wording is the assertion: "nothing to inject" would mean the rsvps
    // branch never ran, which is a different bug that leaves Priya untouched too.
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("needs a response"),
    });
    expect(responses(db, "review01")[PRIYA]).toBe("accepted");
  });

  it("puts the reason for a decline on the event the agent can read", async () => {
    const db = useDb(makeTestDb([REVIEW]));
    const res = await inject({
      rsvps: [
        {
          eventId: "review01",
          email: DANA,
          response: "declined",
          comment: "can't do 2pm — the board runs till 3",
        },
      ],
    });
    expect(res.status).toBe(200);

    // Asserted off `shapeEvent` rather than off the column, because the whole
    // defect was that the note existed in the day's record and NOWHERE the agent
    // could reach: the judge's timeline prints an RSVP's comment on a row with no
    // FAILED marker, so a dropped note leaves the agent marked down for ignoring
    // a sentence that was never on any surface it could GET.
    const shaped = shapeEvent(
      getEventRow(db, PRIMARY_ID, "review01")!,
      listAttendees(db, "review01"),
      { ownerEmail: OWNER, calendarTimeZone: TZ },
    );
    const dana = shaped.attendees?.find((a) => a.email === DANA);
    expect(dana?.responseStatus).toBe("declined");
    expect(dana?.comment).toBe("can't do 2pm — the board runs till 3");

    // Nobody else grew a note they never wrote.
    expect(shaped.attendees?.filter((a) => a.comment !== undefined)).toHaveLength(1);
  });

  it("writes no audit row — the world's answer is not the agent's action", async () => {
    const db = useDb(makeTestDb([REVIEW]));
    const res = await inject({
      rsvps: [{ eventId: "review01", email: DANA, response: "accepted" }],
    });

    // The answer has to have LANDED for the empty log to mean anything. Asserting
    // only the count passes just as well against a route with no rsvps branch at
    // all, which is the one outcome this invariant test must not be able to miss.
    expect(res.status).toBe(200);
    expect(responses(db, "review01")[DANA]).toBe("accepted");
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM audit.action_log").get() as { n: number };
    expect(n).toBe(0);
  });
});
