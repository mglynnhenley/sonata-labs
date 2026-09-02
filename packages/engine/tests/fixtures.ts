import type {
  Beat,
  EpisodeSpec,
  InjectedRef,
  TwinAdapter,
  TwinAuditRow,
  TwinName,
  TwinSnapshot,
  WorldSeed,
} from "@sonata/core";

// Shared fixtures. Everything here is offline by construction: no adapter opens
// a socket, no model is called, and every clock is explicit — a test that had to
// reach for `Date.now()` would be testing the machine it ran on.

export const world: WorldSeed = {
  business: {
    name: "Northwind Logistics",
    description: "Freight brokerage, mid-quarter, one very unhappy client.",
    industry: "logistics",
    size: 40,
  },
  cast: [
    {
      id: "priya",
      name: "Priya Raman",
      email: "priya@northwind.test",
      slackUserId: "U01PRIYA",
      role: "Head of Support",
      relationship: "owner",
      voice: "brisk, no filler",
    },
    {
      id: "dana",
      name: "Dana Reyes",
      email: "dana@acme.test",
      slackUserId: "U02DANA",
      role: "Ops Lead at Acme",
      relationship: "client",
      voice: "clipped, escalates fast",
    },
    {
      id: "sam",
      name: "Sam Okafor",
      email: "sam@northwind.test",
      slackUserId: "U03SAM",
      role: "Dispatcher",
      relationship: "peer",
      voice: "chatty, uses emoji",
    },
  ],
  channels: [
    { id: "C01OPS", name: "ops", purpose: "the day's freight", members: ["priya", "sam"], isPrivate: false },
  ],
  mailboxOwner: "priya",
};

export const beat = (over: Partial<Beat> & Pick<Beat, "id" | "tick">): Beat =>
  ({
    twin: "gmail",
    kind: "email",
    payload: { from: "dana", to: ["priya"], subject: "Where is my freight", body: "Well?" },
    ...over,
  }) as Beat;

export function spec(over: Partial<EpisodeSpec> = {}): EpisodeSpec {
  return {
    id: "ep-test",
    title: "The unhappy client",
    story: "Dana has been waiting since Tuesday.",
    task: "Keep the client informed and the team in the loop.",
    world,
    clock: { startISO: "2026-08-04T09:00:00Z", ticks: 4, simMinutesPerTick: 15 },
    beats: [],
    director: {
      maxEventsPerTick: 2,
      personas: [
        { personId: "dana", responsiveness: 0.8, replyDelayTicks: 1, surfaces: ["gmail"] },
        { personId: "sam", responsiveness: 0.5, replyDelayTicks: 0, surfaces: ["slack"] },
      ],
      offLimits: ["the refund policy"],
      style: "short, human, mid-conversation",
    },
    success: { checklist: [], judgeQuestions: [] },
    termination: {
      stopWhenAllMustPass: false,
      idleTicks: 0,
      maxWallClockMs: 0,
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A twin that records instead of connecting
// ---------------------------------------------------------------------------

export interface FakeAdapter extends TwinAdapter {
  /** Every body this adapter was asked to inject, in order. */
  readonly injected: Array<{ kind: string; atISO: string }>;
  /** Audit rows the twin will report. Push to simulate the agent acting. */
  readonly rows: TwinAuditRow[];
  failInject?: string;
}

// One empty snapshot per twin. Spelled out rather than defaulted, because each
// twin's snapshot has its own required lists and a fake that returned the wrong
// shape would exercise the engine against a world no twin can produce.
const emptySnapshot = (twin: TwinName): TwinSnapshot => {
  switch (twin) {
    case "gmail":
      return { twin, capturedAt: 0, labels: [], threads: [], drafts: [] };
    case "slack":
      return { twin, capturedAt: 0, channels: [], messages: [] };
    case "calendar":
      return { twin, capturedAt: 0, events: [] };
    case "attio":
      return { twin, capturedAt: 0, records: [], notes: [], tasks: [] };
    case "google-docs":
      return { twin, capturedAt: 0, documents: [] };
  }
};

export function fakeAdapter(name: TwinName): FakeAdapter {
  const injected: Array<{ kind: string; atISO: string }> = [];
  const rows: TwinAuditRow[] = [];
  let minted = 0;

  const adapter: FakeAdapter = {
    name,
    baseUrl: `http://fake.${name}`,
    injected,
    rows,
    health: () => Promise.resolve({ name, ok: true }),
    snapshot: () => Promise.resolve(emptySnapshot(name)),
    diff: (before) => ({ twin: before.twin, unchangedCount: 0 }) as ReturnType<TwinAdapter["diff"]>,
    renderDiff: () => "",
    inject(body, ctx): Promise<InjectedRef> {
      injected.push({ kind: body.kind, atISO: ctx.atISO });
      if (adapter.failInject) return Promise.reject(new Error(adapter.failInject));
      minted += 1;
      return Promise.resolve({ twin: name, id: `${name}-${minted}`, containerId: `${name}-c` });
    },
    seed: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    auditSince: (sinceId) => Promise.resolve(rows.filter((r) => r.id > sinceId)),
    projectTrace: () => [],
  };
  return adapter;
}

export function auditRow(over: Partial<TwinAuditRow> & Pick<TwinAuditRow, "id" | "twin">): TwinAuditRow {
  return {
    ts: 0,
    method: "POST",
    endpoint: "/x",
    actionType: "send",
    targetType: "message",
    targetId: `t-${over.id}`,
    summary: "did a thing",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A fetch that answers from a table and records what it was asked
// ---------------------------------------------------------------------------

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FetchFake {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  /** The last call whose URL contains `needle`. */
  find(needle: string): Call | undefined;
}

/** `routes` maps a path substring to the JSON the twin answers with. */
export function fetchFake(routes: Record<string, unknown>): FetchFake {
  const calls: Call[] = [];
  const fake: typeof globalThis.fetch = (input, init) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: raw ? JSON.parse(raw) : undefined,
    });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const status = key === undefined ? 404 : 200;
    return Promise.resolve(
      new Response(JSON.stringify(key === undefined ? { error: "no route" } : routes[key]), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    fetch: fake,
    calls,
    find: (needle) => [...calls].reverse().find((c) => c.url.includes(needle)),
  };
}
