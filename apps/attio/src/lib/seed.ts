import type { Database } from "better-sqlite3";
import { writeValues } from "./attio/values";
import type { Actor } from "./attio/shape";
import { insertAttribute, insertObject, insertStatus } from "./store/objects";
import { insertMember } from "./store/members";
import { insertRecord } from "./store/records";
import { insertNote, markdownToPlaintext } from "./store/notes";
import { insertTask } from "./store/tasks";
import { setMeta } from "./store/meta";

// The synthetic demo world, so the clone runs with no orchestrator and no real
// Attio account.
//
// It deliberately shares its people and its domains with the Gmail and Calendar
// twins' seeds — sandbox.user@gmail.com, priya@acme.co, Acme, Northwind — so a
// cloned business is coherent across surfaces: the client whose escalation call
// sits on the calendar is the account whose deal is in the CRM.
//
// Every id below is a literal UUID constant, generated once at implementation
// time and pasted in. They must LOOK like real v4 UUIDs so an agent cannot tell
// a seeded record from one it created, and they must never be minted at seed
// time or the database stops being byte-identical between runs.

/** Monday 2026-07-27 09:00 America/New_York — the week the Calendar twin anchors to. */
export const SEED_NOW_MS = Date.UTC(2026, 6, 27, 13, 0, 0);

const DAY_MS = 86_400_000;
const daysBefore = (n: number) => SEED_NOW_MS - n * DAY_MS;

export const SEED_WORKSPACE_ID = "08cf6431-9c65-45e3-96d8-2ee9745159cd";
export const SEED_WORKSPACE_SLUG = "acme";
export const SEED_WORKSPACE_NAME = "Acme";
export const SEED_OWNER_EMAIL = "sandbox.user@gmail.com";
export const SEED_OWNER_NAME = "Sandbox User";
export const SEED_MEMBER_OWNER = "150ca79e-0518-4c16-9db7-4fedee77db3f";
export const SEED_MEMBER_PRIYA = "560d6f33-5446-4c4d-9eb9-6e31932d2a83";

export const OBJ_COMPANIES = "29484ba4-35df-419f-a26d-cb558181a72a";
export const OBJ_PEOPLE = "01887e8f-18ad-4f70-aa59-2e6c19fa59ff";
export const OBJ_DEALS = "fbd798bd-16dd-43d7-8abb-a30ea9c32cfe";

const ATTR_CO_NAME = "2dcfca85-b51c-41eb-a811-b33ba33467b4";
const ATTR_CO_DOMAINS = "b91d8a60-896c-4ffb-945d-7d3a2c831f24";
const ATTR_CO_DESC = "4cdf7f3f-40c5-4e73-bb84-594be529b100";
const ATTR_PE_NAME = "7327d1e8-7a7f-4903-b741-ff749a8cdf29";
const ATTR_PE_EMAILS = "da0a550a-8e5f-4597-aaa2-11890090ae14";
const ATTR_PE_TITLE = "7ce53c48-6a3e-4d16-823e-45ffe565e32f";
const ATTR_PE_COMPANY = "2dc9bfd0-0234-4a45-9628-4f46be0bae69";
const ATTR_DE_NAME = "41284860-a5c9-4170-8cb8-13296307da93";
export const ATTR_DE_STAGE = "23ff4166-9842-4a13-b9bf-d19a432c80d2";
const ATTR_DE_VALUE = "4514e32f-d7c5-42b4-8093-5f131ab1fa63";
const ATTR_DE_OWNER = "87087ea1-705c-4411-a4ca-a57f2870482e";
const ATTR_DE_COMPANY = "58fb742e-e450-47b8-9911-b50e276a30da";
const ATTR_DE_PEOPLE = "8fd62639-3e87-46fc-a43b-2790955786fe";

const ST_LEAD = "12adecd1-609b-4391-aed0-9fd152442e6f";
const ST_IN_PROGRESS = "b6f429c3-4a4c-49e7-a311-43b9188b4854";
const ST_WON = "2066e89e-a419-4210-aa35-b8f66b999cc3";
const ST_LOST = "6a67057d-c342-4a40-812f-2b515b96d140";

/** The four stages Attio's own deals template ships with. */
export const SEED_STAGES = ["Lead", "In Progress", "Won 🎉", "Lost"] as const;

