import { describe, it, expect } from "vitest";
import { BadRequestError, parseSeedRequest } from "@/lib/sandbox/parse";

// The wire seed's validation. Every rule here exists because the alternative is
// a CRM the agent quietly reasons about wrongly, which is far worse than a run
// that refuses to start.

const CAST = [
  { id: "p1", name: "Sandbox User", email: "sandbox.user@gmail.com" },
  { id: "p2", name: "Priya Nair", email: "priya@acme.co" },
  { id: "p3", name: "Ana Mireles", email: "ana@northwind.example" },
];

function body(overrides: Record<string, unknown> = {}) {
  return {
    twin: "attio",
    seed: {
      world: { business: { name: "Acme" }, cast: CAST, mailboxOwner: CAST[0].email },
      nowISO: "2026-07-27T13:00:00.000Z",
      ownerEmail: CAST[0].email,
      workspace: { name: "Acme", slug: "acme" },
      members: [
        { id: "m1", email: CAST[0].email },
        { id: "m2", email: CAST[1].email },
      ],
      companies: [
        { id: "c1", name: "Northwind", domains: ["northwind.example"], description: "" },
      ],
      people: [
        {
          id: "pe1",
          name: "Ana Mireles",
          email: CAST[2].email,
          jobTitle: "VP Operations",
          companyId: "c1",
        },
      ],
      deals: [
        {
          id: "d1",
          name: "Northwind — Platform renewal",
          stage: "In Progress",
          value: 48000,
          ownerEmail: CAST[0].email,
          companyId: "c1",
          peopleIds: ["pe1"],
        },
      ],
      notes: [
        {
          id: "n1",
          parentObject: "companies",
          parentRecordId: "c1",
          title: "Escalation",
          content: "Payments failing.",
          createdISO: "2026-07-24T13:00:00.000Z",
        },
      ],
      tasks: [
        {
          id: "t1",
          content: "Send the renewal quote",
          deadlineAt: "2026-07-31",
          isCompleted: false,
          linkedRecords: [{ object: "deals", recordId: "d1" }],
          assigneeEmail: CAST[0].email,
          createdISO: "2026-07-24T13:00:00.000Z",
        },
      ],
      ...overrides,
    },
  };
}

/** Replace one field deep inside the seed and expect a message naming it. */
function rejects(overrides: Record<string, unknown>, fragment: RegExp): void {
  expect(() => parseSeedRequest(body(overrides))).toThrowError(BadRequestError);
  expect(() => parseSeedRequest(body(overrides))).toThrowError(fragment);
}

describe("parseSeedRequest", () => {
  it("accepts a complete seed and resolves its timestamps", () => {
    const parsed = parseSeedRequest(body());
    expect(parsed.nowMs).toBe(Date.UTC(2026, 6, 27, 13, 0, 0));
    expect(parsed.workspaceSlug).toBe("acme");
    expect(parsed.people[0]).toMatchObject({ firstName: "Ana", lastName: "Mireles" });
    expect(parsed.tasks[0].deadlineAt).toBe("2026-07-31");
    expect(parsed.promoteToSnapshot).toBe(false);
  });

  it("refuses a mis-routed seed even though the URL already said so", () => {
    expect(() => parseSeedRequest({ ...body(), twin: "calendar" })).toThrowError(
      /this twin seeds 'attio'/,
    );
  });

  it("never invents an identity", () => {
    rejects(
      {
        deals: [
          {
            ...body().seed.deals[0],
            ownerEmail: "stranger@example.com",
          },
        ],
      },
      /is not in seed\.world\.cast/,
    );
  });

  it("refuses a deal owned by someone who is not a workspace member", () => {
    rejects(
      { deals: [{ ...body().seed.deals[0], ownerEmail: CAST[2].email }] },
      /is not among seed\.members/,
    );
  });

  it("refuses a stage the pipeline does not have, and lists the ones it does", () => {
    rejects(
      { deals: [{ ...body().seed.deals[0], stage: "Closed" }] },
      /Lead \| In Progress \| Won 🎉 \| Lost/,
    );
  });

  it("checks references inside the seed", () => {
    rejects(
      { people: [{ ...body().seed.people[0], companyId: "c-9" }] },
      /seed\.people\[0\]\.companyId "c-9" names no company/,
    );
    rejects(
      {
        tasks: [
          { ...body().seed.tasks[0], linkedRecords: [{ object: "deals", recordId: "d-9" }] },
        ],
      },
      /names no record in seed\.deals/,
    );
  });

  it("refuses an unparseable timestamp, quoting it", () => {
    rejects({ nowISO: "next tuesday" }, /"next tuesday"/);
  });

  it("refuses duplicate ids", () => {
    const dup = body().seed.companies[0];
    rejects({ companies: [dup, { ...dup, name: "Northwind again" }] }, /two entries with id/);
  });

  it("refuses a non-boolean promoteToSnapshot", () => {
    rejects({ promoteToSnapshot: "yes" }, /must be a boolean/);
  });
});
