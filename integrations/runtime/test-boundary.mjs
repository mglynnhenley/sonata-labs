#!/usr/bin/env node
/**
 * Exercise an actual running MCP container, with no paid model requests.
 * Usage: node integrations/runtime/test-boundary.mjs A/workplace.json B/workplace.json [evidence.json]
 * Both workplaces must be live and A must include a seeded Slack provider.
 * Adversarial Node runs through trusted docker exec; it is never exposed as an
 * agent tool. Only test summaries are saved, never credentials or app contents.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function command(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const output = [], errors = [];
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(Buffer.concat(output).toString()) : reject(new Error(`Docker probe exited ${code}: ${Buffer.concat(errors).toString().slice(-1000)}`)));
    child.stdin.end(input);
  });
}
const inspect = async (kind, name) => JSON.parse(await command([kind, "inspect", name]))[0];

export async function probeBoundaries(firstPath, secondPath, evidencePath = ".context/stage2-boundary-verification.json") {
  const a = JSON.parse(readFileSync(firstPath, "utf8"));
  const b = JSON.parse(readFileSync(secondPath, "utf8"));
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  if (a.runId === b.runId) throw new Error("Boundary verification needs two different workplaces.");
  const [agent, gateway, agentNetwork, backendNetwork] = await Promise.all([
    inspect("container", a.containers.agent), inspect("container", a.containers.gateway),
    inspect("network", a.networks.agent), inspect("network", a.networks.backend),
  ]);
  const env = Object.fromEntries(agent.Config.Env.map(item => { const i = item.indexOf("="); return [item.slice(0, i), item.slice(i + 1)]; }));
  const host = agent.HostConfig;
  check("agent image is the recorded immutable image", agent.Image === a.images.agent.id);
  check("agent has only its run's internal network", Object.keys(agent.NetworkSettings.Networks).length === 1 && a.networks.agent in agent.NetworkSettings.Networks);
  check("both run networks are internal", agentNetwork.Internal && backendNetwork.Internal);
  check("agent network has no reachable host bridge gateway", agentNetwork.Options["com.docker.network.bridge.gateway_mode_ipv4"] === "isolated");
  check("other run uses different networks", a.networks.agent !== b.networks.agent && a.networks.backend !== b.networks.backend);
  check("only application gateway joins both networks", Object.keys(gateway.NetworkSettings.Networks).sort().join() === [a.networks.agent, a.networks.backend].sort().join());
  check("agent root filesystem is read-only", host.ReadonlyRootfs);
  check("agent has no elevated container privileges", !host.Privileged && host.CapDrop?.includes("ALL") && !host.CapAdd?.length && !host.Devices?.length);
  check("agent cannot gain new privileges", host.SecurityOpt?.includes("no-new-privileges:true") || host.SecurityOpt?.includes("no-new-privileges"));
  check("agent does not share host PID IPC or network namespaces", host.PidMode !== "host" && host.IpcMode !== "host" && host.NetworkMode !== "host");
  check("agent has bounded CPU memory and processes", (host.NanoCpus > 0 || host.CpuQuota > 0) && host.Memory > 0 && host.PidsLimit > 0,
    { cpus: host.NanoCpus / 1e9, memoryBytes: host.Memory, processes: host.PidsLimit });
  check("agent has only its run-owned scratch volume and no host filesystem mounts", agent.Mounts.every(mount =>
    (mount.Type === "tmpfs" && mount.Destination === "/tmp") ||
    (mount.Type === "volume" && mount.Name === a.volumes?.workspace && mount.Destination === "/workspace")));
  if (a.volumes?.workspace) {
    const volume = await inspect("volume", a.volumes.workspace);
    const options = volume.Options ?? {};
    check("workspace volume has a 256 MiB tmpfs bound", volume.Driver === "local" && options.type === "tmpfs" &&
      options.device === "tmpfs" && /(?:^|,)size=256m(?:,|$)/.test(options.o));
    check("workspace volume is unique to this run", a.volumes.workspace !== b.volumes?.workspace);
  } else check("workspace uses a capturable run-owned volume", false);
  check("agent exposes no host ports", !Object.values(agent.NetworkSettings.Ports ?? {}).some(value => value?.length));
  check("agent does not receive control or provider credentials", !Object.keys(env).some(key => /(?:CONTROL|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET|AZURE_OPENAI)/i.test(key)));

  const privateDestinations = [];
  for (const [owner, manifest] of [["own", a], ["other", b]]) {
    for (const [twin, name] of Object.entries(manifest.containers.apps)) {
      const app = await inspect("container", name);
      const address = app.NetworkSettings.Networks[manifest.networks.backend]?.IPAddress;
      // App images expose a fixed 3000 internally; use the declared port when present.
      const ports = Object.keys(app.Config.ExposedPorts ?? {}).map(value => Number(value.split("/")[0]));
      if (address) privateDestinations.push({ label: `${owner} ${twin} direct API`, host: address, port: ports[0] || 3000 });
    }
    if (manifest.containers.operator) {
      const operator = await inspect("container", manifest.containers.operator);
      const address = operator.NetworkSettings.Networks[manifest.networks.backend]?.IPAddress;
      if (address) privateDestinations.push({ label: `${owner} operator control proxy`, host: address, port: 3001 });
      check(`${owner} operator proxy is absent from the agent network`, !operator.NetworkSettings.Networks[manifest.networks.agent]);
    }
    if (owner === "other") {
      const otherGateway = await inspect("container", manifest.containers.gateway);
      const address = otherGateway.NetworkSettings.Networks[manifest.networks.agent]?.IPAddress;
      if (address) privateDestinations.push({ label: "other run gateway", host: address, port: 8080 });
    }
    for (const [twin, url] of Object.entries(manifest.urls)) {
      const parsed = new URL(url);
      privateDestinations.push({ label: `${owner} ${twin} host control port`, host: "host.docker.internal", port: Number(parsed.port) });
    }
  }
  for (const item of agentNetwork.IPAM.Config ?? []) {
    if (item.Gateway) privateDestinations.push({ label: "host network bridge", host: item.Gateway, port: 3000 });
  }
  const sentinel = path.resolve(".context", `boundary-host-${randomUUID()}.txt`);
  mkdirSync(path.dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, `private-host-sentinel-${randomUUID()}`);
  try {
    const config = { gateway: "http://sonata-gateway:8080", workspaceMarker: `stage2-preserved-notes:${a.runId}`, token: env.SONATA_TOKEN ?? env.SANDBOX_TOKEN,
      slack: a.agentUrls.slack, privateDestinations, hiddenPaths: [
        sentinel, process.cwd(), path.resolve("docs/benchmark-realism-plan.md"),
        "/repo", "/app/packages/scenarios", "/opt/sonata/scenarios", "/run/gateway.json",
        "/var/run/docker.sock", "/run/docker.sock", "/root/.ssh", "/root/.aws",
        `/proc/1/root${sentinel}`,
      ] };
    const program = `const config = ${JSON.stringify(config)};\n${insideContainer.toString()}\nawait insideContainer(config);`;
    const output = await command(["exec", "-i", a.containers.agent, "node", "--input-type=module"], program);
    const inside = JSON.parse(output);
    checks.push(...inside);
  } finally { rmSync(sentinel, { force: true }); }
  const evidence = { checkedAt: new Date().toISOString(), runIds: [a.runId, b.runId], agentImage: agent.Image,
    workspaceMarker: `stage2-preserved-notes:${a.runId}`,
    passed: checks.every(item => item.passed), checks };
  mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}

async function insideContainer(config) {
  const fs = await import("node:fs");
  const http = await import("node:http");
  const net = await import("node:net");
  const dns = await import("node:dns/promises");
  const checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  const read = file => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return null; } };
  check("actual agent user is non-root", process.getuid() !== 0, { uid: process.getuid() });
  const status = read("/proc/self/status") ?? "";
  check("actual process has no effective capabilities", /^CapEff:\s+0+$/m.test(status));
  check("actual process has no-new-privileges set", /^NoNewPrivs:\s+1$/m.test(status));
  check("hidden host files evaluator materials and management socket are absent", config.hiddenPaths.every(file => !fs.existsSync(file)));
  check("process environment has no provider or control credentials", !Object.keys(process.env).some(key => /(?:CONTROL|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET|AZURE_OPENAI)/i.test(key)));
  const pidEnv = read("/proc/1/environ") ?? "";
  check("PID1 environment has no provider or control credentials", !pidEnv.split("\0").some(entry => /^(?:[^=]*CONTROL|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET[^=]*)=/.test(entry)));
  let rootWritable = false;
  try { fs.writeFileSync("/boundary-write-test", "test"); rootWritable = true; fs.unlinkSync("/boundary-write-test"); } catch {}
  check("actual root filesystem rejects writes", !rootWritable);
  let workspaceWritable = false;
  try { fs.writeFileSync("/workspace/boundary-test", "own workspace"); workspaceWritable = true; fs.unlinkSync("/workspace/boundary-test"); } catch {}
  check("own workspace permits agent writes", workspaceWritable);
  if (workspaceWritable) fs.writeFileSync("/workspace/stage2-verification.txt", config.workspaceMarker);
  const workspace = fs.statfsSync("/workspace");
  check("own workspace storage is bounded to 256 MiB", workspace.bsize * workspace.blocks <= 256 * 1024 * 1024,
    { bytes: workspace.bsize * workspace.blocks });
  const limits = { cpu: read("/sys/fs/cgroup/cpu.max"), memory: read("/sys/fs/cgroup/memory.max"), pids: read("/sys/fs/cgroup/pids.max") };
  check("actual cgroup enforces CPU memory and process bounds", limits.cpu && !limits.cpu.startsWith("max") &&
    Number(limits.memory) > 0 && Number.isFinite(Number(limits.memory)) && Number(limits.pids) > 0 && Number.isFinite(Number(limits.pids)), limits);
  const request = (origin, target, { method = "GET", headers = {}, body = "" } = {}) => new Promise(resolve => {
    const url = new URL(origin);
    const req = http.request({ hostname: url.hostname, port: url.port, path: target, method,
      headers: { ...headers, "content-length": Buffer.byteLength(body) }, timeout: 1200 }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => { let json; try { json = JSON.parse(Buffer.concat(chunks)); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", error => resolve({ error: error.code ?? "unreachable" }));
    req.end(body);
  });
  const health = await request(config.gateway, "/healthz");
  check("own gateway is reachable", health.status === 200 && health.json?.ok === true);
  const auth = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  const own = config.slack ? await request(config.gateway, "/slack/api/auth.test", { method: "POST", headers: auth, body: "{}" }) : {};
  check("own permitted Slack provider works with its agent credential", own.status === 200 && own.json?.ok === true,
    { status: own.status ?? null, providerAccepted: own.json?.ok === true });
  const denied = ["/", "/api/settings", "/api/sessions", "/slack/", "/slack/api/health", "/slack/api/sandbox/snapshot",
    "/slack/api/sandbox/reset", "/slack/api/sandbox/seed", "/slack/api/sandbox/audit", "/slack/api/sandbox/inject",
    "/gmail/oauth/register", "/gmail/oauth/authorize", "/v1/chat/completions",
    "/slack/../api/sandbox/reset", "/slack/%2e%2e/api/sandbox/reset", "/slack/api%2fsandbox%2freset", "/slack/api%252fsandbox%252freset",
    "http://host.docker.internal:3000/api/settings", "//host.docker.internal:3000/api/settings"];
  for (const target of denied) {
    const result = await request(config.gateway, target, { method: target.includes("reset") || target.includes("seed") || target.includes("inject") ? "POST" : "GET", headers: auth });
    check(`gateway refuses ${target}`, result.status === 403, { status: result.status ?? null });
  }
  const control = await request(config.gateway, "/slack/api/auth.test", { headers: { ...auth, "x-sandbox-token": config.token } });
  check("gateway refuses control header access on an allowed resource", control.status === 403);
  const connect = (hostname, port) => new Promise(resolve => {
    const socket = net.createConnection({ host: hostname, port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
  const destinations = [...config.privateDestinations,
    { label: "host platform", host: "host.docker.internal", port: 3000 },
    { label: "OrbStack host platform", host: "host.internal", port: 3000 },
    { label: "public IPv4 HTTPS", host: "1.1.1.1", port: 443 },
    { label: "public IPv6 HTTPS", host: "2606:4700:4700::1111", port: 443 },
    { label: "direct external DNS TCP", host: "8.8.8.8", port: 53 },
    { label: "real model API", host: "openrouter.ai", port: 443 },
  ];
  await Promise.all(destinations.map(async target => check(`network blocks ${target.label}`, !await connect(target.host, target.port))));
  for (const explicit of [false, true]) {
    const resolver = new dns.Resolver({ timeout: 700, tries: 1 });
    if (explicit) resolver.setServers(["8.8.8.8"]);
    let resolved = false;
    try { await resolver.resolve4("example.com"); resolved = true; } catch {}
    check(explicit ? "direct external DNS resolution is blocked" : "configured DNS does not resolve arbitrary public domains", !resolved);
  }
  process.stdout.write(JSON.stringify(checks));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2] || !process.argv[3]) throw new Error("Pass two live workplace manifest paths.");
  const evidence = await probeBoundaries(process.argv[2], process.argv[3], process.argv[4]);
  console.log(JSON.stringify({ passed: evidence.passed, checks: evidence.checks.length,
    failures: evidence.checks.filter(check => !check.passed) }, null, 2));
  if (!evidence.passed) process.exitCode = 1;
}
