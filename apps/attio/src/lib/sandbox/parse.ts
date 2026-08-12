import { BadRequestError } from "./auth";
import { SEED_STAGES } from "../seed";
import type {
  ParsedCompany,
  ParsedDeal,
  ParsedMember,
  ParsedNote,
  ParsedPerson,
  ParsedSeed,
  ParsedTask,
  WireNoteFormat,
  WirePerson,
} from "./types";

// Validating a cloned business on the way into the CRM. Everything here fails
// loudly with a message that names the offending path and says what to fix: a
// seed that is half-understood produces a pipeline the agent quietly reasons
// about wrongly, which is far worse than a run that refuses to start.
//
// The rule doing the most work is cast membership. A twin must never invent an
// identity — the Ana Mireles on the Northwind deal is only the same person as
// the Ana in the inbox because both came out of the one cast — so an owner or an
// assignee the world has never heard of is a 400, not a new workspace member.

export { BadRequestError };

const OBJECT_SLUGS = new Set(["companies", "people", "deals"]);

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestError(`${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function array(source: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) throw new BadRequestError(`${where}.${key} must be an array`);
  return value;
}

/** For the list fields a hand-written seed reasonably leaves off entirely. */
function optionalArray(source: Record<string, unknown>, key: string, where: string): unknown[] {
  return source[key] === undefined || source[key] === null ? [] : array(source, key, where);
}

function text(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new BadRequestError(`${where}.${key} must be a non-empty string`);
  }
  return value;
}

/** Absent, null and "" all mean "no value" for the optional prose fields. */
function optionalText(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new BadRequestError(`${where}.${key} must be a string`);
  return value;
}

function flag(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new BadRequestError(`${where}.${key} must be a boolean`);
  return value;
}

function number(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BadRequestError(`${where}.${key} must be a finite number`);
  }
  return value;
}

function instant(source: Record<string, unknown>, key: string, where: string): number {
  const raw = text(source, key, where);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new BadRequestError(
      `${where}.${key} must be an absolute ISO 8601 timestamp, got "${raw}"`,
    );
  }
  return ms;
}

function uniqueIds(ids: string[], where: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new BadRequestError(`${where} has two entries with id "${id}"`);
    seen.add(id);
  }
}

function castOf(world: Record<string, unknown>): WirePerson[] {
  return array(world, "cast", "seed.world").map((entry, i) => {
    const where = `seed.world.cast[${i}]`;
    const person = object(entry, where);
    return {
      id: text(person, "id", where),
      name: text(person, "name", where),
      email: text(person, "email", where),
    };
  });
}

/** Attio stores a person's name in three parts, the wire carries one string. */
function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

function requireCast(known: Map<string, string>, email: string, where: string): string {
  const name = known.get(email.toLowerCase());
  if (name === undefined) {
    throw new BadRequestError(
      `${where} "${email}" is not in seed.world.cast — add them to the cast the other ` +
        `twins seeded from, rather than to the CRM alone`,
    );
  }
  return name;
}

/** The whole request, checked. Throws `BadRequestError` with a fixable message. */
export function parseSeedRequest(body: unknown): ParsedSeed {
  const root = object(body, "body");

  // Redundant with the URL on purpose: a mis-routed seed has to be loud, because
  // the alternative is an empty CRM that answers 200.
  if (root.twin !== "attio") {
    throw new BadRequestError(
      `this twin seeds 'attio', not ${JSON.stringify(root.twin)} — post the attio wire ` +
        `seed here and the others to their own twins`,
    );
  }

  const seed = object(root.seed, "seed");
  const world = object(seed.world, "seed.world");
  const business = object(world.business, "seed.world.business");
  const cast = castOf(world);
  // email (lowercased) -> the cast's spelling of that person's name.
  const known = new Map(cast.map((p) => [p.email.toLowerCase(), p.name]));

  const ownerEmail = text(seed, "ownerEmail", "seed");
  const ownerName = requireCast(known, ownerEmail, "seed.ownerEmail");

  const workspace = object(seed.workspace, "seed.workspace");

  const members: ParsedMember[] = array(seed, "members", "seed").map((entry, i) => {
    const where = `seed.members[${i}]`;
    const raw = object(entry, where);
    const email = text(raw, "email", where);
    const { firstName, lastName } = splitName(requireCast(known, email, `${where}.email`));
    return {
      id: text(raw, "id", where),
      firstName,
      lastName,
      email,
      accessLevel: optionalText(raw, "accessLevel", where) || "admin",
    };
  });
  uniqueIds(
    members.map((m) => m.id),
    "seed.members",
  );
  if (!members.some((m) => m.email.toLowerCase() === ownerEmail.toLowerCase())) {
    throw new BadRequestError(
      `seed.ownerEmail "${ownerEmail}" is not among seed.members — the workspace owner ` +
        `must be a member of the workspace they own`,
    );
  }

  const companies: ParsedCompany[] = array(seed, "companies", "seed").map((entry, i) => {
    const where = `seed.companies[${i}]`;
    const raw = object(entry, where);
    const domains = optionalArray(raw, "domains", where).map((d, j) => {
      if (typeof d !== "string" || !d.trim()) {
        throw new BadRequestError(`${where}.domains[${j}] must be a hostname`);
      }
      return d;
    });
    return {
      id: text(raw, "id", where),
      name: text(raw, "name", where),
      domains,
      description: optionalText(raw, "description", where),
    };
  });
  uniqueIds(
    companies.map((c) => c.id),
    "seed.companies",
  );
  const companyIds = new Set(companies.map((c) => c.id));

  const people: ParsedPerson[] = array(seed, "people", "seed").map((entry, i) => {
    const where = `seed.people[${i}]`;
    const raw = object(entry, where);
    const email = text(raw, "email", where);
    requireCast(known, email, `${where}.email`);
    const fullName = text(raw, "name", where);
    const companyId = text(raw, "companyId", where);
    if (!companyIds.has(companyId)) {
      throw new BadRequestError(
        `${where}.companyId "${companyId}" names no company in seed.companies`,
      );
    }
    return {
      id: text(raw, "id", where),
      ...splitName(fullName),
      fullName,
      email,
      jobTitle: optionalText(raw, "jobTitle", where),
      companyId,
    };
  });
  uniqueIds(
    people.map((p) => p.id),
    "seed.people",
  );
  const peopleIds = new Set(people.map((p) => p.id));

  const deals: ParsedDeal[] = array(seed, "deals", "seed").map((entry, i) => {
    const where = `seed.deals[${i}]`;
    const raw = object(entry, where);
    const stage = text(raw, "stage", where);
    if (!(SEED_STAGES as readonly string[]).includes(stage)) {
      // Attio errors rather than creating a status, and a deal parked at a stage
      // the pipeline does not have is a world no episode can grade.
      throw new BadRequestError(
        `${where}.stage "${stage}" is not one of ${SEED_STAGES.join(" | ")}`,
      );
    }
    const companyId = text(raw, "companyId", where);
    if (!companyIds.has(companyId)) {
      throw new BadRequestError(
        `${where}.companyId "${companyId}" names no company in seed.companies`,
      );
    }
    const ownerEmailValue = text(raw, "ownerEmail", where);
    requireCast(known, ownerEmailValue, `${where}.ownerEmail`);
    if (!members.some((m) => m.email.toLowerCase() === ownerEmailValue.toLowerCase())) {
      throw new BadRequestError(
        `${where}.ownerEmail "${ownerEmailValue}" is not among seed.members — a deal can ` +
          `only be owned by a workspace member`,
      );
    }
    const linked = optionalArray(raw, "peopleIds", where).map((p, j) => {
      if (typeof p !== "string" || !peopleIds.has(p)) {
        throw new BadRequestError(
          `${where}.peopleIds[${j}] ${JSON.stringify(p)} names no person in seed.people`,
        );
      }
      return p;
    });
    return {
      id: text(raw, "id", where),
      name: text(raw, "name", where),
      stage,
      value: number(raw, "value", where),
      ownerEmail: ownerEmailValue,
      companyId,
      peopleIds: linked,
    };
  });
  uniqueIds(
    deals.map((d) => d.id),
    "seed.deals",
  );

  const recordIdsByObject: Record<string, Set<string>> = {
    companies: companyIds,
    people: peopleIds,
    deals: new Set(deals.map((d) => d.id)),
  };

  function checkReference(objectSlug: string, recordId: string, where: string): void {
    if (!OBJECT_SLUGS.has(objectSlug)) {
      throw new BadRequestError(
        `${where} names object "${objectSlug}"; this twin has ${[...OBJECT_SLUGS].join(", ")}`,
      );
    }
    if (!recordIdsByObject[objectSlug].has(recordId)) {
      throw new BadRequestError(
        `${where} "${recordId}" names no record in seed.${objectSlug}`,
      );
    }
  }

  const notes: ParsedNote[] = optionalArray(seed, "notes", "seed").map((entry, i) => {
    const where = `seed.notes[${i}]`;
    const raw = object(entry, where);
    const parentObject = text(raw, "parentObject", where);
    const parentRecordId = text(raw, "parentRecordId", where);
    checkReference(parentObject, parentRecordId, `${where}.parentRecordId`);
    const format = optionalText(raw, "format", where) || "plaintext";
    if (format !== "plaintext" && format !== "markdown") {
      throw new BadRequestError(`${where}.format must be "plaintext" or "markdown"`);
    }
    return {
      id: text(raw, "id", where),
      parentObject,
      parentRecordId,
      title: text(raw, "title", where),
      content: optionalText(raw, "content", where),
      format: format as WireNoteFormat,
      createdMs: instant(raw, "createdISO", where),
    };
  });
  uniqueIds(
    notes.map((n) => n.id),
    "seed.notes",
  );

  const tasks: ParsedTask[] = optionalArray(seed, "tasks", "seed").map((entry, i) => {
    const where = `seed.tasks[${i}]`;
    const raw = object(entry, where);
    const linkedRecords = optionalArray(raw, "linkedRecords", where).map((link, j) => {
      const at = `${where}.linkedRecords[${j}]`;
      const parsed = object(link, at);
      const objectSlug = text(parsed, "object", at);
      const recordId = text(parsed, "recordId", at);
      checkReference(objectSlug, recordId, `${at}.recordId`);
      return { object: objectSlug, recordId };
    });
    const assigneeEmail = raw.assigneeEmail;
    if (assigneeEmail !== null && assigneeEmail !== undefined) {
      if (typeof assigneeEmail !== "string") {
        throw new BadRequestError(`${where}.assigneeEmail must be a string or null`);
      }
      requireCast(known, assigneeEmail, `${where}.assigneeEmail`);
      if (!members.some((m) => m.email.toLowerCase() === assigneeEmail.toLowerCase())) {
        throw new BadRequestError(
          `${where}.assigneeEmail "${assigneeEmail}" is not among seed.members — only a ` +
            `workspace member can hold a task`,
        );
      }
    }
    const deadline = raw.deadlineAt;
    if (deadline !== null && deadline !== undefined && typeof deadline !== "string") {
      throw new BadRequestError(`${where}.deadlineAt must be a string or null`);
    }
    return {
      id: text(raw, "id", where),
      content: text(raw, "content", where),
      // Stored and echoed verbatim: Attio returns a deadline exactly as it was
      // written, so normalising it here would lose the caller's own format.
      deadlineAt: (deadline as string | null | undefined) ?? null,
      isCompleted: flag(raw, "isCompleted", where),
      linkedRecords,
      assigneeEmail: (assigneeEmail as string | null | undefined) ?? null,
      createdMs: instant(raw, "createdISO", where),
    };
  });
  uniqueIds(
    tasks.map((t) => t.id),
    "seed.tasks",
  );

  const promote = seed.promoteToSnapshot;
  if (promote !== undefined && typeof promote !== "boolean") {
    throw new BadRequestError("seed.promoteToSnapshot must be a boolean when present");
  }

  return {
    nowMs: instant(seed, "nowISO", "seed"),
    businessName: text(business, "name", "seed.world.business"),
    workspaceName: text(workspace, "name", "seed.workspace"),
    workspaceSlug: text(workspace, "slug", "seed.workspace"),
    ownerEmail,
    ownerName,
    promoteToSnapshot: promote === true,
    members,
    companies,
    people,
    deals,
    notes,
    tasks,
  };
}
