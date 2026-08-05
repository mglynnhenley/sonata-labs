import { NextResponse } from "next/server";
import { allTwinStatuses } from "@/lib/twins";
import { connectionView } from "../../connect/_lib/connection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the Connect page prints: the snippets, the tool inventory, and the
 * live state of the three clones. The page renders this server-side for the first
 * paint and polls it after, so the Start buttons stay honest without a reload.
 *
 * The view is rebuilt on every poll rather than cached. It is only a handful of
 * stat calls, and one thing in it genuinely changes: whether `npm install` has
 * linked the launcher yet. Caching that would leave the "run npm install" warning
 * on screen after the user had done exactly what it asked.
 */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  try {
    const [twins, connection] = await Promise.all([
      allTwinStatuses(force),
      Promise.resolve(connectionView()),
    ]);
    return NextResponse.json({ connection, twins });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
