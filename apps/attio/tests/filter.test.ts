import { describe, it, expect } from "vitest";
import { makeSeededDb, newRecord, NOW, OWNER_ACTOR, queryIds } from "./helpers";
import { writeValues } from "@/lib/attio/values";
import { AttioError } from "@/lib/attio/errors";
import {
  OBJ_COMPANIES,
  SEED_COMPANY_NORTHWIND,
  SEED_DEAL_NORTHWIND,
  SEED_PERSON_ANA,
} from "@/lib/seed";

// The filter and sort compiler, run against the demo corpus: three companies,
// three people and three deals sitting at three different stages.

const db = makeSeededDb();

const nameOf = (ids: string[]) =>
  ids.map(
    (id) =>
      (
        db
          .prepare(
            `SELECT v.text_value AS t FROM attribute_values v
               JOIN attributes a ON a.id = v.attribute_id AND a.pos = 0
              WHERE v.record_id = ? AND v.active_until_ms IS NULL`,
          )
          .get(id) as { t: string }
      ).t,
  );

describe("filter shorthand", () => {
  it("matches text equality", () => {
    expect(queryIds(db, "companies", { filter: { name: "Northwind" } })).toEqual([
      SEED_COMPANY_NORTHWIND,
    ]);
  });

  it("resolves a status title to its option id", () => {
    expect(queryIds(db, "deals", { filter: { stage: "In Progress" } })).toEqual([
      SEED_DEAL_NORTHWIND,
    ]);
  });

  it("matches a record reference by target id", () => {
    expect(
      queryIds(db, "deals", { filter: { associated_company: SEED_COMPANY_NORTHWIND } }),
    ).toEqual([SEED_DEAL_NORTHWIND]);
  });

  it("does NOT match a superseded value", () => {
    // The Northwind renewal has a closed "Lead" row; only the Vertex pilot is
    // actually at Lead today.
    expect(nameOf(queryIds(db, "deals", { filter: { stage: "Lead" } }))).toEqual([
      "Vertex Logistics — Pilot",
    ]);
  });
});

describe("nested fields", () => {
  it("matches a personal name's full_name", () => {
    expect(
      queryIds(db, "people", { filter: { name: { full_name: { $eq: "Ana Mireles" } } } }),
    ).toEqual([SEED_PERSON_ANA]);
  });

  it("matches a first name out of extra_json", () => {
    expect(queryIds(db, "people", { filter: { name: { first_name: "Ana" } } })).toEqual([
      SEED_PERSON_ANA,
    ]);
  });

  it("matches an email address by substring", () => {
    expect(
      queryIds(db, "people", {
        filter: { email_addresses: { email_address: { $contains: "northwind" } } },
      }),
    ).toEqual([SEED_PERSON_ANA]);
  });

  it("derives email_domain rather than storing it", () => {
    expect(
      nameOf(
        queryIds(db, "people", {
          filter: { email_addresses: { email_domain: "vertex.example" } },
        }),
      ),
    ).toEqual(["Tom Ferris"]);
  });
});

describe("operators", () => {
  it("$contains is case-insensitive", () => {
    expect(queryIds(db, "companies", { filter: { name: { $contains: "north" } } })).toEqual([
      SEED_COMPANY_NORTHWIND,
    ]);
  });

  it("$starts_with and $ends_with", () => {
    expect(nameOf(queryIds(db, "companies", { filter: { name: { $starts_with: "Harbor" } } }))).toEqual(
      ["Harbor Health"],
    );
    expect(nameOf(queryIds(db, "companies", { filter: { name: { $ends_with: "Logistics" } } }))).toEqual(
      ["Vertex Logistics"],
    );
  });

  it("$in over status titles", () => {
    expect(
      nameOf(queryIds(db, "deals", { filter: { stage: { $in: ["Lead", "Won 🎉"] } } })),
    ).toEqual(["Harbor Health — Expansion", "Vertex Logistics — Pilot"]);
  });

  it("$not_empty excludes a record that has no such value at all", () => {
    // Every seeded company carries a description, so the shared corpus cannot
    // tell this operator apart from `1=1`. A fourth company with none can.
    const local = makeSeededDb();
    const blank = "55555555-5555-4555-8555-555555555555";
    newRecord(local, "companies", blank);
    writeValues(
      local,
      { recordId: blank, objectId: OBJ_COMPANIES, objectSlug: "companies" },
      { name: "Blank Co" },
      { atMs: NOW, actor: OWNER_ACTOR, mode: "create", isSandboxCreated: false },
    );
    const found = queryIds(local, "companies", {
      filter: { description: { $not_empty: true } },
    });
    expect(found).toHaveLength(3);
    expect(found).not.toContain(blank);
  });

  it("ANDs several operators in one object", () => {
    expect(
      nameOf(queryIds(db, "deals", { filter: { value: { $gte: 12000, $lt: 48000 } } })),
    ).toEqual(["Harbor Health — Expansion", "Vertex Logistics — Pilot"]);
  });

  it("$and, $or and $not", () => {
    expect(
      nameOf(
        queryIds(db, "deals", {
          filter: { $and: [{ stage: "Won 🎉" }, { value: { $gt: 20000 } }] },
        }),
      ),
    ).toEqual(["Harbor Health — Expansion"]);
    expect(
      queryIds(db, "deals", { filter: { $or: [{ stage: "Lead" }, { stage: "In Progress" }] } }),
    ).toHaveLength(2);
    expect(nameOf(queryIds(db, "deals", { filter: { $not: { stage: "Lead" } } }))).toEqual([
      "Harbor Health — Expansion",
      "Northwind — Platform renewal",
    ]);
  });

  it("bounds created_at against the record's own column", () => {
    const iso = new Date(NOW - 30 * 86_400_000).toISOString();
    expect(nameOf(queryIds(db, "deals", { filter: { created_at: { $gt: iso } } }))).toEqual([
      "Vertex Logistics — Pilot",
      "Northwind — Platform renewal",
    ]);
  });
});