export const SEED_COMPANY_NORTHWIND = "71863cef-2a60-43ae-aaaf-cd55b6129d4d";
const CO_VERTEX = "d32ff129-975c-40cc-b853-3d071eee0e79";
const CO_HARBOR = "6cff474d-b669-40bd-b157-139903a1c8bc";
export const SEED_PERSON_ANA = "8ccc6446-e86d-4ac0-a04f-3d1e4a54fd0e";
const PE_TOM = "80dff96b-058b-4208-ba3d-31b612a4e789";
const PE_RACHEL = "2edf2b14-ee76-4441-b899-11de9a56629d";
export const SEED_DEAL_NORTHWIND = "31fedb90-c349-41f5-b9eb-5c344b6737dd";
const DEAL_VERTEX = "5dff02ba-d28f-40e9-8eda-6787e80b2845";
const DEAL_HARBOR = "06076623-b9fc-4dbb-b607-e1ce14a66885";

const NOTE_ESCALATION = "be6340ce-4bec-4986-8748-5e0589ba40b6";
const NOTE_INTRO = "f1aafa6d-79f2-43e3-8010-d200caf6d804";
const NOTE_SCOPE = "a5261f3e-a503-4d2b-843d-ec6c1f2a85a3";
const TASK_QUOTE = "bdd8dfa2-aae4-424f-a371-82327b538501";
const TASK_CHASE = "4516edef-9f91-4bba-9762-ace32cb28c2e";

/** The instant the Northwind renewal moved off Lead — the superseded stage row. */
export const SEED_STAGE_MOVE_MS = daysBefore(4);

/**
 * The object/attribute/status registry, shared by this demo seed and the wire
 * seeder so the two can never define different CRMs. Called before any record
 * exists, because a record is nothing but values against these attributes.
 */
export function installStandardSchema(db: Database, atMs: number): void {
  insertObject(db, {
    id: OBJ_COMPANIES,
    apiSlug: "companies",
    singularNoun: "company",
    createdAtMs: atMs,
    pos: 0,
  });
  insertObject(db, {
    id: OBJ_PEOPLE,
    apiSlug: "people",
    singularNoun: "person",
    createdAtMs: atMs,
    pos: 1,
  });
  insertObject(db, {
    id: OBJ_DEALS,
    apiSlug: "deals",
    singularNoun: "deal",
    createdAtMs: atMs,
    pos: 2,
  });

  const attr = (
    id: string,
    objectId: string,
    apiSlug: string,
    title: string,
    type: string,
    pos: number,
    extra: { isMultiselect?: boolean; currencyCode?: string } = {},
  ) => insertAttribute(db, { id, objectId, apiSlug, title, type, pos, createdAtMs: atMs, ...extra });

  attr(ATTR_CO_NAME, OBJ_COMPANIES, "name", "Name", "text", 0);
  attr(ATTR_CO_DOMAINS, OBJ_COMPANIES, "domains", "Domains", "domain", 1, {
    isMultiselect: true,
  });
  attr(ATTR_CO_DESC, OBJ_COMPANIES, "description", "Description", "text", 2);

  attr(ATTR_PE_NAME, OBJ_PEOPLE, "name", "Name", "personal-name", 0);
  attr(ATTR_PE_EMAILS, OBJ_PEOPLE, "email_addresses", "Email addresses", "email-address", 1, {
    isMultiselect: true,
  });
  attr(ATTR_PE_TITLE, OBJ_PEOPLE, "job_title", "Job title", "text", 2);
  attr(ATTR_PE_COMPANY, OBJ_PEOPLE, "company", "Company", "record-reference", 3);

  attr(ATTR_DE_NAME, OBJ_DEALS, "name", "Name", "text", 0);
  attr(ATTR_DE_STAGE, OBJ_DEALS, "stage", "Stage", "status", 1);
  attr(ATTR_DE_VALUE, OBJ_DEALS, "value", "Deal value", "currency", 2, { currencyCode: "USD" });
  attr(ATTR_DE_OWNER, OBJ_DEALS, "owner", "Owner", "actor-reference", 3);
  attr(ATTR_DE_COMPANY, OBJ_DEALS, "associated_company", "Company", "record-reference", 4);
  attr(ATTR_DE_PEOPLE, OBJ_DEALS, "associated_people", "People", "record-reference", 5, {
    isMultiselect: true,
  });

  const stageIds = [ST_LEAD, ST_IN_PROGRESS, ST_WON, ST_LOST];
  SEED_STAGES.forEach((title, pos) =>
    insertStatus(db, {
      id: stageIds[pos],
      attributeId: ATTR_DE_STAGE,
      title,
      celebrationEnabled: title === "Won 🎉",
      pos,
    }),
  );
}

interface SeedRecord {
  id: string;
  objectId: string;
  objectSlug: string;
  createdAtMs: number;
  values: Record<string, unknown>;
}

