// Real image checks: no model calls, shared apps, database fixtures, or host repository mounts.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(path.join(root, ".context/runtime/images.json"), "utf8"));
const prefix = `sonata-image-smoke-${process.pid}`;
const evidence = { startedAt: new Date().toISOString(), images: manifest, apps: [], agent: null };
const created = [];
const network = `${prefix}-net`;
const requestedApps = process.argv.slice(2);
const smokeApps = requestedApps.length ? requestedApps : ["gmail", "slack", "calendar", "excel", "gmail-ui"];
assert.ok(smokeApps.every((app) => ["gmail", "slack", "calendar", "excel", "gmail-ui"].includes(app)), "Unsupported smoke app.");
function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `docker ${args[0]} failed.`);
  return result.stdout.trim();
}
const hardening = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "1536m", "--cpus", "2", "--tmpfs", "/tmp:rw,nosuid,noexec,size=128m,uid=1000,gid=1000"];
try {
  docker(["network", "create", "--internal", network]);
  for (const app of smokeApps) {
    const name = `${prefix}-${app}`;
    const data = path.join(root, ".context/runtime/smoke", name, "data");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    chmodSync(data, 0o777); // This test's isolated bind mount must be writable by Linux uid 1000.
    const cache = `/opt/sonata/apps/${app}/.next:rw,nosuid,size=512m,uid=1000,gid=1000`;
    const id = docker(["run", "-d", "--init", "--name", name, "--network", network, ...hardening,
      "--tmpfs", cache, "--mount", `type=bind,src=${data},dst=/opt/sonata/apps/${app}/data`,
      "--env", "SANDBOX_TOKEN=image-smoke-agent",
      "--env", "SANDBOX_CONTROL_TOKEN=image-smoke-control", manifest.apps.id, app]);
    created.push(name);
    // An internal bridge intentionally has no published host ports on Docker 29.
    // Probe from inside the container, through its actual HTTP server.
    const fetchApp = (route, token, method = "GET") => JSON.parse(docker(["exec", name, "node", "-e", `
      fetch(${JSON.stringify(`http://127.0.0.1:3000`)} + ${JSON.stringify(route)}, {
        redirect: 'manual', signal: AbortSignal.timeout(2000), method: ${JSON.stringify(method)},
        headers: ${JSON.stringify(token ? { authorization: `Bearer ${token}` } : {})}
      }).then(async r => console.log(JSON.stringify({status:r.status,body:await r.text()})))
        .catch(() => process.exit(1));
    `]));
    const route = app === "gmail-ui" ? "/" : "/api/health";
    let response;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        response = fetchApp(route);
        if (response.status < 500) break;
      } catch { /* Next is still starting. */ }
      if (docker(["inspect", name, "--format", "{{.State.Running}}"] ) !== "true") break;
      await setTimeout(250);
    }
    const logs = docker(["logs", name]);
    writeFileSync(path.join(root, `.context/stage2-images-${app}.log`), logs);
    assert.ok(response && response.status < 400, `${app} did not start: ${logs}`);
    const item = { app, id, status: response.status, health: app === "gmail-ui" ? "UI rendered or redirects to sign-in" : JSON.parse(response.body) };
    if (app !== "gmail-ui") {
      const method = app === "calendar" ? "POST" : "GET";
      const forbidden = fetchApp("/api/sandbox/snapshot", "image-smoke-agent", method);
      assert.equal(forbidden.status, 401, `${app} accepted agent credentials on the control plane`);
      const allowed = fetchApp("/api/sandbox/snapshot", "image-smoke-control", method);
      assert.equal(allowed.status, 200, `${app} snapshot failed: ${allowed.body}`);
      item.controlCredentialsSeparated = true;
    }
    evidence.apps.push(item);
    docker(["rm", "-f", name]);
    created.splice(created.indexOf(name), 1);
  }
  const name = `${prefix}-agent`;
  const child = spawn("docker", ["run", "--rm", "-i", "--name", name, "--network", "none", ...hardening,
    "--tmpfs", "/workspace:rw,nosuid,noexec,size=64m,uid=1000,gid=1000", manifest.agent.id, "slack"], { stdio: ["pipe", "pipe", "pipe"] });
  created.push(name);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "image-smoke", version: "1" } } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  const deadline = Date.now() + 20_000;
  let messages = [];
  while (Date.now() < deadline) {
    messages = stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    if (messages.some((message) => message.id === 2)) break;
    if (child.exitCode !== null) break;
    await setTimeout(100);
  }
  const tools = messages.find((message) => message.id === 2)?.result?.tools;
  assert.ok(tools?.some((tool) => tool.name === "slack_send_message"), `MCP failed: ${stdout}\n${stderr}`);
  const probe = JSON.parse(docker(["exec", name, "node", "-e", `
    const fs = require('node:fs');
    const denied = [];
    for (const p of ['/opt/sonata/forbidden', '/etc/forbidden']) {
      try { fs.writeFileSync(p, 'bad'); throw new Error('writable root: '+p); }
      catch (e) { if (!['EACCES','EROFS'].includes(e.code)) throw e; denied.push(p); }
    }
    fs.writeFileSync('/workspace/check', 'ok'); fs.writeFileSync('/tmp/check', 'ok');
    const source = fs.readdirSync('/opt/sonata');
    if (source.join(',') !== 'bundle-inputs.json,mcp.mjs') throw new Error('unexpected source: '+source);
    if (process.getuid() === 0) throw new Error('root user');
    console.log(JSON.stringify({uid:process.getuid(), denied, scratchWritable:true, source}));
  `]));
  evidence.agent = { tools: tools.length, ...probe };
  child.stdin.end();
  docker(["rm", "-f", name]);
  created.splice(created.indexOf(name), 1);
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(path.join(root, ".context/stage2-images-verification.json"), JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
} finally {
  for (const name of created) { try { docker(["rm", "-f", name]); } catch { /* Report the original failure. */ } }
  try { docker(["network", "rm", network]); } catch { /* Report the original failure. */ }
}
