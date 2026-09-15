import { spawn } from "node:child_process";

/** Docker commands are argument arrays; credentials travel through the environment. */
export function docker(args: string[], opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    opts.signal?.throwIfAborted();
    const child = spawn("docker", args, { env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal, timeout: opts.timeoutMs ?? 60_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-2_000_000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8_000); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Docker ${args[0]} failed: ${stderr.trim() || `exit ${code}`}`)));
  });
}
