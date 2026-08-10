import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A trivial health probe so the platform's describe() has one code path per
// service. The UI is healthy if it can serve a request; it holds no state.
export function GET() {
  return NextResponse.json({ status: "ok", service: "gmail-ui", time: new Date().toISOString() });
}
