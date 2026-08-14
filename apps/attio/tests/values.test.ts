import { describe, it, expect } from "vitest";
import type { Database } from "better-sqlite3";
import { makeEmptyDb, makeSeededDb, newRecord, NOW, OWNER_ACTOR } from "./helpers";
import { writeValues } from "@/lib/attio/values";
import { AttioError } from "@/lib/attio/errors";
import { allValuesFor } from "@/lib/store/records";
import { getAttribute } from "@/lib/store/objects";
import {
  ATTR_DE_STAGE,
  OBJ_COMPANIES,
  OBJ_DEALS,
  OBJ_PEOPLE,
  SEED_COMPANY_NORTHWIND,
  SEED_DEAL_NORTHWIND,
  SEED_STAGE_MOVE_MS,
} from "@/lib/seed";

// The versioned-value engine: the suite that proves this is Attio and not a
// generic CRM.

const CO = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";

function write(
  db: Database,
  objectId: string,
  objectSlug: string,
  recordId: string,
  values: Record<string, unknown>,
  mode: "create" | "append",
  atMs = NOW,
) {
  return writeValues(
    db,
    { recordId, objectId, objectSlug },
    values,
    { atMs, actor: OWNER_ACTOR, mode },
  );
}

function activeRows(db: Database, recordId: string, attributeId: string) {
  return allValuesFor(db, recordId).filter((v) => v.attribute_id === attributeId);
}

describe("supersede", () => {
  it("closes the old row at exactly the instant the new one opens", () => {
    const db = makeEmptyDb();
    newRecord(db, "companies", CO);
    write(db, OBJ_COMPANIES, "companies", CO, { name: "Northwind" }, "create", NOW);
    write(db, OBJ_COMPANIES, "companies", CO, { name: "Northwind Group" }, "append", NOW + 5000);

    const attr = getAttribute(db, OBJ_COMPANIES, "name")!;
    const rows = activeRows(db, CO, attr.id);
    expect(rows).toHaveLength(2);
    // History is preserved rather than overwritten, and the two are contiguous.
    expect(rows[0].active_until_ms).toBe(rows[1].active_from_ms);
    expect(rows.filter((r) => r.active_until_ms === null)).toHaveLength(1);
    expect(rows[1].text_value).toBe("Northwind Group");
  });

  it("refuses to close a value before it opened, rather than inverting the interval", () => {
    const db = makeEmptyDb();
    newRecord(db, "companies", CO);
    write(db, OBJ_COMPANIES, "companies", CO, { name: "Northwind" }, "create", NOW);

    // /api/sandbox/inject lets a director backdate a beat, so this is reachable
    // from the control plane. An interval that runs backwards is emitted
    // verbatim to the agent, so it has to be refused at the write.
    expect(() =>
      write(db, OBJ_COMPANIES, "companies", CO, { name: "Earlier" }, "append", NOW - 5000),
    ).toThrow(/has been active since/);

    const attr = getAttribute(db, OBJ_COMPANIES, "name")!;
    const rows = activeRows(db, CO, attr.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].active_until_ms).toBeNull();
  });

  it("allows a supersede at exactly the instant the current value opened", () => {
    const db = makeEmptyDb();
    newRecord(db, "companies", CO);
    write(db, OBJ_COMPANIES, "companies", CO, { name: "Northwind" }, "create", NOW);
    write(db, OBJ_COMPANIES, "companies", CO, { name: "Same instant" }, "append", NOW);

    const attr = getAttribute(db, OBJ_COMPANIES, "name")!;
    const rows = activeRows(db, CO, attr.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].active_until_ms).toBe(NOW);
  });

  it("reports the transition the audit summary quotes", () => {
    const db = makeSeededDb();
    const changes = write(
      db,
      OBJ_DEALS,
      "deals",
      SEED_DEAL_NORTHWIND,
      { stage: "Won 🎉" },
      "append",
      NOW,
    );
    expect(changes).toEqual([
      { slug: "stage", title: "Stage", before: "In Progress", after: "Won 🎉" },
    ]);
  });

  it("ships a seed whose Northwind stage already has two rows", () => {
    const db = makeSeededDb();
    const rows = activeRows(db, SEED_DEAL_NORTHWIND, ATTR_DE_STAGE);
    expect(rows).toHaveLength(2);
    expect(rows[0].text_value).toBe("Lead");
    expect(rows[0].active_until_ms).toBe(SEED_STAGE_MOVE_MS);
    expect(rows[1].text_value).toBe("In Progress");
    expect(rows[1].active_until_ms).toBeNull();
  });
});

