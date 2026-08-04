import { owner, type EpisodeSpec, type TwinAuditRow, type TwinHealth, type TwinName } from "@sonata/core";
import { TwinHttp, TwinHttpError, errorMessage, type Query } from "../http";

// Plumbing every adapter repeats: preflight, reset, world seeding, and turning a
// twin's own audit table into the one normalized row shape the director reads.
//
// All three twins were built from the same template — an `audit.db` ATTACHed to
// the working database, an `/api/activity` reader over it — so the normalization
// is one function rather than three.

/** One row as each twin's `/api/activity` returns it. */
interface RawAction {
  id?: number;
  ts?: number;
  method?: string;
  endpoint?: string;
  action_type?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  summary?: string;
}

export function normalizeAudit(twin: TwinName, rows: unknown): TwinAuditRow[] {
  if (!Array.isArray(rows)) return [];
  return (rows as RawAction[])
    .filter((r): r is RawAction & { id: number } => typeof r.id === "number")
    .map((r) => ({
      id: r.id,
      twin,
      ts: r.ts ?? 0,
      method: r.method ?? "",
      endpoint: r.endpoint ?? "",
      actionType: r.action_type ?? null,
      targetType: r.target_type ?? null,
      targetId: r.target_id ?? null,
      summary: r.summary ?? "",
    }))
    // Ascending: the director reads a tick's delta as a story, and the audit
    // readers disagree on direction (Gmail's pages newest-first, Slack's oldest).
    .sort((a, b) => a.id - b.id);
}

export async function auditViaActivity(
  http: TwinHttp,
  twin: TwinName,
  sinceId: number,
  query: Query,
): Promise<TwinAuditRow[]> {
  const res = await http.get<{ actions?: unknown }>("/api/activity", query);
  const rows = normalizeAudit(twin, res.actions);
  // Belt and braces: `since` semantics differ slightly between the twins, and a
  // delta that re-reports rows the director has already reacted to would have it
  // answering the same email twice.
  return rows.filter((r) => r.id > sinceId);
}

/** Preflight. Never throws — an unreachable twin reports `ok: false`. */
export async function healthViaApi(http: TwinHttp, twin: TwinName): Promise<TwinHealth> {
  try {
    const res = await http.get<Record<string, unknown>>("/api/health");
    const ok = res.status === "ok";
    const counts = Object.entries(res)
      .filter(([k, v]) => typeof v === "number" && k !== "time")
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    return { name: twin, ok, detail: ok ? counts || "ok" : String(res.error ?? "not ok") };
  } catch (err) {
    return { name: twin, ok: false, detail: errorMessage(err) };
  }
}

export async function resetViaApi(http: TwinHttp, note: string): Promise<void> {
  await http.post("/api/sandbox/reset", { note });
}

/**
 * The body `POST /api/sandbox/seed` actually takes, per twin.
 *
 * Every twin takes the SAME `WorldSeed` — one cast, one set of channels, one
 * mailbox owner — because that shared identity is the only thing making the three
 * surfaces a company rather than three fixtures. What each twin wants it in is
 * its own shape, and the shape is the twin's, not ours: gmail parses
 * `{twin, seed: {profileEmail, labels, messages}}` and slack
 * `{twin, seed: {self, users, channels, messages}}`, and anything else is a 400.
 *
 * `messages` is empty on purpose. This seeds the CAST — the accounts, channels
 * and labels an episode's beats then play into. Seeding a whole invented history
 * on top is @sonata/world's job, and doing it here from an `EpisodeSpec`, which
 * carries no history, would mean inventing one per run.
 */
export function seedBodyFor(twin: TwinName, spec: EpisodeSpec): Record<string, unknown> {
  const world = spec.world;
  const me = owner(world);
  if (twin === "gmail") {
    return { twin, seed: { profileEmail: me.email, labels: [], messages: [] } };
  }
  if (twin === "calendar") {
    // The calendar twin takes only the wire shape, so the cast-only seed is a
    // wire seed with no events: every cast member gets an identity, the owner
    // gets the primary calendar a new event lands on by default, and the beats
    // fill the day. `world.timezone` is optional in a spec but mandatory here —
    // the twin rejects a calendar with no zone rather than guess one silently.
    return {
      twin,
      seed: {
        world,
        nowISO: new Date(Date.parse(spec.clock.startISO) || Date.now()).toISOString(),
        promoteToSnapshot: true,
        ownerEmail: me.email,
        calendars: [
          {
            // Addressed by the owner's email, exactly as Google addresses a
            // person's primary calendar — so an agent's "calendarId: me" and the
            // seed agree about what it points at.
            id: me.email,
            summary: me.name,
            description: `${me.name}'s calendar at ${world.business.name}`,
            ownerEmail: me.email,
            timezone: world.timezone ?? "UTC",
            primary: true,
          },
        ],
        events: [],
      },
    };
  }
  return {
    twin,
    seed: {
      self: me.slackUserId,
      users: world.cast.map((p) => ({
        id: p.slackUserId,
        realName: p.name,
        email: p.email,
        title: p.role,
      })),
      channels: world.channels.map((c) => ({
        id: c.id,
        name: c.name,
        purpose: c.purpose,
        isPrivate: c.isPrivate,
        // Members are named by `Person.id` in the seed and by Slack id on the
        // wire; the twin accepts ids or handles, never our cast keys.
        members: c.members.map((ref) => resolveSlackId(world.cast, ref)),
      })),
      messages: [],
    },
  };
}

function resolveSlackId(cast: EpisodeSpec["world"]["cast"], ref: string): string {
  const needle = ref.trim().toLowerCase();
  const person = cast.find(
    (p) => p.id.toLowerCase() === needle || p.email.toLowerCase() === needle,
  );
  return person?.slackUserId ?? ref;
}

/**
 * Load the episode's world into a twin.
 *
 * A 404 means that twin predates the seed contract, and it says so rather than
 * silently running the episode against the wrong company — which would look like
 * a badly behaved agent instead of a missing route.
 */
export async function seedViaApi(
  http: TwinHttp,
  twin: TwinName,
  spec: EpisodeSpec,
): Promise<void> {
  try {
    await http.post("/api/sandbox/seed", seedBodyFor(twin, spec));
  } catch (err) {
    if (err instanceof TwinHttpError && err.status === 404) {
      throw new Error(
        `The ${twin} twin has no POST /api/sandbox/seed route, so the world could not be ` +
          `loaded into it. Seed it out of band and run with seedWorld: false.`,
      );
    }
    throw err;
  }
}

/** Stable ordering for snapshot diffs, so capture order never leaks into output. */
export function byKey<T>(key: (item: T) => string) {
  return (a: T, b: T): number => {
    const ka = key(a);
    const kb = key(b);
    return ka === kb ? 0 : ka < kb ? -1 : 1;
  };
}

/** Members of `a` that are not in `b`, sorted. */
export function difference(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return a.filter((x) => !other.has(x)).sort();
}

/** Cap a body down to a digest — snapshots ship inside every run artifact. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