describe("sorts", () => {
  it("defaults to created_at ascending", () => {
    expect(nameOf(queryIds(db, "companies"))).toEqual([
      "Northwind",
      "Harbor Health",
      "Vertex Logistics",
    ]);
  });

  it("sorts on text in both directions", () => {
    const asc = nameOf(queryIds(db, "companies", { sorts: [{ attribute: "name" }] }));
    expect(asc).toEqual(["Harbor Health", "Northwind", "Vertex Logistics"]);
    expect(
      nameOf(queryIds(db, "companies", { sorts: [{ attribute: "name", direction: "desc" }] })),
    ).toEqual([...asc].reverse());
  });

  it("sorts on a currency", () => {
    expect(
      nameOf(queryIds(db, "deals", { sorts: [{ attribute: "value", direction: "desc" }] })),
    ).toEqual([
      "Northwind — Platform renewal",
      "Harbor Health — Expansion",
      "Vertex Logistics — Pilot",
    ]);
  });

  it("puts records with no value last in BOTH directions", () => {
    const local = makeSeededDb();
    const id = "33333333-3333-4333-8333-333333333333";
    newRecord(local, "companies", id);
    writeValues(
      local,
      { recordId: id, objectId: OBJ_COMPANIES, objectSlug: "companies" },
      { name: "Blank Co" },
      { atMs: NOW, actor: OWNER_ACTOR, mode: "create", isSandboxCreated: false },
    );
    const asc = queryIds(local, "companies", { sorts: [{ attribute: "description" }] });
    const desc = queryIds(local, "companies", {
      sorts: [{ attribute: "description", direction: "desc" }],
    });
    expect(asc.at(-1)).toBe(id);
    expect(desc.at(-1)).toBe(id);
  });
});

describe("loud refusals", () => {
  const rejects = (body: Record<string, unknown>, fragment: RegExp) => {
    try {
      queryIds(db, "deals", body);
      throw new Error("expected a filter_error");
    } catch (err) {
      expect(err).toBeInstanceOf(AttioError);
      expect((err as AttioError).statusCode).toBe(400);
      // The code matters: a client branching on it must not land on the tasks
      // endpoint's validation_type.
      expect((err as AttioError).code).toBe("filter_error");
      expect((err as AttioError).message).toMatch(fragment);
    }
  };

  // filter_view_id is a SIBLING of filter in Attio's spec, so the top-level form
  // is the one every real client sends — and it never reaches the filter walker.
  it("rejects a top-level filter_view_id", () => {
    rejects({ filter_view_id: "0f3e3ed6-31b2-4b02-9f74-3a2a0e2f1f10" }, /filter_view_id/);
  });

  it("rejects filter_view_id nested under filter as well", () => {
    rejects({ filter: { filter_view_id: "abc" } }, /filter_view_id/);
  });

  it("rejects a misspelled body key instead of answering the whole object", () => {
    rejects({ filters: { stage: "Lead" } }, /unknown query key "filters"/);
  });

  it("rejects a $not_empty operand it cannot honour", () => {
    rejects({ filter: { name: { $not_empty: false } } }, /\$not_empty takes true/);
  });

  it("rejects a path filter", () => {
    rejects({ filter: { path: [["deals", "stage"]], constraints: {} } }, /path\/constraints/);
  });

  it("rejects a path sort", () => {
    rejects({ sorts: [{ path: [["deals", "stage"]], direction: "asc" }] }, /path-based sorts/);
  });

  it("rejects an unknown operator", () => {
    rejects({ filter: { name: { $regex: "x" } } }, /unknown operator/);
  });

  it("rejects an unknown attribute and names the ones that exist", () => {
    rejects({ filter: { probability: 0.5 } }, /unknown attribute "probability"/);
  });
});