describe("multiselect", () => {
  it("appends, prepends and deduplicates on the canonical key", () => {
    const db = makeEmptyDb();
    newRecord(db, "companies", CO);
    write(db, OBJ_COMPANIES, "companies", CO, { domains: ["a.example"] }, "create");
    write(
      db,
      OBJ_COMPANIES,
      "companies",
      CO,
      { domains: ["b.example", "a.example"] },
      "append",
      NOW + 1000,
    );

    const attr = getAttribute(db, OBJ_COMPANIES, "domains")!;
    const rows = activeRows(db, CO, attr.id).filter((r) => r.active_until_ms === null);
    // The already-present domain is not written twice, and the new one leads.
    expect(rows).toHaveLength(2);
    expect(
      [...rows].sort((a, b) => a.pos - b.pos).map((r) => r.text_value),
    ).toEqual(["b.example", "a.example"]);
  });

  it("keeps the caller's order when one append supplies several values", () => {
    const db = makeEmptyDb();
    newRecord(db, "companies", CO);
    write(db, OBJ_COMPANIES, "companies", CO, { domains: ["a.example"] }, "create");
    const changes = write(
      db,
      OBJ_COMPANIES,
      "companies",
      CO,
      { domains: ["first.example", "second.example", "third.example"] },
      "append",
      NOW + 1000,
    );

    const attr = getAttribute(db, OBJ_COMPANIES, "domains")!;
    const rows = activeRows(db, CO, attr.id).filter((r) => r.active_until_ms === null);
    // Every read is ORDER BY pos, so this is the order the API hands back: the
    // supplied block leads, in the order it was supplied, and the old value
    // keeps its place behind it.
    expect([...rows].sort((a, b) => a.pos - b.pos).map((r) => r.text_value)).toEqual([
      "first.example",
      "second.example",
      "third.example",
      "a.example",
    ]);
    // The audit summary has to agree with the read, not compensate for it.
    expect(changes[0].after).toBe("first.example, second.example, third.example, a.example");
  });

  it("writes every value in create mode with ascending positions", () => {
    const db = makeEmptyDb();
    newRecord(db, "companies", CO);
    write(
      db,
      OBJ_COMPANIES,
      "companies",
      CO,
      { domains: ["a.example", "b.example", "c.example"] },
      "create",
    );
    const attr = getAttribute(db, OBJ_COMPANIES, "domains")!;
    const rows = activeRows(db, CO, attr.id);
    expect(rows.map((r) => r.pos)).toEqual([0, 1, 2]);
  });

  it("writes a repeated value once, whichever path supplied it", () => {
    const db = makeEmptyDb();
    newRecord(db, "companies", CO);
    // Create is the path that used to keep both: the append branch dedups
    // against what the record already holds, so the two disagreed about the
    // same input.
    const changes = write(
      db,
      OBJ_COMPANIES,
      "companies",
      CO,
      { domains: ["a.example", "A.example", "b.example"] },
      "create",
    );
    const attr = getAttribute(db, OBJ_COMPANIES, "domains")!;
    const rows = activeRows(db, CO, attr.id);
    expect(rows.map((r) => r.text_value)).toEqual(["a.example", "b.example"]);
    expect(rows.map((r) => r.pos)).toEqual([0, 1]);
    // The audit summary quotes what was written, not what was asked for.
    expect(changes[0].after).toBe("a.example, b.example");
  });

  it("refuses two values for a single-value attribute", () => {
    const db = makeEmptyDb();
    newRecord(db, "companies", CO);
    expect(() =>
      write(db, OBJ_COMPANIES, "companies", CO, { name: ["A", "B"] }, "create"),
    ).toThrowError(/accepts a single value/);
  });
});

