import { NextResponse } from "next/server";
import { getChaos, setChaos, resetChaos, recentFaults, type ChaosConfig } from "@/lib/slack/chaos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Control surface for fault injection.
//   GET                      → current config + recently injected faults
//   POST {…partial config}   → merge into the config (resets the PRNG stream)
//   DELETE                   → back to defaults (all faults off)
//
// Deliberately NOT under /api/<method>: this is sandbox machinery, not part of
// the Slack API surface an agent should see.

export async function GET() {
  return NextResponse.json({ config: getChaos(), faults: recentFaults() });
}

export async function POST(req: Request) {
  let patch: Partial<ChaosConfig>;
  try {
    patch = (await req.json()) as Partial<ChaosConfig>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (typeof patch !== "object" || patch === null) {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  if (patch.errorRate !== undefined && (patch.errorRate < 0 || patch.errorRate > 1)) {
    return NextResponse.json(
      { ok: false, error: "errorRate must be between 0 and 1" },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, config: setChaos(patch) });
}

export async function DELETE() {
  return NextResponse.json({ ok: true, config: resetChaos() });
}
