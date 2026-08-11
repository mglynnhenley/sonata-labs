import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import {
  TWIN_API_PORTS,
  TWIN_NAMES,
  TWIN_UI_PORTS,
  hasUiService,
  twinApiUrl,
  twinUiUrl,
  type TwinName,
} from "@sonata/core";
import {
  DATA_DIR,
  clearTwinProcess,
  readTwinProcess,
  writeTwinProcess,
  type TwinProcessRow,
} from "./db";

// The twin registry: where the three clones live, whether they are up, and how
// to start one without leaving the dashboard. A run cannot begin until the twins
// it needs answer, so this is the first thing the product has to make obvious —
// and the one thing a first-time user should never have to open a terminal for.

/** The API port per twin. Re-exported from @sonata/core, which owns the numbers. */
export const TWIN_PORTS: Record<TwinName, number> = TWIN_API_PORTS;

export const TWIN_LABELS: Record<TwinName, string> = {
  gmail: "Gmail",
  slack: "Slack",
  calendar: "Calendar",
};

/** What each clone is for, for the settings page and the first-run strip. */
export const TWIN_BLURBS: Record<TwinName, string> = {
  gmail: "Threads, labels, drafts and safe sends. The official SDK works against it.",
  slack: "Channels, DMs, threads and reactions, over the real Web API method names.",
  calendar: "Events, invites, RSVPs and free/busy across the whole cast.",
};

export function twinUrl(twin: TwinName): string {
  return twinApiUrl(twin);
}

/** The twin's web client, for twins that ship one. */
export interface TwinUiStatus {
  port: number;
  url: string;
  ok: boolean;
}

export interface TwinStatus {
  twin: TwinName;
  label: string;
  port: number;
  url: string;
  /** Answered its health endpoint. */
  ok: boolean;
  /** What it said, or why it did not: "412 threads", "not running". */
  detail: string;
  /** True when this dashboard spawned the process, so it can also stop it. */
  managed: boolean;
  pid: number | null;
  /** Epoch ms of this check. */
  checkedAt: number;
  /**
   * The paired UI service, when the twin has one. A twin is one logical unit
   * started and stopped together, so this is a sub-status rather than its own
   * row: the API is what a run needs, the UI is what a human looks at. Absent
   * for twins with no UI service yet.
   */
  ui?: TwinUiStatus;
}

// ---------------------------------------------------------------------------
// Process supervision
// ---------------------------------------------------------------------------

/** Walk up for the workspace root — the only place `npm run dev:gmail` works. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown };
        if (parsed.workspaces) return dir;
      } catch {
        // A malformed package.json on the way up is not our problem; keep going.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the layout we know: apps/platform → repo root.
  return path.resolve(process.cwd(), "..", "..");
}

const LOG_DIR = path.join(DATA_DIR, "logs");

function logPathFor(twin: TwinName): string {
  return path.join(LOG_DIR, `${twin}.log`);
}

/** Signal 0 asks "does this pid exist?" without touching the process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The recorded process, forgotten if it has since died. */
function livingProcess(twin: TwinName): TwinProcessRow | null {
  const row = readTwinProcess(twin);
  if (!row) return null;
  if (isAlive(row.pid)) return row;
  clearTwinProcess(twin);
  return null;
}

// ---------------------------------------------------------------------------
// Registry singleton. Several pollers (sidebar, home, settings) ask for health
// at once; without a shared short cache each render fans out nine HTTP calls.
// On globalThis so an HMR reload reuses the cache instead of leaking timers.
// ---------------------------------------------------------------------------

interface StartFailure {
  at: number;
  /** The line the twin died on, e.g. "listen EADDRINUSE …". */
  message: string;
}

interface Registry {
  cache: Map<TwinName, TwinStatus>;
  inflight: Map<TwinName, Promise<TwinStatus>>;
  /** Why the last start died. Without this a failed start is a button that
   *  appears to do nothing — the process is gone before the next poll. */
  failures: Map<TwinName, StartFailure>;
}

