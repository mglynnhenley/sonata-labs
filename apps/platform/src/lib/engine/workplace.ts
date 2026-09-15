import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { TWIN_API_PORTS, TWIN_UI_PORTS, type TwinName } from "@sonata/core";
import { docker } from "./docker";
import { validateTimingPolicy } from "../../../../../integrations/runtime/gateway-profile.mjs";

export interface RuntimeImages {
  version: number;
  sourceSha256: string;
  apps: { image: string; id: string };
  agent: { image: string; id: string };
}
export interface Workplace {
  agentToken: string;
  controlToken: string;
  directory: string;
  urls: Partial<Record<TwinName, string>>;
  agentUrls: Partial<Record<TwinName, string>>;
  humanUrls: Partial<Record<TwinName, string>>;
  agentContainer: string;
  images: RuntimeImages;
  scenarioSha256?: string;
  scriptHashes: Record<string, string>;
  /** Trusted host controller only; never include in the agent connection map. */
  timingControl?: { url: string; token: string };
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  snapshotHashes(): Partial<Record<TwinName, string>>;
}

export function repositoryRoot(): string {
  let root = process.cwd();
  while (!existsSync(path.join(root, "packages", "mcp", "bin", "sonata-mcp.js"))) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error("Cannot locate Sonata's repository.");
    root = parent;
  }
  return root;
}

/** Authored links name default local apps; a run's copy must point at its own apps. */
export function bindWorkplaceUrls<T>(value: T, workplace: Pick<Workplace, "urls" | "humanUrls">): T {
  const ports = new Map<number, string>();
  for (const twin of Object.keys(workplace.urls) as TwinName[]) {
    ports.set(TWIN_API_PORTS[twin], workplace.urls[twin]!);
    ports.set(TWIN_UI_PORTS[twin], workplace.humanUrls[twin] ?? workplace.urls[twin]!);
  }
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return item.replace(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\b/g,
      (origin, port: string) => ports.get(Number(port)) ?? origin);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, visit(val)]));
    return item;
  };
  return visit(value) as T;
}

/** Preserve only an authored baseline; app code comes from the pinned runtime image. */
export function copyWorkplaceBaseline(source: string, target: string, useSnapshot: boolean): void {
  const data = path.join(target, "data");
  mkdirSync(data, { recursive: true, mode: 0o777 });
  chmodSync(data, 0o777); // Private 0700 parent on host; only this app receives the bind mount.
  if (!useSnapshot) return;
  const snapshot = path.join(source, "data", "snapshot.db");
  if (!existsSync(snapshot)) throw new Error(`No saved baseline for ${path.basename(source)}. Load a company before starting without seeding.`);
  for (const name of ["snapshot.db", "working.db"]) {
    copyFileSync(snapshot, path.join(data, name));
    chmodSync(path.join(data, name), 0o666);
  }
}

async function reservedPort(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: (server.address() as { port: number }).port };
}
const closePort = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
const shared = globalThis as unknown as { __sonataRuntimeBuild?: Promise<RuntimeImages> };

/** Cancel one run's setup without cancelling a build shared by other runs. */
export function awaitedWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** One image builder for product launches and CLI setup; content hashes control reuse. */
export async function runtimeImages(): Promise<RuntimeImages> {
  if (shared.__sonataRuntimeBuild) return shared.__sonataRuntimeBuild;
  const root = repositoryRoot();
  shared.__sonataRuntimeBuild = (async () => {
    await docker(["info", "--format", "{{.ServerVersion}}"]);
    mkdirSync(path.join(root, ".context", "runtime"), { recursive: true });
    const log = openSync(path.join(root, ".context", "runtime", "build.log"), "a");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(root, "apps/platform/scripts/runtime-build-supervisor.mjs"),
          JSON.stringify({ root, owner: process.pid, timeoutMs: 15 * 60_000 })],
          { cwd: root, detached: true, stdio: ["ignore", log, log] });
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error("Container image setup failed. See .context/runtime/build.log.")));
      });
    } finally { closeSync(log); }
    return JSON.parse(readFileSync(path.join(root, ".context/runtime/images.json"), "utf8")) as RuntimeImages;
  })();
  try { return await shared.__sonataRuntimeBuild; }
  finally { delete shared.__sonataRuntimeBuild; }
}

