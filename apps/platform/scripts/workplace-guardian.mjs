// Trusted supervisor. It owns cleanup even if the dashboard dies or hangs.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const MiB = 1024 * 1024;
export const ARCHIVE_LIMIT = 300 * MiB;
const LOG_LIMIT = 16 * MiB;

/** Drain both pipes concurrently, with separate files and hard byte limits. */
export function commandRunner(command = "docker", prefix = []) {
  return async (args, options = {}) => {
    const child = spawn(command, [...prefix, ...args], {
      stdio: ["ignore", "pipe", "pipe"], timeout: options.timeoutMs ?? 30_000, killSignal: "SIGKILL",
    });
    let stdout = "", stderr = "";
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(stderr || `Docker ${args[0]} failed (${signal ?? code}).`)));
    });
    const bounded = (limit, label) => {
      let size = 0;
      return new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > limit) {
          child.kill("SIGKILL");
          callback(new Error(`${label} exceeded its ${limit}-byte capture limit; partial evidence retained.`));
        } else callback(null, chunk);
      } });
    };
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    const out = options.stdoutFile ? createWriteStream(options.stdoutFile, { flags: "wx", mode: 0o600 }) :
      new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } });
    const err = options.stderrFile ? createWriteStream(options.stderrFile, { flags: "wx", mode: 0o600 }) :
      new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const copies = [
      pipeline(child.stdout, bounded(options.stdoutLimit ?? MiB, "Standard output"), out),
      pipeline(child.stderr, bounded(options.stderrLimit ?? LOG_LIMIT, "Standard error"), err),
    ];
    // An output error (including a full host disk) must not leave a blocked Docker client.
    for (const copied of copies) copied.catch(() => child.kill("SIGKILL"));
    const results = await Promise.allSettled([...copies, completed]);
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    return { stdout: stdout.trim(), stderr };
  };
}

const run = commandRunner();

/** Pause preserves tmpfs while stopping concurrent agent writes; stopping loses it. */
export async function captureWorkspace(manifest, directory, execute = run, limit = ARCHIVE_LIMIT) {
  const name = manifest.containers.agent;
  if (!manifest.volumes?.workspace) throw new Error("This workplace has no capturable workspace volume; direct container tmpfs cannot be exported by Docker cp.");
  const inspected = await execute(["inspect", "--format", "{{json .State}}", name]);
  const state = JSON.parse(inspected.stdout);
  if (!state.Running) throw new Error("Agent container is no longer running; its temporary workspace cannot be captured.");
  const mounts = JSON.parse((await execute(["inspect", "--format", "{{json .Mounts}}", name])).stdout);
  if (!mounts.some(mount => mount.Type === "volume" && mount.Name === manifest.volumes.workspace && mount.Destination === "/workspace")) {
    throw new Error("The agent's workspace mount does not match its recorded run-owned volume.");
  }
  if (!state.Paused) await execute(["pause", name]);
  const partial = path.join(directory, "agent-workspace.tar.partial");
  await execute(["cp", `${name}:/workspace/.`, "-"], {
    stdoutFile: partial, stdoutLimit: limit,
    stderrFile: path.join(directory, "agent-workspace-capture.stderr.log"),
  });
  const archive = path.join(directory, "agent-workspace.tar");
  renameSync(partial, archive);
  return { status: "captured", file: path.basename(archive), maxBytes: limit, frozen: true };
}

export async function cleanupWorkplace(directory, reason, execute = run) {
  const manifestFile = path.join(directory, "workplace.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const failures = [];
  let workspaceArchive = { status: "not-started" };
  // Archive bytes as data. Never extract or execute agent-produced files on the host.
  if (manifest.agentStarted) {
    try { workspaceArchive = await captureWorkspace(manifest, directory, execute); }
    catch (error) {
      workspaceArchive = { status: "incomplete", error: error.message,
        ...(existsSync(path.join(directory, "agent-workspace.tar.partial")) ? { partialFile: "agent-workspace.tar.partial" } : {}) };
      failures.push(`Workspace archive: ${error.message}`);
    }
  }
  const containers = [...Object.values(manifest.containers.apps), manifest.containers.gateway, manifest.containers.agent, manifest.containers.operator].filter(Boolean);
  await Promise.all(containers.map(async name => {
    try {
      await execute(["logs", name], { stdoutFile: path.join(directory, `${name}.log`), stdoutLimit: LOG_LIMIT,
        stderrFile: path.join(directory, `${name}.stderr.log`), stderrLimit: LOG_LIMIT });
    } catch (error) {
      if (!/No such container|not found/.test(error.message)) failures.push(`Container logs (${name}): ${error.message}`);
    }
    try { await execute(["rm", "--force", name]); }
    catch (error) { if (!error.message.includes("No such container")) failures.push(error.message); }
  }));
  for (const network of Object.values(manifest.networks)) {
    try { await execute(["network", "rm", network]); }
    catch (error) { if (!/not found|No such network/.test(error.message)) failures.push(error.message); }
  }
  for (const volume of Object.values(manifest.volumes ?? {})) {
    try { await execute(["volume", "rm", volume]); }
    catch (error) { if (!/not found|No such volume/.test(error.message)) failures.push(error.message); }
  }
  const latest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : manifest;
  const temporary = `${manifestFile}.guardian`;
  const result = { ...latest, status: failures.length ? "cleanup-failed" : "stopped", stoppedBecause: reason,
    cleanupErrors: failures, workspaceArchive, stoppedAt: Date.now() };
  writeFileSync(temporary, JSON.stringify(result, null, 2), { mode: 0o600 });
  renameSync(temporary, manifestFile);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { directory, owner, deadline } = JSON.parse(process.argv[2]);
  let cleaning;
  const cleanup = reason => cleaning ??= (async () => {
    clearInterval(watch);
    try {
      const result = await cleanupWorkplace(directory, reason);
      if (result.cleanupErrors.length) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`Workplace cleanup failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  })();
  const watch = setInterval(() => {
    if (process.ppid !== owner) void cleanup("dashboard owner disappeared");
    else if (Date.now() >= deadline) void cleanup("external wall-clock deadline reached");
  }, 1000);
  process.on("SIGTERM", () => { void cleanup("workplace finalised"); });
  process.on("SIGINT", () => { void cleanup("workplace interrupted"); });
}