const g = globalThis as unknown as { __sonataTwinRegistry?: Registry };

function registry(): Registry {
  if (!g.__sonataTwinRegistry) {
    g.__sonataTwinRegistry = { cache: new Map(), inflight: new Map(), failures: new Map() };
  }
  return g.__sonataTwinRegistry;
}

/** Long enough to absorb three pollers, short enough that a start feels instant. */
const CACHE_MS = 2000;
const HEALTH_TIMEOUT_MS = 1500;
/** How long a failed start keeps explaining itself before the twin is just off. */
const FAILURE_TTL_MS = 60_000;

/** Each twin words its health payload slightly differently; one shape out. */
function describe(twin: TwinName, body: unknown): { ok: boolean; detail: string } {
  if (typeof body !== "object" || body === null) return { ok: false, detail: "no health payload" };
  const b = body as Record<string, unknown>;
  const ok = b.ok === true || b.status === "ok";
  if (!ok) return { ok: false, detail: typeof b.error === "string" ? b.error : "unhealthy" };
  const counts: string[] = [];
  if (typeof b.messages === "number") counts.push(`${b.messages} messages`);
  if (typeof b.users === "number") counts.push(`${b.users} people`);
  if (typeof b.events === "number") counts.push(`${b.events} events`);
  if (typeof b.calendars === "number") counts.push(`${b.calendars} calendars`);
  return { ok: true, detail: counts.length > 0 ? counts.join(" · ") : `${TWIN_LABELS[twin]} is up` };
}

/** Is anything at all listening on the port? Distinguishes "nothing is there"
 *  from "something is there and it is broken", which need different advice. */
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Does the twin's web client answer? Same health-probe shape as the API, so
 * there is one code path for "is this service up". Never throws: a UI that is
 * down must not make a healthy API report as broken — a run only needs the API.
 */
async function probeUi(twin: TwinName): Promise<TwinUiStatus | undefined> {
  if (!hasUiService(twin)) return undefined;
  const url = twinUiUrl(twin);
  const status: TwinUiStatus = { port: TWIN_UI_PORTS[twin], url, ok: false };
  try {
    const res = await fetch(`${url}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return { ...status, ok: res.ok };
  } catch {
    return status;
  }
}

async function probe(twin: TwinName): Promise<TwinStatus> {
  const proc = livingProcess(twin);
  const ui = await probeUi(twin);
  const base: Omit<TwinStatus, "ok" | "detail"> = {
    twin,
    label: TWIN_LABELS[twin],
    port: TWIN_PORTS[twin],
    url: twinUrl(twin),
    managed: proc !== null,
    pid: proc?.pid ?? null,
    checkedAt: Date.now(),
    ui,
  };

  try {
    const res = await fetch(`${twinUrl(twin)}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    // Read as text first: a twin whose database is missing answers 500 with a
    // plain-text body, and `res.json()` on that throws — which would report a
    // running-but-broken twin as "not running" and send the user to start a
    // second one on a port that is already taken.
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const said = typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : text.split("\n")[0]?.slice(0, 120);
      return { ...base, ok: false, detail: `answered ${res.status}${said ? `: ${said}` : ""}` };
    }
    const { ok, detail } = describe(twin, body);
    return { ...base, ok, detail };
  } catch {
    // A managed process that is not answering yet is starting, not broken —
    // Next's first compile takes a few seconds and must not read as a failure.
    if (proc) return { ...base, ok: false, detail: "starting…" };

    const failure = registry().failures.get(twin);
    if (failure && Date.now() - failure.at < FAILURE_TTL_MS) {
      return { ...base, ok: false, detail: `could not start: ${failure.message}` };
    }
    if (await portBusy(TWIN_PORTS[twin])) {
      return { ...base, ok: false, detail: "something else is on this port" };
    }
    return { ...base, ok: false, detail: "not running" };
  }
}

