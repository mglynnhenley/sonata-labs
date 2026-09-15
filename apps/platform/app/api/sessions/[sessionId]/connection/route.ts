import { NextResponse } from "next/server";
import { sessionConnection } from "@/lib/engine/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const connection = await sessionConnection(sessionId, token);
  if (!connection) return NextResponse.json({ error: "No ready session for this credential." }, { status: 401 });
  return NextResponse.json({ connection }, { headers: { "cache-control": "no-store" } });
}
