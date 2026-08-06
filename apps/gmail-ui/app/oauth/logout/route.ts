import { NextResponse } from "next/server";
import { clearSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  await clearSession();
  return NextResponse.redirect(new URL("/signed-out", new URL(req.url).origin), 302);
}

export async function GET(req: Request) {
  await clearSession();
  return NextResponse.redirect(new URL("/signed-out", new URL(req.url).origin), 302);
}
