import { NextResponse } from "next/server";
import { isTwinName, startTwin, stopTwin, twinLogTail, twinStatus } from "@/lib/twins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ twin: string; action: string }> };

const ACTIONS = ["health", "start", "stop", "restart"] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

async function run(twin: string, action: string) {
  if (!isTwinName(twin)) {
    return NextResponse.json({ error: `no twin called "${twin}"` }, { status: 404 });
  }
  if (!isAction(action)) {
    return NextResponse.json(
      { error: `"${action}" is not one of ${ACTIONS.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    switch (action) {
      case "health":
        return NextResponse.json({ twin: await twinStatus(twin, true) });
      case "start":
        return NextResponse.json({ twin: await startTwin(twin) });
      case "stop":
        return NextResponse.json({ twin: await stopTwin(twin) });
      case "restart": {
        await stopTwin(twin);
        return NextResponse.json({ twin: await startTwin(twin) });
      }
    }
  } catch (err) {
    // A failed start is nearly always something the twin printed on its way
    // down, so hand back the log tail rather than a bare message.
    return NextResponse.json(
      { error: (err as Error).message, log: twinLogTail(twin, 20) },
      { status: 500 },
    );
  }
}

/** Health only — reading state must stay a GET. */
export async function GET(_request: Request, { params }: Params) {
  const { twin, action } = await params;
  if (action !== "health") {
    return NextResponse.json({ error: `use POST for "${action}"` }, { status: 405 });
  }
  return run(twin, action);
}

export async function POST(_request: Request, { params }: Params) {
  const { twin, action } = await params;
  return run(twin, action);
}