/** Health for one twin, served from the short cache unless `force`. */
export async function twinStatus(twin: TwinName, force = false): Promise<TwinStatus> {
  const reg = registry();
  const cached = reg.cache.get(twin);
  if (!force && cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;

  const existing = reg.inflight.get(twin);
  if (existing && !force) return existing;

  const pending = probe(twin).then((status) => {
    reg.cache.set(twin, status);
    reg.inflight.delete(twin);
    return status;
  });
  reg.inflight.set(twin, pending);
  return pending;
}

export async function allTwinStatuses(force = false): Promise<TwinStatus[]> {
  return Promise.all(TWIN_NAMES.map((twin) => twinStatus(twin, force)));
}

export function isTwinName(value: string): value is TwinName {
  return (TWIN_NAMES as readonly string[]).includes(value);
}

/**
 * Start a twin as a detached child of the workspace's own dev script, so the
 * dashboard is not in the business of knowing how a twin boots. Detached means
 * the twin survives a dashboard reload; the pid is stored so it can still be
 * stopped afterwards, and stdio goes to data/logs so a boot failure is readable
 * instead of silent.
 */
export async function startTwin(twin: TwinName): Promise<TwinStatus> {
  const running = livingProcess(twin);
  if (running) return twinStatus(twin, true);

  // Someone else may already own the port — a twin started from a terminal, or
  // one that is up but erroring. Either way a second `next dev` would only die
  // on EADDRINUSE, so refuse loudly instead of starting a process that vanishes.
  if (await portBusy(TWIN_PORTS[twin])) {
    const current = await twinStatus(twin, true);
    if (current.ok) return current;
    throw new Error(
      `port ${TWIN_PORTS[twin]} is already in use, but nothing healthy is answering on it ` +
        `(${current.detail}). Stop whatever owns it and try again.`,
    );
  }

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const logPath = logPathFor(twin);
  const log = openSync(logPath, "a");

  const child = spawn("npm", ["run", `dev:${twin}`], {
    cwd: findRepoRoot(),
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });

  const reg = registry();
  reg.failures.delete(twin);
  // The handle stays live inside this process even though the child is
  // detached, so an early death is observable — otherwise a twin that fails to
  // boot leaves a button that looks like it did nothing.
  child.once("exit", (code, signal) => {
    clearTwinProcess(twin);
    if (code === 0 || signal !== null) return; // 0, or a signal we sent
    reg.failures.set(twin, { at: Date.now(), message: lastErrorLine(twin) });
    reg.cache.delete(twin);
  });
  child.unref();

  if (child.pid === undefined) throw new Error(`could not start the ${TWIN_LABELS[twin]} twin`);
  writeTwinProcess({
    twin,
    pid: child.pid,
    port: TWIN_PORTS[twin],
    startedAt: Date.now(),
    logPath,
  });

  return twinStatus(twin, true);
}

/**
 * Stop a twin we started. `npm run dev` forks the Next server, so the signal
 * goes to the whole process group (the negative pid) — signalling only npm
 * leaves the server holding the port.
 */
export async function stopTwin(twin: TwinName): Promise<TwinStatus> {
  const proc = livingProcess(twin);
  if (proc) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch {
        // Already gone between the liveness check and the signal.
      }
    }
    clearTwinProcess(twin);
  }
  return twinStatus(twin, true);
}

/** Last N lines of a twin's boot log — what a failed start actually said. */
export function twinLogTail(twin: TwinName, lines = 40): string {
  const logPath = logPathFor(twin);
  if (!existsSync(logPath)) return "";
  return readFileSync(logPath, "utf8").split("\n").slice(-lines).join("\n");
}

/** One line to put in front of the user after a start dies. */
function lastErrorLine(twin: TwinName): string {
  const lines = twinLogTail(twin, 60)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const said = [...lines].reverse().find((l) => /error|EADDRINUSE|not found|failed/i.test(l));
  return (said ?? lines.at(-1) ?? "no output").slice(0, 160);
}
