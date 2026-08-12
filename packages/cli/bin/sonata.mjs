#!/usr/bin/env node

// The bin, in plain JavaScript on purpose.
//
// This is the one file that runs before anything about the machine is known to
// work, so it may not depend on TypeScript, on a build step, or on the rest of
// the install. Its whole job is to turn the two failures that happen before
// `sonata doctor` can even load — a Node that is too old, and an install that
// never happened — into a sentence with a fix in it, and then hand over to the
// real CLI under tsx.
//
// Two bin names, and neither is what the docs tell you to type.
//
//   sonata-labs   this project's name, and nobody else's on the registry
//   sonata        kept, because removing it is the dangerous move
//
// `sonata` is a real published package — sonata@0.0.3, "a simple web framework",
// bin `./bin/sonata`. npx resolves a bare name against `node_modules/.bin`
// first and the registry second, so inside an installed checkout this entry is
// the only thing standing between `npx sonata` and downloading and running that
// stranger's CLI. Deleting the name would hand every old habit and every stale
// copy of our own docs straight to it.
//
// What no bin can fix: before `npm install` there is no `node_modules/.bin`, so
// npx has nothing to ask but the registry. That is why every document in this
// repo says `npm run sonata -- <command>` — npm run reads package.json and
// reaches this file by path, so it cannot resolve to anything but this file, at
// any point in the install.

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