/** Docker is the product workplace runtime; no shared-process fallback. */
export async function prepareWorkplace(runId: string, twins: TwinName[], useSnapshot: boolean,
  options: { signal?: AbortSignal; maxWallClockMs?: number; scenario?: unknown;
    timing?: { policy: "provider-operations-v1"; workUnitsPerTick: number } } = {}): Promise<Workplace> {
  if (!/^[\w-]+$/.test(runId)) throw new Error("Invalid workplace identifier.");
  const timing = options.timing ? validateTimingPolicy(options.timing) : undefined;
  const root = repositoryRoot();
  const directory = path.join(root, ".context", "workplaces", runId);
  mkdirSync(path.dirname(directory), { recursive: true });
  mkdirSync(directory, { mode: 0o700 });
  const images = await awaitedWithAbort(runtimeImages(), options.signal);
  options.signal?.throwIfAborted();
  const lifecycle = new AbortController();
  const allocationSignal = options.signal ? AbortSignal.any([options.signal, lifecycle.signal]) : lifecycle.signal;
  const prefix = `sonata-${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`;
  const networks = { backend: `${prefix}-apps`, agent: `${prefix}-agent`, operator: `${prefix}-operator` };
  const volumes = { workspace: `${prefix}-workspace` };
  const services = [...twins, ...(twins.includes("gmail") ? ["gmail-ui"] : [])];
  const containers = { apps: Object.fromEntries(services.map(t => [t, `${prefix}-${t}`])), gateway: `${prefix}-gateway`, agent: `${prefix}-worker`, operator: `${prefix}-operator` };
  const reservations = new Map<string, Awaited<ReturnType<typeof reservedPort>>>();
  const urls: Workplace["urls"] = {}, humanUrls: Workplace["humanUrls"] = {};
  let timingControl: Workplace["timingControl"];
  const agentUrls = Object.fromEntries(twins.map(t => [t, `http://sonata-gateway:8080/${t}`]));
  const agentToken = randomBytes(32).toString("hex"), controlToken = randomBytes(32).toString("hex");
  const cookieSecret = randomBytes(32).toString("hex"), clientSecret = randomBytes(32).toString("hex");
  const deadline = Date.now() + (options.maxWallClockMs ?? 60 * 60_000) + 60_000;
  const manifestFile = path.join(directory, "workplace.json");
  const scenarioSha256 = options.scenario === undefined ? undefined : createHash("sha256").update(JSON.stringify(options.scenario)).digest("hex");
  if (options.scenario !== undefined) writeFileSync(path.join(directory, "scenario.json"), JSON.stringify({ version: 1, sha256: scenarioSha256, scenario: options.scenario }, null, 2), { mode: 0o600 });
  const scriptHashes: Record<string, string> = {};
  for (const [name, source] of Object.entries({ "gateway.mjs": "integrations/runtime/gateway.mjs", "gateway-timing.mjs": "integrations/runtime/gateway-timing.mjs",
    "gateway-profile.mjs": "integrations/runtime/gateway-profile.mjs", "operator.mjs": "integrations/runtime/operator-proxy.mjs", "guardian.mjs": "apps/platform/scripts/workplace-guardian.mjs" })) {
    const contents = readFileSync(path.join(root, source));
    writeFileSync(path.join(directory, name), contents, { mode: 0o444 });
    scriptHashes[name] = createHash("sha256").update(contents).digest("hex");
  }
  let status = "preparing", agentStarted = false, guardian: ChildProcess | undefined;
  let guardianDone: Promise<void> | undefined, stopping: Promise<void> | undefined;
  const manifest = () => {
    const tmp = `${manifestFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ runId, directory, isolation: "docker-per-run-v1", status, owner: process.pid, deadline,
      containers, networks, volumes, urls, agentUrls, humanUrls, images, scenarioSha256, scriptHashes, agentStarted,
      ...(timing ? { timing } : {}) }, null, 2));
    renameSync(tmp, manifestFile);
  };
  manifest();
  const stop = (): Promise<void> => stopping ??= (async () => {
    lifecycle.abort(new Error("Workplace has been stopped."));
    await Promise.all([...reservations.values()].map(r => closePort(r.server)));
    reservations.clear();
    if (guardian) { guardian.kill("SIGTERM"); await guardianDone; }
  })();
  const labels = ["--label", `org.sonata.run=${runId}`, "--label", `org.sonata.workspace=${createHash("sha256").update(root).digest("hex").slice(0, 16)}`];
  const security = (memory = "768m") => ["--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128",
    "--cpus", "1", "--memory", memory, "--memory-swap", memory, "--log-opt", "max-size=5m", "--log-opt", "max-file=1",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,uid=1000,gid=1000", "--env", "HOME=/tmp", ...labels];
  try {
    const guardianLog = openSync(path.join(directory, "guardian.log"), "a");
    guardian = spawn(process.execPath, [path.join(directory, "guardian.mjs"), JSON.stringify({ directory, owner: process.pid, deadline })],
      { detached: true, stdio: ["ignore", guardianLog, guardianLog] });
    closeSync(guardianLog);
    guardianDone = new Promise<void>((resolve, reject) => {
      guardian!.once("error", reject);
      guardian!.once("close", code => {
        lifecycle.abort(new Error("Workplace guardian has stopped."));
        if (code === 0) resolve();
        else reject(new Error("Workplace cleanup failed; see its guardian log and manifest."));
      });
    });
    guardianDone.catch(() => undefined);
    for (const service of services) {
      copyWorkplaceBaseline(path.join(root, "apps", service), path.join(directory, "apps", service), useSnapshot && service !== "gmail-ui");
      const reservation = await reservedPort();
      reservations.set(service, reservation);
      const address = `http://127.0.0.1:${reservation.port}`;
      if (service === "gmail-ui") humanUrls.gmail = address;
      else { urls[service as TwinName] = address; humanUrls[service as TwinName] = address; }
    }
    if (timing) {
      const reservation = await reservedPort();
      reservations.set("timing-control", reservation);
      timingControl = { url: `http://127.0.0.1:${reservation.port}`, token: randomBytes(32).toString("hex") };
      mkdirSync(path.join(directory, "timing"), { mode: 0o777 });
      chmodSync(path.join(directory, "timing"), 0o777); // Only the trusted gateway receives this mount.
    }
    manifest();
    await docker(["network", "create", "--internal", ...labels, networks.backend], { signal: allocationSignal });
    await docker(["network", "create", "--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", ...labels, networks.agent], { signal: allocationSignal });
    await docker(["network", "create", ...labels, networks.operator], { signal: allocationSignal });
    await docker(["volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs",
      "--opt", "o=size=256m,uid=1000,gid=1000,nosuid,nodev,noexec", ...labels, volumes.workspace], { signal: allocationSignal });
    const upstreams = Object.fromEntries(twins.map(t => [t, `http://${t}:3000`]));
    writeFileSync(path.join(directory, "gateway.json"), JSON.stringify({ upstreams, publicOrigin: "http://sonata-gateway:8080",
      ...(timingControl ? { timing: { ...timing, token: timingControl.token, deadline, ledgerPath: "/evidence/provider-operations.jsonl" } } : {}) }));
    await docker(["create", "--name", containers.gateway, ...security(), "--sysctl", "net.ipv4.ip_forward=0", "--network", networks.agent, "--network-alias", "sonata-gateway",
      "--mount", `type=bind,source=${path.join(directory, "gateway.mjs")},target=/runtime/gateway.mjs,readonly`,
      "--mount", `type=bind,source=${path.join(directory, "gateway-timing.mjs")},target=/runtime/gateway-timing.mjs,readonly`,
      "--mount", `type=bind,source=${path.join(directory, "gateway-profile.mjs")},target=/runtime/gateway-profile.mjs,readonly`,
      "--mount", `type=bind,source=${path.join(directory, "gateway.json")},target=/runtime/config.json,readonly`,
      ...(timingControl ? ["--mount", `type=bind,source=${path.join(directory, "timing")},target=/evidence`] : []),
      "--entrypoint", "node", images.apps.id, "/runtime/gateway.mjs", "/runtime/config.json"], { signal: allocationSignal });
    await docker(["network", "connect", networks.backend, containers.gateway], { signal: allocationSignal });
    await docker(["start", containers.gateway], { signal: allocationSignal });
    const gateway = JSON.parse(await docker(["inspect", containers.gateway]))[0];
    const gatewayIp = gateway.NetworkSettings.Networks[networks.agent].IPAddress as string;
    if (!gatewayIp) throw new Error("Gateway did not receive a private address.");
    await docker(["create", "--name", containers.agent, ...security(), "--network", networks.agent, "--dns", "127.0.0.1",
      "--add-host", `sonata-gateway:${gatewayIp}`, "--mount", `type=volume,source=${volumes.workspace},target=/workspace,volume-nocopy`,
      "--workdir", "/workspace", "--env", "SONATA_TOKEN", "--entrypoint", "sleep", images.agent.id, "infinity"],
      { signal: allocationSignal, env: { ...process.env, SONATA_TOKEN: agentToken } });
    for (const service of services) {
      const env: NodeJS.ProcessEnv = { ...process.env, SANDBOX_TOKEN: agentToken, SANDBOX_CONTROL_TOKEN: controlToken,
        SANDBOX_AUTH: "oauth", SANDBOX_PUBLIC_URL: service === "gmail-ui" ? humanUrls.gmail : urls[service as TwinName], NEXT_TELEMETRY_DISABLED: "1", GMAIL_API_URL: "http://gmail:3000", GMAIL_API_PUBLIC_URL: urls.gmail,
        GMAIL_UI_REDIRECT_URI: humanUrls.gmail ? `${humanUrls.gmail}/oauth/callback` : undefined,
        GMAIL_UI_COOKIE_PREFIX: `gm_${runId}`, GMAIL_UI_COOKIE_SECRET: cookieSecret, GMAIL_UI_CLIENT_SECRET: clientSecret,
      };
      // Docker receives an explicit env allowlist, never the dashboard's environment.
      const names = ["SANDBOX_TOKEN", "SANDBOX_CONTROL_TOKEN", "SANDBOX_AUTH", "SANDBOX_PUBLIC_URL", "NEXT_TELEMETRY_DISABLED", "GMAIL_API_URL", "GMAIL_API_PUBLIC_URL",
        "GMAIL_UI_REDIRECT_URI", "GMAIL_UI_COOKIE_PREFIX", "GMAIL_UI_COOKIE_SECRET", "GMAIL_UI_CLIENT_SECRET"];
      await docker(["create", "--name", containers.apps[service], ...security("1536m"), "--network", networks.backend, "--network-alias", service,
        "--mount", `type=bind,source=${path.join(directory, "apps", service, "data")},target=/opt/sonata/apps/${service}/data`,
        "--tmpfs", `/opt/sonata/apps/${service}/.next:rw,nosuid,nodev,size=512m,uid=1000,gid=1000`,
        ...names.filter(n => env[n] !== undefined).flatMap(n => ["--env", n]), images.apps.id, service], { signal: allocationSignal, env });
    }
    const operatorListeners = services.map((service, i) => ({ port: 3001 + i, upstream: `http://${service}:3000` }));
    if (timingControl) operatorListeners.push({ port: 8081, upstream: `http://${containers.gateway}:8081` });
    writeFileSync(path.join(directory, "operator.json"), JSON.stringify({ listeners: operatorListeners }));
    await docker(["create", "--name", containers.operator, ...security(), "--sysctl", "net.ipv4.ip_forward=0", "--network", networks.operator,
      ...services.flatMap((service, i) => ["--publish", `127.0.0.1:${reservations.get(service)!.port}:${3001 + i}`]),
      ...(timingControl ? ["--publish", `127.0.0.1:${reservations.get("timing-control")!.port}:8081`] : []),
      "--mount", `type=bind,source=${path.join(directory, "operator.mjs")},target=/runtime/operator.mjs,readonly`,
      "--mount", `type=bind,source=${path.join(directory, "operator.json")},target=/runtime/config.json,readonly`,
      "--entrypoint", "node", images.apps.id, "/runtime/operator.mjs", "/runtime/config.json"], { signal: allocationSignal });
    await docker(["network", "connect", networks.backend, containers.operator], { signal: allocationSignal });
    status = "prepared"; manifest();
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], `Workplace failed: ${String(error)}; cleanup also failed: ${String(cleanup)}`); }
    throw error;
  }
  return {
    directory, urls, agentUrls, humanUrls, agentToken, controlToken, images, scenarioSha256, scriptHashes, timingControl, agentContainer: containers.agent, stop,
    snapshotHashes: () => Object.fromEntries(twins.flatMap(twin => {
      const file = path.join(directory, "apps", twin, "data", "snapshot.db");
      return existsSync(file) ? [[twin, createHash("sha256").update(readFileSync(file)).digest("hex")]] : [];
    })),
    async start(requestSignal) {
      const signal = AbortSignal.any([requestSignal, lifecycle.signal]);
      try {
        signal.throwIfAborted();
        await Promise.all([...reservations.values()].map(r => closePort(r.server)));
        reservations.clear();
        await docker(["start", containers.operator], { signal });
        for (const service of services) {
          signal.throwIfAborted();
          if (stopping) throw new Error("Workplace has been stopped.");
          await docker(["start", containers.apps[service]], { signal });
          status = "starting"; manifest();
          const readyBy = Date.now() + 120_000;
          for (;;) {
            signal.throwIfAborted();
            const state = JSON.parse(await docker(["inspect", "--format", "{{json .State}}", containers.apps[service]]));
            if (!state.Running) throw new Error(`${service} container stopped during startup. See its retained log.`);
            try {
              const response = await fetch(`${service === "gmail-ui" ? humanUrls.gmail : urls[service as TwinName]}/api/health`,
                { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
              if (response.ok) break;
            } catch { signal.throwIfAborted(); }
            if (Date.now() >= readyBy) throw new Error(`${service} did not become ready. See its workplace log.`);
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        }
        await docker(["start", containers.agent], { signal });
        agentStarted = true; status = "ready"; manifest();
      } catch (error) {
        try { await stop(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], `Workplace failed: ${String(error)}; cleanup also failed: ${String(cleanup)}`); }
        throw error;
      }
    },
  };
}
