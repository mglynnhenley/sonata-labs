import { describe, it, expect } from "vitest";
import {
  makeSeededDb,
  newRecord,
  NOW,
  OWNER_ACTOR,
  queryRecords,
  testCtx,
} from "./helpers";
import { writeValues } from "@/lib/attio/values";
import {
  rootDomainOf,
  shapeNote,
  shapeSelf,
  shapeTask,
  toAttioTimestamp,
} from "@/lib/attio/shape";
import { markdownToPlaintext, getNoteRow, insertNote } from "@/lib/store/notes";
import {
  assigneesByTask,
  getTaskRow,
  linksByTask,
  listTaskRows,
} from "@/lib/store/tasks";
import { OBJ_COMPANIES, SEED_COMPANY_NORTHWIND, SEED_WORKSPACE_ID } from "@/lib/seed";

// Resource fidelity — the fields an agent trained on the real API notices.

const db = makeSeededDb();
const ctx = testCtx(db);

const northwind = () =>
  queryRecords(db, "companies", { filter: { name: "Northwind" } })[0] as {
    id: Record<string, string>;
    created_at: string;
    web_url: string;
    values: Record<string, Array<Record<string, unknown>>>;
  };

describe("timestamps", () => {
  it("emits exactly nine fractional digits", () => {
    expect(toAttioTimestamp(Date.UTC(2026, 6, 27, 13, 0, 0, 5))).toBe(
      "2026-07-27T13:00:00.005000000Z",
    );
    expect(northwind().created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
  });
});

describe("record", () => {
  it("carries the three-key id object and a singular web_url", () => {
    const record = northwind();
    expect(Object.keys(record.id).sort()).toEqual(["object_id", "record_id", "workspace_id"]);
    expect(record.id.workspace_id).toBe(SEED_WORKSPACE_ID);
    // "company", not "companies" — the detail that gives a fake URL away.
    expect(record.web_url).toBe(
      `https://app.attio.com/acme/company/${SEED_COMPANY_NORTHWIND}`,
    );
  });

  it("keys values by api_slug and always holds an array", () => {
    const values = northwind().values;
    expect(Array.isArray(values.name)).toBe(true);
    expect(values.name).toHaveLength(1);
  });

  it("omits an attribute with no active value rather than emitting []", () => {
    const id = "44444444-4444-4444-8444-444444444444";
    newRecord(db, "companies", id);
    writeValues(
      db,
      { recordId: id, objectId: OBJ_COMPANIES, objectSlug: "companies" },
      { name: "Sparse Co" },
      { atMs: NOW, actor: OWNER_ACTOR, mode: "create", isSandboxCreated: false },
    );
    const record = queryRecords(db, "companies", { filter: { name: "Sparse Co" } })[0] as {
      values: Record<string, unknown>;
    };
    expect(record.values).not.toHaveProperty("description");
    expect(record.values).not.toHaveProperty("domains");
  });
});

describe("value types", () => {
  it("derives every email part from the stored address", () => {
    const ana = queryRecords(db, "people", { filter: { name: { first_name: "Ana" } } })[0] as {
      values: Record<string, Array<Record<string, unknown>>>;
    };
    expect(ana.values.email_addresses[0]).toMatchObject({
      original_email_address: "ana@northwind.example",
      email_address: "ana@northwind.example",
      email_domain: "northwind.example",
      email_root_domain: "northwind.example",
      email_local_specifier: "ana",
    });
  });

  it("reduces a domain to its registrable root", () => {
    expect(rootDomainOf("mail.eu.northwind.example")).toBe("northwind.example");
    expect(northwind().values.domains[0]).toMatchObject({
      domain: "northwind.example",
      root_domain: "northwind.example",
    });
  });

  it("emits currency_value as a NUMBER and the code off the attribute", () => {
    const deal = queryRecords(db, "deals", { filter: { stage: "In Progress" } })[0] as {
      values: Record<string, Array<Record<string, unknown>>>;
    };
    expect(deal.values.value[0].currency_value).toBe(48000);
    expect(typeof deal.values.value[0].currency_value).toBe("number");
    expect(deal.values.value[0].currency_code).toBe("USD");
  });

  it("nests a status under a four-key id object", () => {
    const deal = queryRecords(db, "deals", { filter: { stage: "In Progress" } })[0] as {
      values: Record<string, Array<Record<string, unknown>>>;
    };
    const status = deal.values.stage[0].status as {
      id: Record<string, string>;
      title: string;
      is_archived: boolean;
      celebration_enabled: boolean;
      target_time_in_status: string | null;
    };
    expect(Object.keys(status.id).sort()).toEqual([
      "attribute_id",
      "object_id",
      "status_id",
      "workspace_id",
    ]);
    expect(status.title).toBe("In Progress");
    expect(status.is_archived).toBe(false);
    expect(status.celebration_enabled).toBe(false);
    expect(status.target_time_in_status).toBeNull();
    // The versioning pair is honest: this value opened when the deal moved.
    expect(deal.values.stage[0].active_until).toBeNull();
  });

  it("splits a personal name into three parts", () => {
    const ana = queryRecords(db, "people", { filter: { name: { first_name: "Ana" } } })[0] as {
      values: Record<string, Array<Record<string, unknown>>>;
    };
    expect(ana.values.name[0]).toMatchObject({
      first_name: "Ana",
      last_name: "Mireles",
      full_name: "Ana Mireles",
    });
  });

  it("separates a referenced actor from the actor who wrote the value", () => {
    const deal = queryRecords(db, "deals", { filter: { stage: "In Progress" } })[0] as {
      values: Record<string, Array<Record<string, unknown>>>;
    };
    expect(deal.values.owner[0].referenced_actor_type).toBe("workspace-member");
    expect(deal.values.owner[0]).toHaveProperty("created_by_actor");
  });
});

describe("tasks and notes", () => {
  it("reads linked_records back with the _id suffix writes do not use", () => {
    const row = listTaskRows(db, { limit: 10, offset: 0, sort: "created_at:asc" })[0];
    const shaped = shapeTask(
      ctx,
      row,
      linksByTask(db, [row.id]).get(row.id) ?? [],
      assigneesByTask(db, [row.id]).get(row.id) ?? [],
    ) as { linked_records: Array<Record<string, unknown>>; assignees: unknown[] };
    expect(shaped.linked_records[0]).toHaveProperty("target_object_id");
    expect(shaped.linked_records[0]).not.toHaveProperty("target_object");
    expect(shaped).not.toHaveProperty("tags");
  });

  it("completes a task with a timestamp and leaves an open one null", () => {
    const rows = listTaskRows(db, { limit: 10, offset: 0, sort: "created_at:asc" });
    const shaped = rows.map(
      (row) => shapeTask(ctx, row, [], []) as { is_completed: boolean; completed_at: unknown },
    );
    expect(shaped.find((t) => t.is_completed)!.completed_at).toMatch(/\.\d{9}Z$/);
    expect(shaped.find((t) => !t.is_completed)!.completed_at).toBeNull();
  });

  it("keeps markdown markers in content_markdown and drops them in plaintext", () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const markdown = "# Heading\n- **bold** item";
    insertNote(db, {
      id,
      parentObject: "companies",
      parentRecordId: SEED_COMPANY_NORTHWIND,
      title: "Shaped",
      contentMarkdown: markdown,
      contentPlaintext: markdownToPlaintext(markdown),
      actorType: "api-token",
      actorId: null,
      createdAtMs: NOW,
    });
    const shaped = shapeNote(ctx, getNoteRow(db, id)!) as Record<string, unknown>;
    expect(shaped.content_markdown).toBe(markdown);
    expect(shaped.content_plaintext).toBe("Heading\nbold item");
    // Attio marks both required on a note; this sandbox has no meetings and no
    // @-tagging, so both are present and empty rather than absent.
    expect(shaped.meeting_id).toBeNull();
    expect(shaped.tags).toEqual([]);
  });
});

