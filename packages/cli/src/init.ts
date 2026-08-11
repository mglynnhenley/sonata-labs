import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { loadApps } from "./apps";
import { KEY_NAME, NO_KEY_MEANS, parseEnvKeys } from "./diagnose";
import { say } from "./render";
import { REPO_ROOT, short } from "./repo";

// `sonata init` — the first command on a machine that has never run this.
//
// Two things stand between a fresh checkout and a working install: an .env with
// the key under the one name that is read, and databases for three clones whose
// schema.sql arrived through git while their data/*.db did not. Both are done
// here, and neither is done twice — an existing key is kept, and every schema
// statement is CREATE … IF NOT EXISTS, so running this again on a working
// install changes nothing.
//
// It finishes by saying what to run next, and — when there is no key — exactly
// which parts of Sonata stay unavailable until there is one.

const HEADER = `# Local secrets — gitignored. Never commit this file.
#
# The name matters: Sonata reads ${KEY_NAME} and nothing else.
# A key saved as OPEN_ROUTER_KEY is silently ignored.
# Get one at https://openrouter.ai/keys
`;

/**
 * Set one name in an .env, leaving every other line exactly as it was.
 *
 * A first run writes the file; a second run edits one line of it. Anything that
 * rewrote the whole file would take the ports, the sandbox token and whatever
 * else a working install has accumulated with it.
 */
export function upsertEnvLine(text: string, name: string, value: string): string {
  const line = `${name}=${value}`;
  const lines = text.split("\n");
  const index = lines.findIndex((raw) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(raw));
  if (index >= 0) {
    lines[index] = line;
    return lines.join("\n");
  }
  const body = text.trimEnd();
  return body ? `${body}\n${line}\n` : `${HEADER}${line}\n`;
}

function mask(key: string): string {
  return key.length <= 10 ? "•".repeat(key.length) : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

interface InitOptions {
  /** `--key sk-or-…`, for a machine that has nobody sitting at it. */
  key?: string;
  /** `--yes`: keep every existing answer, ask nothing. */
  yes: boolean;
}

async function askForKey(existing: string | undefined, options: InitOptions): Promise<string | null> {
  if (options.key) return options.key;
  if (options.yes) return null;
  if (!process.stdin.isTTY) {
    say("  (nothing is attached to stdin, so nothing was asked — pass --key to set one)");
    return null;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const prompt = existing
      ? `  ${KEY_NAME} is already set (${mask(existing)}). Paste a new one, or Enter to keep it: `
      : `  Paste your OpenRouter key (Enter to skip — https://openrouter.ai/keys): `;
    const answer = (await rl.question(prompt)).trim();
    return answer || null;
  } finally {
    rl.close();
  }
}

export async function initCommand(options: InitOptions): Promise<number> {
  say(`Sonata init — ${REPO_ROOT}`);

  // 1. The key.
  const envPath = path.join(REPO_ROOT, ".env");
  const existingText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const existingKey = parseEnvKeys(existingText).get(KEY_NAME) || undefined;

  say();
  say(`API key — ${short(envPath)}`);
  const answer = await askForKey(existingKey, options);
  const key = answer ?? existingKey ?? "";

  if (answer) {
    writeFileSync(envPath, upsertEnvLine(existingText, KEY_NAME, answer), "utf8");
    say(`  wrote ${KEY_NAME} to ${short(envPath)} (${mask(answer)})`);
  } else if (existingKey) {
    say(`  kept the key already in ${short(envPath)} (${mask(existingKey)})`);
  } else {
    if (!existingText) {
      writeFileSync(envPath, upsertEnvLine("", KEY_NAME, ""), "utf8");
      say(`  wrote ${short(envPath)} with an empty ${KEY_NAME} — fill it in when you have one`);
    }
    say("  no key set. Everything below still installs, and the clones still run.");
  }

  // 2. The databases. Each clone's own db:init is the one path that applies its
  // schema — the dashboard, the reset CLI and this command all end up there.
  say();
  say("Databases — applying each clone's db/schema.sql");
  let failed = 0;
  for (const app of await loadApps()) {
    if (!app.clone) continue;
    const result = spawnSync("npm", ["run", "db:init", "-w", app.clone.workspace], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (result.status === 0) {
      say(`  ${app.label.padEnd(9)} ${app.clone.databases.map((d) => d.file).join(", ")} ready`);
      continue;
    }
    failed++;
    const said = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").filter(Boolean).at(-1);
    say(`  ${app.label.padEnd(9)} FAILED — ${said ?? `exit ${String(result.status)}`}`);
    say(`            fix: npm run db:init -w ${app.clone.workspace}   (run it here to see all of it)`);
  }
  say("  the dashboard's own platform.db is created the first time it runs.");

  // 3. What to do now.
  say();
  if (failed > 0) {
    say(`${failed} clone${failed === 1 ? "" : "s"} could not be initialised. Fix the above, then run \`sonata init\` again.`);
    return 1;
  }

  say("Ready. From here:");
  say("  sonata up                       start the dashboard and the three clones");
  say("  open http://localhost:3000      the dashboard");
  say("  sonata doctor                   check all of it again, any time");
  if (!key) {
    say();
    say("Until a key is set:");
    say(`  ${NO_KEY_MEANS}`);
    say(`  Set one with \`sonata init\` again, by editing ${short(envPath)}, or in the dashboard's Settings.`);
  } else {
    say('  sonata world create "a 12-person fintech, mid-audit"     clone a business');
  }
  return 0;
}
