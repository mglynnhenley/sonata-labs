#!/usr/bin/env node

// The bin, in plain JavaScript on purpose.
//
// This is the one file that runs before anything about the machine is known to
// work, so it may not depend on TypeScript, on a build step, or on the rest of
// the install. Its whole job is to turn the two failures that happen before
// `sonata doctor` can even load — a Node that is too old, and an install that
// never happened — into a sentence with a fix in it, and then hand over to the
// real CLI under tsx.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 20.12 is where `process.loadEnvFile` landed, which is how every CLI in this
// repo reads .env. Below it the platform CLI cannot see an API key at all.
const MIN_NODE = { major: 20, minor: 12 };

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const entry = path.join(packageDir, "src", "main.ts");

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)) {
  die(
    `Sonata needs Node ${MIN_NODE.major}.${MIN_NODE.minor} or newer — this is v${process.versions.node}.\n` +
      "  fix: nvm install 22 && nvm use 22   (or install Node 22 LTS from nodejs.org)",
  );
}

let tsxCli;
try {
  tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
} catch {
  die(
    "Sonata's dependencies are not installed — tsx is missing, so nothing here can run.\n" +
      `  fix: cd ${repoRoot} && npm install`,
  );
}

const child = spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

// Ctrl-C reaches the child too (same process group); the parent stays out of the
// way so the child's own handler gets to finish and print before we exit.
process.on("SIGINT", () => {});

child.on("error", (err) => die(`Could not start the Sonata CLI: ${err.message}`));
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners("SIGINT");
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
