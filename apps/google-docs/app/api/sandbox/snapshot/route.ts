import { NextResponse } from "next/server";
import { requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { liveDb } from "@/lib/sandbox/live";
import { captureTwinSnapshot } from "@/lib/sandbox/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET, the gmail/slack meaning — the workspace as the judge sees it. NOT
// calendar's POST-to-promote: `promoteToSnapshot: true` on a seed already makes a
// generated world the baseline, so a second route for it would be a second way to
// do one thing.
//
// Read through liveDb(), because a snapshot answered from a working.db somebody
// swapped underneath us would score the agent against a workspace nobody else can
// see.
export function GET(req: Request) {
  const denied = requireSandboxToken(req);
  if (denied) return denied;
  try {
    return NextResponse.json(captureTwinSnapshot(liveDb()));
  } catch (err) {
    return sandboxError(err);
  }
}
