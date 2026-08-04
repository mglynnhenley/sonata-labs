import { NextResponse } from "next/server";
import { SCENARIOS } from "@/lib/eval/scenarios";
import { toScenarioView } from "@/lib/eval/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The catalog, minus the assertion closures that make StressScenario
// unserializable.
export function GET() {
  try {
    return NextResponse.json({ scenarios: SCENARIOS.map(toScenarioView) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
