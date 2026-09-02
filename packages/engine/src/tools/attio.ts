import { describeRecord, type AttioRecordResource, type Names } from "../adapters/attio";
import type { TwinHttp } from "../http";
import { fn, int, str, type EngineTool, type ToolInput } from "./types";

// The nine Attio tools. Read four ways (find records, read one, read its notes,
// read the follow-ups), write five (create a record, write to one, log a note,
// raise a task, close a task).
//
// Two decisions worth knowing:
//
// A record comes back as a flat `{recordId, title, values}` through the
// adapter's own `describeRecord`, not as Attio's raw value arrays. The raw shape
// is an array of versioned rows per attribute, and an agent that has to know
// `values.stage[0].status.title` to read a stage spends its turns on the vendor's
// data model rather than on the day. The snapshot the judge sees is flattened by
// the same function, so the agent and the judge can never be reading two
// different CRMs.
//
// `search_records` takes a name fragment and a stage rather than Attio's
// `{filter}` grammar. That grammar is genuinely expressive and the twin refuses
// a malformed one loudly, which is the right behaviour for an API and the wrong
// affordance for a tool: an agent that mistypes an operator learns nothing about
// the account it was looking for.

/** Records returned by one search. An agent needs candidates, not the CRM. */
const MAX_RESULTS = 25;

/** Notes and tasks per read. Both lists are short in a cloned company. */
const MAX_LIST = 50;

/** The objects this CRM has; the twin 404s anything else. */
const OBJECTS = "companies, people or deals";

interface NoteResource {
  id?: { note_id?: string };
  parent_object?: string;
  parent_record_id?: string;
  title?: string;
  content_plaintext?: string;
  created_at?: string;
}

interface TaskResource {
  id?: { task_id?: string };
  content_plaintext?: string;
  deadline_at?: string | null;
  is_completed?: boolean;
  linked_records?: Array<{ target_object_id?: string; target_record_id?: string }>;
  assignees?: Array<{ referenced_actor_id?: string }>;
}

interface MemberResource {
  id?: { workspace_member_id?: string };
  email_address?: string;
}

/** The attribute bag on a write, which the twin normalises. Rejected early here
 *  because "values must be an object" is a far more useful thing for an agent to
 *  read than the vendor's 400 about `data.values`. */
function bag(v: unknown, where: string): Record<string, unknown> {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  throw new Error(`${where} must be an object of attribute slugs, e.g. {"stage": "Won 🎉"}`);
}

function describeNote(n: NoteResource): Record<string, unknown> {
  return {
    noteId: n.id?.note_id ?? "",
    parentObject: n.parent_object ?? "",
    parentRecordId: n.parent_record_id ?? "",
    title: n.title ?? "",
    content: n.content_plaintext ?? "",
    createdAt: n.created_at ?? "",
  };
}

function describeTask(t: TaskResource, members: Map<string, string>): Record<string, unknown> {
  return {
    taskId: t.id?.task_id ?? "",
    content: t.content_plaintext ?? "",
    deadline: t.deadline_at ?? null,
    isCompleted: t.is_completed === true,
    about: (t.linked_records ?? []).map((l) => ({
      object: l.target_object_id ?? "",
      recordId: l.target_record_id ?? "",
    })),
    assignees: (t.assignees ?? [])
      .map((a) => (a.referenced_actor_id ? members.get(a.referenced_actor_id) ?? a.referenced_actor_id : ""))
      .filter(Boolean),
  };
}

