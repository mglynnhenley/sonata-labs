import { NextResponse } from "next/server";
import { connectConfig } from "../../../connect/_lib/connection";
import { runHandshake } from "../../../connect/_lib/handshake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Connect to the twins the way the user's agent is about to, and report what it
 * saw. POST rather than GET because it is an act the user asked for, even though
 * every call it makes is a read.
 */
export async function POST() {
  try {
    return NextResponse.json({ test: await runHandshake(connectConfig()) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
