import { startNewSession } from "../audit";
import { applySchema, getDb } from "../db";
import { snapshotWorking } from "../reset";
import { installStandardSchema } from "../seed";
import { newUuid } from "../attio/ids";
import { writeValues } from "../attio/values";
import type { Actor } from "../attio/shape";
import { insertMember } from "../store/members";
import { setMeta } from "../store/meta";
import { insertRecord } from "../store/records";
import { insertNote, markdownToPlaintext } from "../store/notes";
import { insertTask } from "../store/tasks";
import { getObjectBySlug } from "../store/objects";
import type { ParsedSeed, SeedResult } from "./types";

// Loading a cloned business into the CRM.
//
// Total, never additive: the previous company is deleted first, because a CRM
// carrying two companies' pipelines is a world no episode described. Everything
// is written verbatim — the seed's own ids and absolute timestamps — so the deal
// the director later moves by id is the deal the seed created, and the Ana on
// the Northwind renewal is the Ana in the inbox.
//
// Snapshot handling mirrors the sibling twins: with `promoteToSnapshot` the
// seeded state becomes what every later reset in the run returns to, which is
// what lets a generated business survive an episode.

// Child-first, so no delete ever trips a foreign key.
const TABLES = [
  "attribute_values",
  "task_assignees",
  "task_linked_records",
  "tasks",
  "notes",
  "records",
  "statuses",
  "attributes",
  "objects",
  "workspace_members",
  "meta",
];

export function seedFromWire(seed: ParsedSeed): SeedResult {
  const db = getDb();
  // Idempotent, and it makes a working.db that was never `db:init`ed seedable.
  applySchema(db);

  const workspaceId = newUuid();
  const ownerMember = seed.members.find(
    (m) => m.email.toLowerCase() === seed.ownerEmail.toLowerCase(),
  );
  // parse.ts already refused a seed whose owner is not a member; this is the
  // type narrowing, not a second check.
  if (!ownerMember) throw new Error("seed.ownerEmail is not among seed.members");
  const owner: Actor = { type: "workspace-member", id: ownerMember.id };

  const write = db.transaction(() => {
    for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();

    setMeta(db, "workspace_id", workspaceId);
    setMeta(db, "workspace_name", seed.workspaceName);
    setMeta(db, "workspace_slug", seed.workspaceSlug);
    setMeta(db, "owner_email", seed.ownerEmail);
    setMeta(db, "owner_name", seed.ownerName);
    setMeta(db, "owner_member_id", ownerMember.id);
    setMeta(db, "seeded_at", String(seed.nowMs));

    for (const member of seed.members) {
      insertMember(db, {
        id: member.id,
        firstName: member.firstName,
        lastName: member.lastName,
        emailAddress: member.email,
        accessLevel: member.accessLevel,
        createdAtMs: seed.nowMs,
      });
    }

    // The schema the demo seed installs, so the two seeders cannot disagree
    // about what a deal is.
    installStandardSchema(db, seed.nowMs);
    const companies = getObjectBySlug(db, "companies");
    const people = getObjectBySlug(db, "people");
    const deals = getObjectBySlug(db, "deals");
    if (!companies || !people || !deals) throw new Error("standard schema did not install");

    // Authored at the world's instant, not at wall-clock time: re-seeding the
    // same world twice has to produce the same CRM. Seeded history belongs to
    // the world, so nothing here carries the sandbox-created flag.
    const writeOpts = {
      atMs: seed.nowMs,
      actor: owner,
      mode: "create" as const,
      isSandboxCreated: false,
    };

    for (const company of seed.companies) {
      insertRecord(db, { id: company.id, objectId: companies.id, createdAtMs: seed.nowMs });
      writeValues(
        db,
        { recordId: company.id, objectId: companies.id, objectSlug: "companies" },
        {
          name: company.name,
          ...(company.domains.length ? { domains: company.domains } : {}),
          ...(company.description ? { description: company.description } : {}),
        },
        writeOpts,
      );
    }

    for (const person of seed.people) {
      insertRecord(db, { id: person.id, objectId: people.id, createdAtMs: seed.nowMs });
      writeValues(
        db,
        { recordId: person.id, objectId: people.id, objectSlug: "people" },
        {
          name: {
            first_name: person.firstName,
            last_name: person.lastName,
            full_name: person.fullName,
          },
          email_addresses: [person.email],
          ...(person.jobTitle ? { job_title: person.jobTitle } : {}),
          company: { target_object: "companies", target_record_id: person.companyId },
        },
        writeOpts,
      );
    }

    for (const deal of seed.deals) {
      insertRecord(db, { id: deal.id, objectId: deals.id, createdAtMs: seed.nowMs });
      writeValues(
        db,
        { recordId: deal.id, objectId: deals.id, objectSlug: "deals" },
        {
          name: deal.name,
          stage: deal.stage,
          value: deal.value,
          owner: deal.ownerEmail,
          associated_company: {
            target_object: "companies",
            target_record_id: deal.companyId,
          },
          ...(deal.peopleIds.length
            ? {
                associated_people: deal.peopleIds.map((id) => ({
                  target_object: "people",
                  target_record_id: id,
                })),
              }
            : {}),
        },
        writeOpts,
      );
    }

    for (const note of seed.notes) {
      const markdown = note.content;
      insertNote(db, {
        id: note.id,
        parentObject: note.parentObject,
        parentRecordId: note.parentRecordId,
        title: note.title,
        contentMarkdown: markdown,
        contentPlaintext:
          note.format === "markdown" ? markdownToPlaintext(markdown) : note.content,
        actorType: "workspace-member",
        actorId: ownerMember.id,
        createdAtMs: note.createdMs,
        isSandboxCreated: false,
      });
    }

    const memberByEmail = new Map(
      seed.members.map((m) => [m.email.toLowerCase(), m.id] as const),
    );
    for (const task of seed.tasks) {
      const assigneeId = task.assigneeEmail
        ? memberByEmail.get(task.assigneeEmail.toLowerCase())
        : undefined;
      insertTask(db, {
        id: task.id,
        contentPlaintext: task.content,
        deadlineAt: task.deadlineAt,
        isCompleted: task.isCompleted,
        completedAtMs: task.isCompleted ? task.createdMs : null,
        actorType: "workspace-member",
        actorId: ownerMember.id,
        createdAtMs: task.createdMs,
        isSandboxCreated: false,
        linkedRecords: task.linkedRecords.map((l) => ({
          targetObject: l.object,
          targetRecordId: l.recordId,
        })),
        assignees: assigneeId
          ? [{ actorType: "workspace-member", actorId: assigneeId }]
          : [],
      });
    }
  });

  write();

  // Read back out of the DB: it is what the dashboard shows a user asking "did
  // that work?", so it has to be what actually landed.
  const count = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  const bySlug = (slug: string) =>
    count(
      "SELECT COUNT(*) AS n FROM records r JOIN objects o ON o.id = r.object_id WHERE o.api_slug = ?",
      slug,
    );
  const counts = {
    companies: bySlug("companies"),
    people: bySlug("people"),
    deals: bySlug("deals"),
    notes: count("SELECT COUNT(*) AS n FROM notes"),
    tasks: count("SELECT COUNT(*) AS n FROM tasks"),
  };

  // Closes and reopens the working handle, so nothing may hold `db` past here.
  if (seed.promoteToSnapshot) snapshotWorking();

  // A new world deserves a new audit session: the trail the judge reads must not
  // begin in the middle of the company that was here before.
  startNewSession(getDb(), `seeded ${seed.businessName}`, seed.nowMs);

  return { ok: true, counts };
}