export function attioTools(http: TwinHttp): EngineTool[] {
  let memberEmails: Map<string, string> | undefined;

  /**
   * Workspace members, by id. Every owner and every assignee in this CRM is an
   * actor reference — a UUID — so without this an agent asked who owns a deal
   * can only answer with the UUID. Fetched once: the roster does not change
   * inside a run.
   */
  async function members(): Promise<Map<string, string>> {
    if (!memberEmails) {
      const res = await http.get<{ data?: MemberResource[] }>("/v2/workspace_members");
      memberEmails = new Map<string, string>();
      for (const m of res.data ?? []) {
        const id = m.id?.workspace_member_id;
        if (id && m.email_address) memberEmails.set(id, m.email_address);
      }
    }
    return memberEmails;
  }

  /** Names for one page: the page's own records, plus the member roster. */
  async function namesFor(page: AttioRecordResource[]): Promise<Names> {
    const titles = new Map<string, string>();
    const roster = await members();
    for (const resource of page) {
      const digest = describeRecord(resource, { titles, members: roster });
      if (digest.recordId) titles.set(digest.recordId, digest.title);
    }
    return { titles, members: roster };
  }

  async function render(page: AttioRecordResource[]): Promise<Array<Record<string, unknown>>> {
    const names = await namesFor(page);
    return page.map((resource) => describeRecord(resource, names));
  }

  function recordPath(object: string, recordId: string): string {
    return `/v2/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`;
  }

  return [
    {
      name: "search_records",
      twin: "attio",
      isMutation: false,
      def: fn(
        "search_records",
        `Find records in the CRM — ${OBJECTS}. Search by name fragment, or list a whole ` +
          "object. Look here before creating anything: the account is usually already in here " +
          "under a slightly different name.",
        {
          type: "object",
          properties: {
            object: { type: "string", description: `One of ${OBJECTS}.` },
            name: { type: "string", description: "Case-insensitive fragment of the record's name." },
            stage: {
              type: "string",
              description: 'Deals only. Exactly one of "Lead", "In Progress", "Won 🎉", "Lost".',
            },
            limit: { type: "integer", description: "Default 25." },
          },
          required: ["object"],
        },
      ),
      async run(input: ToolInput) {
        const object = str(input.object);
        const name = str(input.name);
        const stage = str(input.stage);
        const filter: Record<string, unknown> = {};
        if (name) filter.name = { $contains: name };
        if (stage) filter.stage = stage;
        const res = await http.post<{ data?: AttioRecordResource[] }>(
          `/v2/objects/${encodeURIComponent(object)}/records/query`,
          {
            ...(Object.keys(filter).length ? { filter } : {}),
            limit: Math.min(int(input.limit, MAX_RESULTS), MAX_RESULTS),
          },
        );
        const page = res.data ?? [];
        // Count first, so the judge's one-line projection of this call reads as
        // "3 matches in deals" before it runs out of room.
        return { matches: page.length, object, records: await render(page) };
      },
    },
    {
      name: "get_record",
      twin: "attio",
      isMutation: false,
      def: fn(
        "get_record",
        "Read one record in full — every attribute it currently holds.",
        {
          type: "object",
          properties: {
            object: { type: "string", description: `One of ${OBJECTS}.` },
            recordId: { type: "string" },
          },
          required: ["object", "recordId"],
        },
      ),
      async run(input: ToolInput) {
        const object = str(input.object);
        const res = await http.get<{ data?: AttioRecordResource }>(
          recordPath(object, str(input.recordId)),
        );
        const data = res.data ?? {};
        return { object, ...describeRecord(data, await namesFor([data])) };
      },
    },
    {
      name: "list_notes",
      twin: "attio",
      isMutation: false,
      def: fn(
        "list_notes",
        "Read the notes logged against a record — the history of what has been said about " +
          "this account. Read them before writing another one.",
        {
          type: "object",
          properties: {
            object: { type: "string", description: `One of ${OBJECTS}.` },
            recordId: { type: "string" },
            limit: { type: "integer", description: "Default 50." },
          },
          required: ["object", "recordId"],
        },
      ),
      async run(input: ToolInput) {
        const res = await http.get<{ data?: NoteResource[] }>("/v2/notes", {
          parent_object: str(input.object),
          parent_record_id: str(input.recordId),
          limit: Math.min(int(input.limit, MAX_LIST), MAX_LIST),
        });
        const page = res.data ?? [];
        return { count: page.length, notes: page.map(describeNote) };
      },
    },
    {
      name: "list_tasks",
      twin: "attio",
      isMutation: false,
      def: fn(
        "list_tasks",
        "List follow-up tasks, oldest first. Narrow to one record, or to the ones still open.",
        {
          type: "object",
          properties: {
            object: { type: "string", description: `Narrow to tasks about a record in ${OBJECTS}.` },
            recordId: { type: "string", description: "Narrow to tasks about this record." },
            openOnly: { type: "boolean", description: "Only tasks nobody has completed yet." },
            limit: { type: "integer", description: "Default 50." },
          },
        },
      ),
      async run(input: ToolInput) {
        const object = str(input.object);
        const recordId = str(input.recordId);
        const res = await http.get<{ data?: TaskResource[] }>("/v2/tasks", {
          ...(object ? { linked_object: object } : {}),
          ...(recordId ? { linked_record_id: recordId } : {}),
          ...(input.openOnly === true ? { is_completed: "false" } : {}),
          limit: Math.min(int(input.limit, MAX_LIST), MAX_LIST),
        });
        const page = res.data ?? [];
        const roster = await members();
        return { count: page.length, tasks: page.map((t) => describeTask(t, roster)) };
      },
    },
    {
      name: "create_record",
      twin: "attio",
      isMutation: true,
      def: fn(
        "create_record",
        "Add a record to the CRM. Search first — a duplicate account is worse than none, " +
          "because the history then splits across two of them.",
        {
          type: "object",
          properties: {
            object: { type: "string", description: `One of ${OBJECTS}.` },
            values: {
              type: "object",
              description:
                'Attributes by slug. companies: name, domains, description. people: name, ' +
                'email_addresses, job_title, company. deals: name, stage, value, owner ' +
                '(a member email), associated_company, associated_people. A reference may be ' +
                'given as {"target_object": "companies", "target_record_id": "…"}.',
            },
          },
          required: ["object", "values"],
        },
      ),
      async run(input: ToolInput) {
        const object = str(input.object);
        const res = await http.post<{ data?: AttioRecordResource }>(
          `/v2/objects/${encodeURIComponent(object)}/records`,
          { data: { values: bag(input.values, "values") } },
        );
        const data = res.data ?? {};
        return { object, ...describeRecord(data, await namesFor([data])) };
      },
    },
    {
      name: "update_record",
      twin: "attio",
      isMutation: true,
      def: fn(
        "update_record",
        "Change a record — move a deal's stage, correct a name, set an owner. Only the " +
          "attributes you send change, and the values they replace are kept as history.",
        {
          type: "object",
          properties: {
            object: { type: "string", description: `One of ${OBJECTS}.` },
            recordId: { type: "string" },
            values: {
              type: "object",
              description:
                'Attributes by slug, e.g. {"stage": "Won 🎉"}. A multi-value attribute ' +
                "(domains, email_addresses, associated_people) GAINS what you send rather " +
                "than replacing what is there.",
            },
          },
          required: ["object", "recordId", "values"],
        },
      ),
      async run(input: ToolInput) {
        const object = str(input.object);
        const res = await http.patch<{ data?: AttioRecordResource }>(
          recordPath(object, str(input.recordId)),
          { data: { values: bag(input.values, "values") } },
        );
        const data = res.data ?? {};
        return { object, ...describeRecord(data, await namesFor([data])) };
      },
    },
    {
      name: "create_note",
      twin: "attio",
      isMutation: true,
      def: fn(
        "create_note",
        "Log a note against a record — what was said, decided or promised. This is how the " +
          "CRM remembers a conversation that happened somewhere else.",
        {
          type: "object",
          properties: {
            object: { type: "string", description: `One of ${OBJECTS}.` },
            recordId: { type: "string" },
            title: { type: "string" },
            content: { type: "string", description: "Plain text." },
          },
          required: ["object", "recordId", "title", "content"],
        },
      ),
      async run(input: ToolInput) {
        const res = await http.post<{ data?: NoteResource }>("/v2/notes", {
          data: {
            parent_object: str(input.object),
            parent_record_id: str(input.recordId),
            title: str(input.title),
            format: "plaintext",
            content: str(input.content),
          },
        });
        return describeNote(res.data ?? {});
      },
    },
    {
      name: "create_task",
      twin: "attio",
      isMutation: true,
      def: fn(
        "create_task",
        "Raise a follow-up task so the work does not get lost. Link it to the record it is " +
          "about, and give it a deadline whenever the day implies one.",
        {
          type: "object",
          properties: {
            content: { type: "string", description: "What has to be done, in one sentence." },
            deadline: { type: "string", description: "RFC3339 instant. Omit if genuinely open." },
            assignee: { type: "string", description: "A workspace member's email address." },
            object: { type: "string", description: `The record this is about, in ${OBJECTS}.` },
            recordId: { type: "string", description: "The record this is about." },
          },
          required: ["content"],
        },
      ),
      async run(input: ToolInput) {
        const object = str(input.object);
        const recordId = str(input.recordId);
        const assignee = str(input.assignee);
        const deadline = str(input.deadline);
        const res = await http.post<{ data?: TaskResource }>("/v2/tasks", {
          data: {
            content: str(input.content),
            format: "plaintext",
            deadline_at: deadline || null,
            linked_records:
              object && recordId
                ? [{ target_object: object, target_record_id: recordId }]
                : [],
            assignees: assignee ? [assignee] : [],
          },
        });
        return describeTask(res.data ?? {}, await members());
      },
    },
    {
      name: "complete_task",
      twin: "attio",
      isMutation: true,
      def: fn(
        "complete_task",
        "Close a follow-up task. Only once the thing it asks for has actually happened — a " +
          "task closed early is work nobody will look for again.",
        { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
      ),
      async run(input: ToolInput) {
        const res = await http.patch<{ data?: TaskResource }>(
          `/v2/tasks/${encodeURIComponent(str(input.taskId))}`,
          { data: { is_completed: true } },
        );
        return describeTask(res.data ?? {}, await members());
      },
    },
  ];
}
