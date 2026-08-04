import { google, type gmail_v1 } from "googleapis";
import type { ActionRow, SessionRow } from "../audit";
import type { FixtureMessage, InjectedMessage } from "./types";

// Helpers for talking to the running sandbox: the official-SDK Gmail client (the
// same connection an agent-under-test uses), the eval inject route, the activity
// feed (for grading), and reset.

export function defaultRootUrl(): string {
  return process.env.SANDBOX_ROOT_URL || `http://localhost:${process.env.PORT || "3100"}`;
}

export function defaultToken(): string {
  return process.env.SANDBOX_TOKEN || "sandbox-token";
}

/**
 * Connect the official googleapis SDK to the sandbox. Pass an OAuth2Client with
 * setCredentials — a bare string `auth` becomes a `key=` query param, not a
 * bearer header.
 */
export function connectGmail(rootUrl = defaultRootUrl(), token = defaultToken()): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: token });
  return google.gmail({ version: "v1", auth, rootUrl });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** Inject a fixture. Messages land as ordinary received mail, oldest first. */
export async function injectFixture(
  messages: FixtureMessage[],
  rootUrl = defaultRootUrl(),
): Promise<InjectedMessage[]> {
  const res = await postJson<{ injected: InjectedMessage[] }>(
    `${rootUrl}/api/eval/inject`,
    { messages },
  );
  return res.injected;
}

export interface ActivitySnapshot {
  sessions: SessionRow[];
  currentSessionId: string | null;
  actions: ActionRow[];
  hasMore?: boolean;
  outbox: Array<{ id: string; messageId: string; envelopeTo: string[]; createdAt: number }>;
}

const ACTIVITY_PAGE = 1000;
/** Backstop against an unbounded log; far above any plausible triage run. */
const MAX_ACTIVITY_PAGES = 50;

/**
 * Drains every page of the activity feed. Grading and the judge both read this,
 * and an agent working a real mailbox can easily exceed one page — a partial log
 * silently understates what the agent did, so we never stop at the first page.
 */
export async function fetchActivity(
  opts: { sinceId?: number } = {},
  rootUrl = defaultRootUrl(),
): Promise<ActivitySnapshot> {
  let snapshot: ActivitySnapshot | null = null;
  const actions: ActionRow[] = [];
  let beforeId: number | undefined;

  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const url = new URL(`${rootUrl}/api/activity`);
    if (opts.sinceId != null) url.searchParams.set("sinceId", String(opts.sinceId));
    if (beforeId != null) url.searchParams.set("beforeId", String(beforeId));
    url.searchParams.set("limit", String(ACTIVITY_PAGE));

    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET /api/activity failed (${res.status})`);
    const body = (await res.json()) as ActivitySnapshot;
    snapshot ??= body;
    actions.push(...body.actions);

    if (!body.hasMore || body.actions.length === 0) break;
    // Rows are newest-first, so the oldest id on this page is the next cursor.
    beforeId = body.actions.reduce((min, a) => (a.id < min ? a.id : min), Infinity);
  }

  return { ...(snapshot as ActivitySnapshot), actions };
}

/** Highest action id currently in the log — the watermark taken before triage. */
export async function latestActionId(rootUrl = defaultRootUrl()): Promise<number> {
  const snap = await fetchActivity({}, rootUrl);
  return snap.actions.reduce((max, a) => (a.id > max ? a.id : max), 0);
}

export async function resetSandbox(
  note = "eval reset",
  rootUrl = defaultRootUrl(),
): Promise<void> {
  await postJson(`${rootUrl}/api/sandbox/reset`, { note });
}

export async function sandboxIsUp(rootUrl = defaultRootUrl()): Promise<boolean> {
  try {
    const res = await fetch(`${rootUrl}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
