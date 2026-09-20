import { authorizedControlRequest } from "@sonata/core/controlAuth";
import { activity, advance, assess, DeskError, execute, health, reset, seed, snapshot, tools } from "@/lib/desk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Two credentials, because two very different callers reach this service.
//
// The agent holds the sandbox token and may call tools and read the tool list.
// The engine holds the control token and may move simulated time, seed, reset,
// snapshot, read the audit log and ask for the assessment. That split is the
// whole reason a desk can be a twin at all: if the agent could call `advance` it
// could skip a deadline, and if it could call `assess` it could read the rules
// it is being marked against.

const CONTROL_ROUTES = ["sandbox", "activity"];

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new DeskError("Expected a JSON object body.");
  }
}

async function dispatch(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const url = new URL(req.url);
    const { path } = await params;
    const route = path.join("/");
    const method = req.method;

    if (route === "health" && method === "GET") return Response.json(health());

    if (CONTROL_ROUTES.includes(path[0]!)) {
      if (!authorizedControlRequest(req)) {
        return Response.json({ error: "Control token required." }, { status: 401 });
      }
      if (route === "activity" && method === "GET") {
        const since = Number(url.searchParams.get("sinceId") || url.searchParams.get("since") || 0);
        if (!Number.isSafeInteger(since) || since < 0) throw new DeskError("Invalid audit cursor.");
        return Response.json({ actions: activity(since) });
      }
      if (route === "sandbox/snapshot" && method === "GET") return Response.json(snapshot());
      if (route === "sandbox/seed" && method === "POST") return Response.json(seed());
      if (route === "sandbox/reset" && method === "POST") return Response.json(reset());
      if (route === "sandbox/advance" && method === "POST") {
        const input = await body(req);
        const phase = input.phase === "after" ? "after" : "before";
        if (typeof input.at !== "string") throw new DeskError("advance needs {at, phase}.");
        return Response.json(advance(input.at, phase));
      }
      if (route === "sandbox/assess" && method === "POST") {
        const input = await body(req);
        const through = input.completedThrough;
        if (through !== null && typeof through !== "string") {
          throw new DeskError("assess needs {completedThrough: string | null}.");
        }
        return Response.json(assess(through));
      }
      return Response.json({ error: "Unknown desk control operation." }, { status: 404 });
    }

    if (req.headers.get("authorization") !== `Bearer ${process.env.SANDBOX_TOKEN || "sandbox-token"}`) {
      return Response.json({ error: "Bearer token required." }, { status: 401 });
    }

    if (route === "tools" && method === "GET") return Response.json(tools());
    if (path[0] === "tools" && path.length === 2 && method === "POST") {
      const input = await body(req);
      const args = input.args;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new DeskError("Expected {args: object}.");
      }
      // No `at` is read off this request, deliberately. The desk owns the clock.
      return Response.json(execute(decodeURIComponent(path[1]!), args as Record<string, unknown>));
    }

    return Response.json({ error: "Unknown desk operation." }, { status: 404 });
  } catch (error) {
    if (error instanceof DeskError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    // A domain rule refusing an operation is an ordinary business answer, not a
    // fault: the agent cited an unavailable source, or asked for a review window
    // that is not open. It reaches the agent as a 422 with the rule's own words.
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
  }
}

export const GET = dispatch;
export const POST = dispatch;