const COMPANIES: SeedRecord[] = [
  {
    id: SEED_COMPANY_NORTHWIND,
    objectId: OBJ_COMPANIES,
    objectSlug: "companies",
    createdAtMs: daysBefore(400),
    values: {
      name: "Northwind",
      domains: ["northwind.example"],
      description: "Logistics platform customer since 2023. Renewal owned by the Acme team.",
    },
  },
  {
    id: CO_VERTEX,
    objectId: OBJ_COMPANIES,
    objectSlug: "companies",
    createdAtMs: daysBefore(60),
    values: {
      name: "Vertex Logistics",
      domains: ["vertex.example"],
      description: "Regional freight broker evaluating the platform. Pilot not yet started.",
    },
  },
  {
    id: CO_HARBOR,
    objectId: OBJ_COMPANIES,
    objectSlug: "companies",
    createdAtMs: daysBefore(300),
    values: {
      name: "Harbor Health",
      domains: ["harborhealth.example"],
      description: "Hospital network. Expansion closed in Q2.",
    },
  },
];

const PEOPLE: SeedRecord[] = [
  {
    id: SEED_PERSON_ANA,
    objectId: OBJ_PEOPLE,
    objectSlug: "people",
    createdAtMs: daysBefore(395),
    values: {
      name: { first_name: "Ana", last_name: "Mireles", full_name: "Ana Mireles" },
      email_addresses: ["ana@northwind.example"],
      job_title: "VP Operations",
      company: { target_object: "companies", target_record_id: SEED_COMPANY_NORTHWIND },
    },
  },
  {
    id: PE_TOM,
    objectId: OBJ_PEOPLE,
    objectSlug: "people",
    createdAtMs: daysBefore(58),
    values: {
      name: { first_name: "Tom", last_name: "Ferris", full_name: "Tom Ferris" },
      email_addresses: ["tom@vertex.example"],
      job_title: "Head of Ops",
      company: { target_object: "companies", target_record_id: CO_VERTEX },
    },
  },
  {
    id: PE_RACHEL,
    objectId: OBJ_PEOPLE,
    objectSlug: "people",
    createdAtMs: daysBefore(290),
    values: {
      name: { first_name: "Rachel", last_name: "Boone", full_name: "Rachel Boone" },
      email_addresses: ["rachel@harborhealth.example"],
      job_title: "Director of IT",
      company: { target_object: "companies", target_record_id: CO_HARBOR },
    },
  },
];

const DEALS: SeedRecord[] = [
  {
    id: SEED_DEAL_NORTHWIND,
    objectId: OBJ_DEALS,
    objectSlug: "deals",
    createdAtMs: daysBefore(11),
    values: {
      name: "Northwind — Platform renewal",
      // Opens at Lead and is moved to In Progress four days ago, below.
      stage: "Lead",
      value: 48000,
      owner: SEED_OWNER_EMAIL,
      associated_company: {
        target_object: "companies",
        target_record_id: SEED_COMPANY_NORTHWIND,
      },
      associated_people: [{ target_object: "people", target_record_id: SEED_PERSON_ANA }],
    },
  },
  {
    id: DEAL_VERTEX,
    objectId: OBJ_DEALS,
    objectSlug: "deals",
    createdAtMs: daysBefore(21),
    values: {
      name: "Vertex Logistics — Pilot",
      stage: "Lead",
      value: 12000,
      owner: "priya@acme.co",
      associated_company: { target_object: "companies", target_record_id: CO_VERTEX },
      associated_people: [{ target_object: "people", target_record_id: PE_TOM }],
    },
  },
  {
    id: DEAL_HARBOR,
    objectId: OBJ_DEALS,
    objectSlug: "deals",
    createdAtMs: daysBefore(45),
    values: {
      name: "Harbor Health — Expansion",
      stage: "Won 🎉",
      value: 30000,
      owner: SEED_OWNER_EMAIL,
      associated_company: { target_object: "companies", target_record_id: CO_HARBOR },
      associated_people: [{ target_object: "people", target_record_id: PE_RACHEL }],
    },
  },
];

const ESCALATION_MARKDOWN = [
  "# Escalation",
  "",
  "Payments have been failing for Northwind since the **22nd**. Ana raised it on the",
  "Friday call and wants a fix date before the renewal is signed.",
  "",
  "- Failures started with the 22nd release",
  "- Ana Mireles is the escalation contact",
].join("\n");

