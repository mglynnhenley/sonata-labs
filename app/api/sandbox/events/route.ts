import { NextResponse } from "next/server";
import {
  addSubscription,
  listSubscriptions,
  removeSubscription,
  recentDeliveries,
  clearDeliveries,
} from "@/lib/events/bus";
import { SIGNING_SECRET } from "@/lib/events/signing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Event subscription management (sandbox machinery, not part of the Slack API
// surface — in real Slack this is app config, not an API).
//
//   GET                             → subscriptions, recent deliveries, secret
//   POST {url, events?}             → subscribe (runs url_verification first)
//   DELETE ?id=S123 | ?deliveries=1 → unsubscribe / clear the delivery log

export async function GET() {
  return NextResponse.json({
    subscriptions: listSubscriptions(),
    deliveries: recentDeliveries(),
    // Receivers need this to verify X-Slack-Signature.
    signing_secret: SIGNING_SECRET,
  });
}

export async function POST(req: Request) {
  let body: { url?: string; events?: string[] };
  try {
    body = (await req.json()) as { url?: string; events?: string[] };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.url) {
    return NextResponse.json({ ok: false, error: "url_required" }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(body.url);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_url" }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return NextResponse.json({ ok: false, error: "unsupported_protocol" }, { status: 400 });
  }

  const sub = await addSubscription(body.url, body.events ?? []);
  // A failed handshake is reported (not thrown) so the caller can see why.
  return NextResponse.json({ ok: sub.active, subscription: sub });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("deliveries") === "1") {
    clearDeliveries();
    return NextResponse.json({ ok: true, cleared: "deliveries" });
  }
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, error: "id_required" }, { status: 400 });
  return NextResponse.json({ ok: removeSubscription(id) });
}