describe("write forms", () => {
  it("normalises the two personal-name syntaxes to the same tuple", () => {
    const db = makeEmptyDb();
    newRecord(db, "people", PE);
    write(db, OBJ_PEOPLE, "people", PE, { name: "Mireles, Ana" }, "create");
    const attr = getAttribute(db, OBJ_PEOPLE, "name")!;
    const fromString = activeRows(db, PE, attr.id)[0];

    const db2 = makeEmptyDb();
    newRecord(db2, "people", PE);
    write(
      db2,
      OBJ_PEOPLE,
      "people",
      PE,
      { name: { first_name: "Ana", last_name: "Mireles", full_name: "Ana Mireles" } },
      "create",
    );
    const fromObject = activeRows(db2, PE, attr.id)[0];

    expect(fromString.text_value).toBe("Ana Mireles");
    expect(fromString.text_value).toBe(fromObject.text_value);
    expect(fromString.extra_json).toBe(fromObject.extra_json);
  });

  it("takes a comma-less personal name as the first name, the way Attio does", () => {
    const db = makeEmptyDb();
    newRecord(db, "people", PE);
    write(db, OBJ_PEOPLE, "people", PE, { name: "Cher" }, "create");
    const attr = getAttribute(db, OBJ_PEOPLE, "name")!;
    expect(JSON.parse(activeRows(db, PE, attr.id)[0].extra_json!)).toEqual({
      first_name: "Cher",
      last_name: "",
    });
  });

  it("accepts a currency as a number, a numeric string or an object", () => {
    const db = makeSeededDb();
    const stored = (raw: unknown) => {
      const changes = write(db, OBJ_DEALS, "deals", SEED_DEAL_NORTHWIND, { value: raw }, "append");
      const attr = getAttribute(db, OBJ_DEALS, "value")!;
      return activeRows(db, SEED_DEAL_NORTHWIND, attr.id).at(-1)!.number_value;
    };
    expect(stored(4.99)).toBe(4.99);
    expect(stored("4.99")).toBe(4.99);
    expect(stored({ currency_value: "4.99" })).toBe(4.99);
  });

  it("resolves the domain shorthand to the same reference as the explicit form", () => {
    const db = makeSeededDb();
    newRecord(db, "people", PE);
    write(
      db,
      OBJ_PEOPLE,
      "people",
      PE,
      { name: "Doe, Jane", company: "northwind.example" },
      "create",
    );
    const attr = getAttribute(db, OBJ_PEOPLE, "company")!;
    const row = activeRows(db, PE, attr.id)[0];
    expect(row.ref_object).toBe("companies");
    expect(row.ref_record_id).toBe(SEED_COMPANY_NORTHWIND);
  });

  it("stores a referenced actor separately from the actor who wrote the value", () => {
    const db = makeSeededDb();
    write(
      db,
      OBJ_DEALS,
      "deals",
      SEED_DEAL_NORTHWIND,
      { owner: "priya@acme.co" },
      "append",
    );
    const attr = getAttribute(db, OBJ_DEALS, "owner")!;
    const row = activeRows(db, SEED_DEAL_NORTHWIND, attr.id).at(-1)!;
    expect(row.ref_object).toBe("workspace-member");
    expect(row.actor_id).toBe(OWNER_ACTOR.id);
    expect(row.ref_record_id).not.toBe(row.actor_id);
  });
});

describe("refusals", () => {
  it("names every allowed stage when the title is unknown", () => {
    const db = makeSeededDb();
    try {
      write(db, OBJ_DEALS, "deals", SEED_DEAL_NORTHWIND, { stage: "Closed" }, "append");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AttioError);
      expect((err as AttioError).code).toBe("value_not_found");
      for (const title of ["Lead", "In Progress", "Won 🎉", "Lost"]) {
        expect((err as AttioError).message).toContain(title);
      }
    }
  });

  it("names the object when the attribute slug is unknown", () => {
    const db = makeSeededDb();
    expect(() =>
      write(db, OBJ_DEALS, "deals", SEED_DEAL_NORTHWIND, { probability: 0.5 }, "append"),
    ).toThrowError(/"probability".*"deals"/);
  });

  it("refuses a reference to a record that does not exist", () => {
    const db = makeSeededDb();
    expect(() =>
      write(
        db,
        OBJ_DEALS,
        "deals",
        SEED_DEAL_NORTHWIND,
        {
          associated_company: {
            target_object: "companies",
            target_record_id: "00000000-0000-4000-8000-000000000000",
          },
        },
        "append",
      ),
    ).toThrowError(/not found/);
  });
});
