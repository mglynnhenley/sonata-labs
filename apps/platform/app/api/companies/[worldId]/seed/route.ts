import { NextResponse } from "next/server";
import { ClonesDownError, UnknownCompanyError, seedCompany } from "@/lib/engine/clone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/companies/<id>/seed — put this business into Gmail, Slack and the
// calendar, now. The same `injectWorld` a run uses at tick 0, reached through
// the same `loadClone`, so a company seeded from this page and a company seeded
// by a run are the same company.
//
// Destructive: each twin is rebuilt from the body, so whatever was in the clones
// is gone. The warning belongs to the page — this route is the deed.
//
// Slow when the company has no backlog yet: writing the days behind it is a
// model call, and can take a minute. It is written down before it is injected,
// so it is only ever paid for once.

export async function POST(_req: Request, { params }: { params: Promise<{ worldId: string }> }) {
  const { worldId } = await params;
  try {
    return NextResponse.json({ seeded: await seedCompany(worldId) });
  } catch (err) {
    // A clone that is off is not a server error — it is a thing the user can fix
    // in one click, so it comes back as its own shape with the twins named.
    if (err instanceof ClonesDownError) {
      return NextResponse.json({ error: err.message, down: err.down }, { status: 409 });
    }
    const status = err instanceof UnknownCompanyError ? 404 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
