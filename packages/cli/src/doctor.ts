import path from "node:path";
import { PrerequisiteError, loadApps, type AppSpec } from "./apps";
import {
  apiKeyCheck,
  classifyPort,
  dependencyCheck,
  envFileCheck,
  nodeCheck,
  portCheck,
  schemaCheck,
  summarize,
  type Check,
} from "./diagnose";
import {
  declaredNodeFloor,
  dependencyFacts,
  keyInSettings,
  keyInShell,
  placeholderKey,
  probePort,
  readEnvFiles,
  schemaFacts,
} from "./probe";
import { heading, printCheck, say } from "./render";
import { PLATFORM_DIR, REPO_ROOT, short } from "./repo";

// `sonata doctor` — every prerequisite, what is wrong with it, and the command
// that clears it.
//
// It is read-only by construction (see ./probe) so it can be run at any moment:
// before the first install, halfway through a run, or as the first thing anyone
// does after a merge. The check that pays for the command is the last one — a
// clone's database against its schema.sql — because `data/*.db` is gitignored
// and a schema therefore arrives without its tables, and the symptom is a 500
// that reads like a broken server.

function startCommandFor(app: AppSpec): string {
  return `sonata up ${app.name}`;
}

export async function doctorCommand(): Promise<number> {
  const checks: Check[] = [];
  const record = (check: Check): void => {
    checks.push(check);
    printCheck(check);
  };

  say(`Sonata doctor — ${REPO_ROOT}`);
  say("Reads only. Nothing here starts, writes or migrates anything.");

  heading("Prerequisites");
  record(nodeCheck(process.versions.node, declaredNodeFloor() ?? undefined));
  const deps = await dependencyFacts();
  const depsCheck = dependencyCheck(deps);
  record(depsCheck);

  const placeholder = placeholderKey();
  const keyFacts = {
    files: readEnvFiles(),
    inShell: keyInShell(),
    inSettings: await keyInSettings(path.join(PLATFORM_DIR, "data", "platform.db")),
    envPath: short(path.join(REPO_ROOT, ".env")),
    ...(placeholder ? { placeholder } : {}),
  };
  record(envFileCheck(keyFacts));
  record(apiKeyCheck(keyFacts));

  let apps: AppSpec[];
  try {
    apps = await loadApps();
  } catch (err) {
    // The ports and the databases are unknowable without the registry, and
    // guessing them would be the second list of ports this repo does not need.
    if (err instanceof PrerequisiteError && depsCheck.status === "ok") {
      record({ status: "fail", title: "Sonata itself", detail: err.message, fix: err.fix });
    }
    return finish(checks);
  }

  heading("Ports");
  const states = await Promise.all(apps.map((app) => probePort(app.port)));
  apps.forEach((app, i) => {
    const observation = states[i];
    if (!observation) return;
    record(
      portCheck({
        label: app.label,
        port: app.port,
        startCommand: startCommandFor(app),
        state: classifyPort(observation),
      }),
    );
  });

  heading("Databases");
  say("  A clone's schema.sql is committed; its data/*.db is not. This is where a merge");
  say("  turns into `no such table` on every call.");
  for (const app of apps) {
    if (!app.clone) continue;
    record(schemaCheck(await schemaFacts(app.label, app.clone)));
  }

  return finish(checks);
}

function finish(checks: Check[]): number {
  const summary = summarize(checks);
  say();
  for (const line of summary.lines) say(line);
  return summary.failures > 0 ? 1 : 0;
}
