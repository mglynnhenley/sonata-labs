import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { railLabels } from "@/lib/ui/views";
import { getProfileEmail } from "@/lib/store/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const db = getDb();
  return NextResponse.json({ labels: railLabels(db), email: getProfileEmail(db) });
}
