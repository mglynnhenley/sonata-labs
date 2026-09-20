import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const supervisor = fileURLToPath(new URL("./runtime-build-supervisor.mjs", import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

function fixture(t, hang = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sonata-image-supervisor-"));
  mkdirSync(path.join(root, "integrations/runtime"), { recursive: true });
  writeFileSync(path.join(root, "cache.json"), '{"previous":"image"}');
  const script = hang ? `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync('builder.pid', String(process.pid));
spawn(process.execPath, ['--input-type=module', '-e', "import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync('descendant.pid',String(process.pid)); setInterval(()=>{},1000)"], {stdio:'inherit'});
setInterval(()=>{},1000);
` : "import {writeFileSync} from 'node:fs'; writeFileSync('completed.json','{\"built\":true}');";
  writeFileSync(path.join(root, "integrations/runtime/build.mjs"), script);
  t.after(() => {
    for (const name of ["builder.pid", "descendant.pid", "supervisor.pid"]) {
      const file = path.join(root, name);
      if (existsSync(file)) { try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch {} }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("a hung image build reaches its external deadline and loses its whole process group", async t => {
  const root = fixture(t);
  const process_ = spawn(process.execPath, [supervisor, JSON.stringify({ root, owner: process.pid, timeoutMs: 750 })], { stdio: "ignore" });
  writeFileSync(path.join(root, "supervisor.pid"), String(process_.pid));
  const exited = once(process_, "exit");
  await until(() => existsSync(path.join(root, "descendant.pid")), "build descendants");
  const pids = ["builder.pid", "descendant.pid"].map(name => Number(readFileSync(path.join(root, name), "utf8")));
  const [code] = await exited;
  assert.equal(code, 1);
  await until(() => pids.every(pid => !alive(pid)), "process-group cleanup");
  assert.equal(readFileSync(path.join(root, "cache.json"), "utf8"), '{"previous":"image"}');
});

test("a vanished dashboard owner stops an image build without waiting for its deadline", async t => {
  const root = fixture(t);
  const parentProgram = `
import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,[${JSON.stringify(supervisor)},JSON.stringify({root:${JSON.stringify(root)},owner:process.pid,timeoutMs:60000})],{detached:true,stdio:'ignore'});
writeFileSync(${JSON.stringify(path.join(root, "supervisor.pid"))},String(child.pid));setInterval(()=>{},1000);
`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", parentProgram], { stdio: "ignore" });
  t.after(() => owner.kill("SIGKILL"));
  await until(() => existsSync(path.join(root, "descendant.pid")), "owned build descendants");
  const pids = ["builder.pid", "descendant.pid", "supervisor.pid"].map(name => Number(readFileSync(path.join(root, name), "utf8")));
  owner.kill("SIGKILL");
  await once(owner, "exit");
  await until(() => pids.every(pid => !alive(pid)), "orphan build cleanup");
  assert.equal(readFileSync(path.join(root, "cache.json"), "utf8"), '{"previous":"image"}');
});

test("successful image builds preserve their output and report completion", async t => {
  const root = fixture(t, false);
  const process_ = spawn(process.execPath, [supervisor, JSON.stringify({ root, owner: process.pid, timeoutMs: 1000 })], { stdio: "ignore" });
  const [code] = await once(process_, "exit");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "completed.json"), "utf8")), { built: true });
});
