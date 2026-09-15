import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const apps = new Set(["gmail", "gmail-ui", "slack", "calendar", "attio", "google-docs", "google-ads", "linkedin", "excel"]);
const app = process.argv[2];
if (!apps.has(app)) throw new Error("Choose a supported Sonata app.");
const cwd = `/opt/sonata/apps/${app}`;
if (!existsSync(`${cwd}/package.json`)) throw new Error(`The runtime image does not contain ${app}.`);

let child;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
  });
}
const run = (args) => new Promise((resolve, reject) => {
  child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
const initialized = app === "gmail-ui" ? 0 : await run(["/opt/sonata/node_modules/tsx/dist/cli.mjs", "src/cli/db-init.ts"]);
process.exitCode = initialized || (stopping ? 1 : await run([
  "/opt/sonata/node_modules/next/dist/bin/next", "dev", "--port", "3000", "--hostname", "0.0.0.0",
]));
