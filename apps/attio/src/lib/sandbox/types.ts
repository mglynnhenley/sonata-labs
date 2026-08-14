// The Attio twin's half of the seed contract — the shapes that arrive on the
// wire at /api/sandbox/seed.
//
// Deliberately NOT typed against @sonata/core: a twin is a standalone app that
// must run (and be tested) with no orchestrator installed. Everything below is
// structurally compatible with the eventual `AttioWireSeed`, and that
// compatibility is the contract.
//
// The seed deliberately does NOT carry a generic attribute bag. The CRM's schema
// is fixed — companies, people and deals with Attio's standard attributes — so
// the wire names business facts and the twin owns the mapping. A seed that could
// invent attributes could invent a CRM no episode described.

/** Structurally core's `Person`. Only the fields this twin actually reads. */
export interface WirePerson {
  id: string;
  name: string;
  email: string;
}

/** Structurally core's `WorldSeed`. The cast is what makes the clone coherent. */
export interface WireWorld {
  business: { name: string };
  cast: WirePerson[];
  mailboxOwner: string;
  timezone?: string;
}

export type WireNoteFormat = "plaintext" | "markdown";

export interface AttioWireSeed {
  world: WireWorld;
  /** The instant every relative offset in the source seed was resolved against. */
  nowISO: string;
  /** Make the seeded state the one `reset` returns to. Absent means no. */
  promoteToSnapshot?: boolean;
  ownerEmail: string;
  workspace: { name: string; slug: string };
  members: Array<{ id: string; email: string; accessLevel?: string }>;
  companies: Array<{ id: string; name: string; domains: string[]; description: string }>;
  people: Array<{
    id: string;
    name: string;
    email: string;
    jobTitle: string;
    companyId: string;
  }>;
  deals: Array<{
    id: string;
    name: string;
    stage: string;
    value: number;
    ownerEmail: string;
    companyId: string;
    peopleIds: string[];
  }>;
  notes: Array<{
    id: string;
    parentObject: string;
    parentRecordId: string;
    title: string;
    content: string;
    format?: WireNoteFormat;
    createdISO: string;
  }>;
  tasks: Array<{
    id: string;
    content: string;
    deadlineAt: string | null;
    isCompleted: boolean;
    linkedRecords: Array<{ object: string; recordId: string }>;
    assigneeEmail: string | null;
    createdISO: string;
  }>;
}

export interface SeedRequest {
  twin: "attio";
  seed: AttioWireSeed;
}

/** `counts` is what was actually written, read back out of the DB. */
export interface SeedResult {
  ok: true;
  counts: { companies: number; people: number; deals: number; notes: number; tasks: number };
}

// ---------------------------------------------------------------------------
// Validated form. Parsing turns the wire into exactly this and nothing else, so
// the writer cannot see an unchecked string or an unparsed timestamp.
// ---------------------------------------------------------------------------

export interface ParsedMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  accessLevel: string;
}

export interface ParsedCompany {
  id: string;
  name: string;
  domains: string[];
  description: string;
}

export interface ParsedPerson {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  jobTitle: string;
  companyId: string;
}

export interface ParsedDeal {
  id: string;
  name: string;
  stage: string;
  value: number;
  ownerEmail: string;
  companyId: string;
  peopleIds: string[];
}

export interface ParsedNote {
  id: string;
  parentObject: string;
  parentRecordId: string;
  title: string;
  content: string;
  format: WireNoteFormat;
  createdMs: number;
}

export interface ParsedTask {
  id: string;
  content: string;
  deadlineAt: string | null;
  isCompleted: boolean;
  linkedRecords: Array<{ object: string; recordId: string }>;
  assigneeEmail: string | null;
  createdMs: number;
}

export interface ParsedSeed {
  nowMs: number;
  businessName: string;
  workspaceName: string;
  workspaceSlug: string;
  ownerEmail: string;
  ownerName: string;
  promoteToSnapshot: boolean;
  members: ParsedMember[];
  companies: ParsedCompany[];
  people: ParsedPerson[];
  deals: ParsedDeal[];
  notes: ParsedNote[];
  tasks: ParsedTask[];
}
