import { NextResponse } from "next/server";
import { requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { liveDb } from "@/lib/sandbox/live";
import { captureTwinSnapshot } from "@/lib/sandbox/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sandbox/snapshot — the mailbox as the judge sees it: label roster with
// unread counts, thread digests (subject/from/labels/counts, never bodies), and
// drafts. Taken either side of the agent and diffed; both snapshots ship inside
// the run artifact, so this is capped and digested rather than dumped.
export async function GET(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    // The capture goes back through this app's own Gmail API, which reads the
    // shared working handle — so refresh it first. A snapshot answered from a
    // working.db somebody swapped underneath us would score the agent against a
    // mailbox nobody else can see.
    liveDb();
    const snapshot = await captureTwinSnapshot(new URL(req.url).origin);
    return NextResponse.json(snapshot);
  } catch (err) {
    return sandboxError(err);
  }
}
