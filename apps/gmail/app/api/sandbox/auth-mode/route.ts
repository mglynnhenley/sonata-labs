import { NextResponse } from "next/server";
import { requireSandboxToken, sandboxError } from "@/lib/sandbox/auth";
import { authMode, setAuthMode } from "@/lib/gmail/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Flip how /gmail/v1/* is gated, live — the dashboard's demo switch. This is a
// runtime override in process memory: SANDBOX_AUTH remains the durable setting
// and a restart falls back to it. Admin-gated like the rest of /api/sandbox/*.
export async function POST(req: Request): Promise<NextResponse> {
  const authErr = requireSandboxToken(req);
  if (authErr) return authErr;
  try {
    const body = (await req.json().catch(() => ({}))) as { mode?: string };
    if (body.mode !== "token" && body.mode !== "oauth") {
      return NextResponse.json(
        { ok: false, error: `mode must be "token" or "oauth", got ${JSON.stringify(body.mode)}` },
        { status: 400 },
      );
    }
    setAuthMode(body.mode);
    return NextResponse.json({ ok: true, auth: authMode() });
  } catch (err) {
    return sandboxError(err);
  }
}
