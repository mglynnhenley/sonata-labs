import { handleAttio, json } from "@/lib/attio/route-helpers";
import { shapeSelf } from "@/lib/attio/shape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /v2/self — the first call every Attio client makes, the only way an agent
// confirms which workspace its key belongs to, and the cheapest credential
// probe. It is the one endpoint in this surface NOT wrapped in `data`, and
// copying that matters because clients unwrap by route.
export function GET(req: Request) {
  return handleAttio(req, (ctx) => json(shapeSelf(ctx, Date.now())));
}
