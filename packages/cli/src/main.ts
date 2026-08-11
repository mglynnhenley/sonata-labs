import { PrerequisiteError } from "./apps";
import { doctorCommand } from "./doctor";
import { initCommand } from "./init";
import { ENGINE_COMMANDS, passthrough } from "./passthrough";
import { say } from "./render";
import { enterPlatform } from "./repo";
import { downCommand, upCommand } from "./supervise";

// sonata — the front door.
//
//   sonata doctor    what is missing, and the command that fixes it
//   sonata init      .env and the clones' databases, from nothing
//   sonata up/down   four terminals, in one
//
// Everything else is the product's own CLI, handed straight through.

const USAGE = `sonata — clone a business, run an agent inside it, score the day

  Starting from nothing
    sonata doctor              Check every prerequisite; print the fix for each
    sonata init                Write .env and apply every clone's schema
        --key <sk-or-…>        Set the OpenRouter key without being asked
        --yes                  Keep every existing answer; ask nothing
    sonata up [app …]          Start the four apps and wait until they answer
    sonata down [app …]        Stop the ones Sonata started
                               app: platform, gmail, slack, calendar (default: all)

  Then — the dashboard, without the dashboard:`;

interface Args {
  words: string[];
  flags: Map<string, string | true>;
}

/** The same shape the platform CLI parses: --flag value, --flag=value, --switch. */
function parseArgs(argv: string[]): Args {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      i++;
    } else {
      flags.set(body, true);
    }
  }
  return { words, flags };
}

function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Our half of the help, then the engine's own — never a copy of it. */
async function usage(): Promise<number> {
  say(USAGE);
  await passthrough(["help"]);
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.words[0];
  const rest = args.words.slice(1);

  // Stand in apps/platform before anything else: platform.db, data/runs and the
  // twins' logs are all resolved from the working directory, and a command run
  // from somewhere else would quietly open a second, empty one.
  enterPlatform();

  if (command === undefined || command === "help") {
    process.exitCode = await usage();
    return;
  }
  if (ENGINE_COMMANDS.includes(command)) {
    process.exitCode = await passthrough(process.argv.slice(2));
    return;
  }

  switch (command) {
    case "doctor":
      process.exitCode = await doctorCommand();
      return;
    case "up":
      process.exitCode = await upCommand(rest);
      return;
    case "down":
      process.exitCode = await downCommand(rest);
      return;
    case "init":
      process.exitCode = await initCommand({
        ...(flag(args, "key") ? { key: flag(args, "key") as string } : {}),
        yes: args.flags.has("yes"),
      });
      return;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n`);
      await usage();
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  if (err instanceof PrerequisiteError) {
    process.stderr.write(`${err.message}\n  fix: ${err.fix}\n`);
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exitCode = 1;
});
