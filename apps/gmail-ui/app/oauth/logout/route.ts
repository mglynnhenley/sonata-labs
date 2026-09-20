import { NextResponse } from "next/server";
import { UI_REDIRECT_URI } from "@/lib/oauth-config";
import { clearSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await clearSession();
  return NextResponse.redirect(new URL("/signed-out", new URL(UI_REDIRECT_URI).origin), 302);
}

export async function GET() {
  await clearSession();
  return NextResponse.redirect(new URL("/signed-out", new URL(UI_REDIRECT_URI).origin), 302);
}