describe("self", () => {
  it("carries the five token fields a validating client requires", () => {
    const self = shapeSelf(ctx, Date.UTC(2026, 6, 27, 13, 0, 0)) as Record<string, unknown>;
    expect(self.exp).toBeNull();
    expect(self.iat).toBe(Math.floor(Date.UTC(2026, 6, 27, 13, 0, 0) / 1000));
    expect(self.sub).toBe(SEED_WORKSPACE_ID);
    expect(self.aud).toBe(self.client_id);
    expect(self.iss).toBe("attio.com");
    expect(self.workspace_slug).toBe("acme");
    // Not wrapped in `data`, which is the one place this surface differs.
    expect(self).not.toHaveProperty("data");
  });
});

describe("task lookups", () => {
  it("finds a task by its linked record and by assignee email", () => {
    const byRecord = listTaskRows(db, {
      limit: 10,
      offset: 0,
      sort: "created_at:asc",
      linkedObject: "deals",
      isCompleted: false,
    });
    expect(byRecord).toHaveLength(1);
    expect(byRecord[0].content_plaintext).toBe("Send Northwind the renewal quote");

    const byAssignee = listTaskRows(db, {
      limit: 10,
      offset: 0,
      sort: "created_at:asc",
      assignee: "PRIYA@ACME.CO",
    });
    expect(byAssignee.map((t) => t.content_plaintext)).toEqual([
      "Chase Vertex for the pilot scope doc",
    ]);

    expect(
      listTaskRows(db, { limit: 10, offset: 0, sort: "created_at:asc", assignee: "null" }),
    ).toHaveLength(0);
    expect(getTaskRow(db, "nope")).toBeNull();
  });
});
