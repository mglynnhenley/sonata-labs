// Trusted host supervisor for a shared image build. No agent code runs here.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

/** Keep the child group bounded even when the dashboard disappears. */
export function superviseBuild({ command, args, cwd, owner, deadline, pollMs = 250, killGraceMs = 1000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: true, stdio: "inherit" });
    let reason;
    let escalation;
    let completed = false;
    const signalGroup = signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const stop = message => {
      if (reason || completed) return;
      reason = message;
      process.stderr.write(`Image build stopped: ${message}.\n`);
      signalGroup("SIGTERM");
      escalation = setTimeout(() => signalGroup("SIGKILL"), killGraceMs);
    };
    const interrupt = () => stop("supervisor interrupted");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const watch = setInterval(() => {
      if (process.ppid !== owner) stop("dashboard owner disappeared");
      else if (Date.now() >= deadline) stop("image build exceeded its deadline");
    }, pollMs);
    const finish = (error, code) => {
      if (completed) return;
      completed = true;
      clearInterval(watch);
      clearTimeout(escalation);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      // A builder may exit before one of its Docker children. Clear that group
      // before releasing the shared build promise or reporting completion.
      signalGroup("SIGKILL");
      if (error) reject(error);
      else resolve(reason ? 1 : code ?? 1);
    };
    child.once("error", error => finish(error));
    child.once("close", code => finish(undefined, code));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { root, owner, timeoutMs = 15 * 60_000 } = JSON.parse(process.argv[2]);
  process.exitCode = await superviseBuild({ command: process.execPath,
    args: [path.join(root, "integrations/runtime/build.mjs")], cwd: root,
    owner, deadline: Date.now() + timeoutMs });
}
