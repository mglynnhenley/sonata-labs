// Reset working.db to the pristine snapshot.
//
//   PORT=3200 npm run reset
//
// Prefers the in-process endpoint (the server owns the SQLite handle); falls
// back to a direct file copy when the server isn't running.

import { resetWorking } from "../lib/reset.js";

const PORT = process.env.PORT || "3200";
const URL_ = process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`;

async function main() {
  const note = process.argv.slice(2).join(" ") || "reset via CLI";
  try {
    const res = await fetch(`${URL_}/api/sandbox/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { ok: boolean; messages?: number; error?: string };
    if (!body.ok) throw new Error(body.error ?? "reset failed");
    console.log(`Reset via server — ${body.messages} messages restored.`);
    return;
  } catch {
    console.log("Server not reachable; resetting files directly…");
  }
  const { messages } = resetWorking(note);
  console.log(`Reset locally — ${messages} messages restored.`);
}

main().catch((e) => {
  console.error("Reset failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
