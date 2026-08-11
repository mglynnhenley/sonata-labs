import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadApps, loadTwins, type AppSpec, type TwinRegistry } from "./apps";
import { classifyPort, type PortState } from "./diagnose";
import { planStart, planStop, type AppContext } from "./plan";
import { probePort } from "./probe";
import { say } from "./render";
import { PLATFORM_DIR, REPO_ROOT, short } from "./repo";

// `sonata up` / `sonata down` — four terminals in one command.
//
// The three clones are started through the twin registry in apps/platform: the
// same function the dashboard's Start button calls, so a clone started from a
// terminal and one started from the product are the same process, recorded in
// the same place, stoppable from either. The dashboard itself is the one thing
// the registry cannot start — it is typed to the three twins — so it gets the
// small supervisor below, deliberately shaped like the registry's: a detached
// child, a log on disk, and a pid remembered so it can be stopped again.

const DASHBOARD_STATE = path.join(PLATFORM_DIR, "data", "dashboard.json");
const LOG_DIR = path.join(PLATFORM_DIR, "data", "logs");

interface ProcessRecord {
  pid: number;
  port: number;
  startedAt: number;
  logPath: string;
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

/** The dashboard we started, forgotten if it has since died. */
function readDashboard(): ProcessRecord | null {
  if (!existsSync(DASHBOARD_STATE)) return null;
  try {
    const row = JSON.parse(readFileSync(DASHBOARD_STATE, "utf8")) as Partial<ProcessRecord>;
    if (typeof row.pid !== "number" || !isAlive(row.pid)) {
      rmSync(DASHBOARD_STATE, { force: true });
      return null;
    }
    return {
      pid: row.pid,
      port: typeof row.port === "number" ? row.port : 3000,
      startedAt: typeof row.startedAt === "number" ? row.startedAt : Date.now(),
      logPath: typeof row.logPath === "string" ? row.logPath : path.join(LOG_DIR, "platform.log"),
    };
  } catch {
    rmSync(DASHBOARD_STATE, { force: true });
    return null;
  }
}

/** Same convention the twin registry uses, so all four logs sit together. */
function logPathFor(app: AppSpec): string {
  return path.join(LOG_DIR, `${app.name}.log`);
}

/** Detached, so the dashboard outlives the terminal that started it, with stdio
 *  on disk so a boot failure is readable instead of silent. */
function spawnDashboard(app: AppSpec): number {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const logPath = logPathFor(app);
  const log = openSync(logPath, "a");
  const child = spawn("npm", ["run", app.devScript], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`could not start ${app.label}`);
  const record: ProcessRecord = {
    pid: child.pid,
    port: app.port,
    startedAt: Date.now(),
    logPath,
  };
  writeFileSync(DASHBOARD_STATE, `${JSON.stringify(record, null, 2)}\n`);
  return child.pid;
}

/** `npm run dev` forks the Next server, so the signal goes to the whole process
 *  group (the negative pid) — signalling npm alone leaves the server on the port. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone between the liveness check and the signal.
    }
  }
}

function tail(file: string, lines = 12): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-lines);
}

// ---------------------------------------------------------------------------

function context(app: AppSpec): AppContext {
  return { label: app.label, port: app.port, startCommand: `sonata up ${app.name}` };
}

async function stateOf(app: AppSpec): Promise<PortState> {
  return classifyPort(await probePort(app.port));
}

/** The pid Sonata is holding for this app, or null if it is not ours to stop. */
async function managedPid(app: AppSpec, twins: TwinRegistry): Promise<number | null> {
  if (app.name === "platform") return readDashboard()?.pid ?? null;
  const status = await twins.twinStatus(app.name, true);
  return status.managed ? status.pid : null;
}

function pad(app: AppSpec): string {
  return `  ${app.label.padEnd(9)} :${app.port}  `;
}

function indentFor(app: AppSpec): string {
  return " ".repeat(pad(app).length);
}

function selected(apps: AppSpec[], names: string[]): AppSpec[] {
  if (names.length === 0) return apps;
  return names.map((name) => {
    const app = apps.find((a) => a.name === name);
    if (!app) {
      throw new Error(
        `"${name}" is not a Sonata app. Pick from ${apps
          .map((a) => a.name)
          .join(", ")}, or pass none for all four.`,
      );
    }
    return app;
  });
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

/** Next's first compile is slow; this is the point at which waiting longer stops
 *  being informative and the log is the better read. */
const HEALTH_TIMEOUT_MS = 120_000;
const POLL_MS = 900;

export async function upCommand(names: string[]): Promise<number> {
  const twins = await loadTwins();
  const apps = selected(await loadApps(), names);

  say(`Starting Sonata — ${apps.length} app${apps.length === 1 ? "" : "s"}`);
  say();

  const pending: AppSpec[] = [];
  let refused = 0;

  for (const app of apps) {
    const plan = planStart(await stateOf(app), await managedPid(app, twins), context(app));
    if (plan.action === "reuse") {
      say(`${pad(app)}${plan.reason}`);
      continue;
    }
    if (plan.action === "wait") {
      say(`${pad(app)}${plan.reason}`);
      pending.push(app);
      continue;
    }
    if (plan.action === "refuse") {
      refused++;
      say(`${pad(app)}${plan.reason}`);
      say(`${indentFor(app)}fix: ${plan.fix}`);
      continue;
    }

    try {
      // The clones go through the registry — the same call the dashboard's Start
      // button makes — so one process is recorded in one place whichever surface
      // started it. The registry re-checks the port itself and throws rather than
      // spawning into a conflict: the plan above decides what to say, the
      // registry decides what to spawn.
      const pid =
        app.name === "platform" ? spawnDashboard(app) : (await twins.startTwin(app.name)).pid;
      say(`${pad(app)}starting${pid === null ? "" : ` (pid ${pid})`} — the first compile takes a moment`);
      pending.push(app);
    } catch (err) {
      refused++;
      say(`${pad(app)}could not start: ${err instanceof Error ? err.message : String(err)}`);
      say(`${indentFor(app)}fix: read ${short(logPathFor(app))}`);
    }
  }

  const late = await waitForHealth(pending);

  const up: AppSpec[] = [];
  for (const app of apps) {
    if ((await stateOf(app)).kind === "sonata") up.push(app);
  }
  if (up.length > 0) {
    say();
    for (const app of up) say(`  ${app.label.padEnd(9)} ${app.url}`);
  }

  if (late.length + refused > 0) {
    say();
    say(
      `${late.length + refused} of ${apps.length} did not come up. ` +
        "Run `sonata doctor`, or read the log lines above.",
    );
    return 1;
  }
  say();
  say("Next: open http://localhost:3000 — or `sonata status`, `sonata world list`.");
  say(`Logs: ${short(LOG_DIR)}/*.log · stop them all with \`sonata down\`.`);
  return 0;
}

/** Poll until each one answers health. Returns the ones that never did. */
async function waitForHealth(apps: AppSpec[]): Promise<AppSpec[]> {
  if (apps.length === 0) return [];
  const startedAt = Date.now();
  const waiting = new Set(apps);
  say();

  while (waiting.size > 0 && Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    for (const app of [...waiting]) {
      const state = await stateOf(app);
      if (state.kind === "sonata") {
        waiting.delete(app);
        say(`${pad(app)}up after ${Math.round((Date.now() - startedAt) / 1000)}s — ${state.detail}`);
      } else if (state.kind === "sonata-broken") {
        // Up, and answering errors. Waiting will not improve it.
        waiting.delete(app);
        say(`${pad(app)}${state.detail}`);
        say(`${indentFor(app)}fix: sonata doctor — its database is usually behind its schema`);
      }
    }
  }

  for (const app of waiting) {
    say(`${pad(app)}no health after ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s. The end of its log:`);
    for (const line of tail(logPathFor(app))) say(`${indentFor(app)}${line}`);
    say(`${indentFor(app)}fix: read ${short(logPathFor(app))}, then \`sonata up ${app.name}\``);
  }
  return [...waiting];
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

export async function downCommand(names: string[]): Promise<number> {
  const twins = await loadTwins();
  const apps = selected(await loadApps(), names);

  say(`Stopping Sonata — ${apps.length} app${apps.length === 1 ? "" : "s"}`);
  say();

  let stuck = 0;
  for (const app of apps) {
    const plan = planStop(await stateOf(app), await managedPid(app, twins), context(app));
    if (plan.action === "stop") {
      if (app.name === "platform") {
        killGroup(plan.pid);
        rmSync(DASHBOARD_STATE, { force: true });
      } else {
        await twins.stopTwin(app.name);
      }
      say(`${pad(app)}stopped (pid ${plan.pid})`);
      continue;
    }
    if (plan.action === "nothing") {
      say(`${pad(app)}${plan.reason}`);
      continue;
    }
    stuck++;
    say(`${pad(app)}${plan.reason}`);
    say(`${indentFor(app)}fix: ${plan.fix}`);
  }

  if (stuck > 0) {
    say();
    say("Sonata stops what Sonata started. The rest is above, with the command that stops it.");
    return 1;
  }
  return 0;
}
