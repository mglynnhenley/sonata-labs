import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { sidebarView, userDirectory, channelDirectory } from "@/lib/ui/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const db = getDb();
  return NextResponse.json({
    ...sidebarView(db),
    directories: { users: userDirectory(db), channels: channelDirectory(db) },
  });
}