/** The whole demo world. Idempotent only against an empty database. */
export function seedDatabase(db: Database): void {
  const owner: Actor = { type: "workspace-member", id: SEED_MEMBER_OWNER };

  setMeta(db, "workspace_id", SEED_WORKSPACE_ID);
  setMeta(db, "workspace_name", SEED_WORKSPACE_NAME);
  setMeta(db, "workspace_slug", SEED_WORKSPACE_SLUG);
  setMeta(db, "owner_email", SEED_OWNER_EMAIL);
  setMeta(db, "owner_name", SEED_OWNER_NAME);
  setMeta(db, "owner_member_id", SEED_MEMBER_OWNER);
  setMeta(db, "seeded_at", String(SEED_NOW_MS));

  insertMember(db, {
    id: SEED_MEMBER_OWNER,
    firstName: "Sandbox",
    lastName: "User",
    emailAddress: SEED_OWNER_EMAIL,
    createdAtMs: daysBefore(500),
  });
  insertMember(db, {
    id: SEED_MEMBER_PRIYA,
    firstName: "Priya",
    lastName: "Nair",
    emailAddress: "priya@acme.co",
    createdAtMs: daysBefore(480),
  });

  installStandardSchema(db, daysBefore(500));

  // Companies before people before deals: every reference below resolves against
  // a record this seed has already written.
  for (const spec of [...COMPANIES, ...PEOPLE, ...DEALS]) {
    insertRecord(db, {
      id: spec.id,
      objectId: spec.objectId,
      createdAtMs: spec.createdAtMs,
    });
    writeValues(
      db,
      { recordId: spec.id, objectId: spec.objectId, objectSlug: spec.objectSlug },
      spec.values,
      { atMs: spec.createdAtMs, actor: owner, mode: "create" },
    );
  }

  // The one piece of history in the seed: the Northwind renewal left Lead four
  // days ago. It goes through the ordinary append path, so a fresh seed
  // DEMONSTRATES the versioned-value model rather than merely claiming it —
  // there are two stage rows, one closed and one open.
  writeValues(
    db,
    {
      recordId: SEED_DEAL_NORTHWIND,
      objectId: OBJ_DEALS,
      objectSlug: "deals",
    },
    { stage: "In Progress" },
    {
      atMs: SEED_STAGE_MOVE_MS,
      actor: owner,
      mode: "append",
    },
  );

  const note = (
    id: string,
    parentObject: string,
    parentRecordId: string,
    title: string,
    markdown: string,
    createdAtMs: number,
  ) =>
    insertNote(db, {
      id,
      parentObject,
      parentRecordId,
      title,
      contentMarkdown: markdown,
      contentPlaintext: markdownToPlaintext(markdown),
      actorType: "workspace-member",
      actorId: SEED_MEMBER_OWNER,
      createdAtMs,
    });

  note(
    NOTE_ESCALATION,
    "companies",
    SEED_COMPANY_NORTHWIND,
    "Escalation: payments failing since the 22nd",
    ESCALATION_MARKDOWN,
    daysBefore(3),
  );
  note(
    NOTE_INTRO,
    "people",
    SEED_PERSON_ANA,
    "Intro call",
    "Ana runs operations for the Northwind depots. Prefers a written summary after every call.",
    daysBefore(390),
  );
  note(
    NOTE_SCOPE,
    "deals",
    SEED_DEAL_NORTHWIND,
    "Renewal scope",
    "Same seat count, plus the audit export add-on. Ana wants a fix date on the payment failures before signing.",
    daysBefore(6),
  );

  insertTask(db, {
    id: TASK_QUOTE,
    contentPlaintext: "Send Northwind the renewal quote",
    deadlineAt: "2026-07-31",
    isCompleted: false,
    completedAtMs: null,
    actorType: "workspace-member",
    actorId: SEED_MEMBER_OWNER,
    createdAtMs: daysBefore(3),
    linkedRecords: [{ targetObject: "deals", targetRecordId: SEED_DEAL_NORTHWIND }],
    assignees: [{ actorType: "workspace-member", actorId: SEED_MEMBER_OWNER }],
  });
  insertTask(db, {
    id: TASK_CHASE,
    contentPlaintext: "Chase Vertex for the pilot scope doc",
    deadlineAt: null,
    isCompleted: true,
    completedAtMs: daysBefore(2),
    actorType: "workspace-member",
    actorId: SEED_MEMBER_PRIYA,
    createdAtMs: daysBefore(9),
    linkedRecords: [{ targetObject: "deals", targetRecordId: DEAL_VERTEX }],
    assignees: [{ actorType: "workspace-member", actorId: SEED_MEMBER_PRIYA }],
  });
}
