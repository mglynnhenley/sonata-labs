import { NextResponse } from "next/server";
import { railLabels, profileEmail } from "@/lib/gmail-views";
import { bffError } from "@/lib/route-util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [labels, email] = await Promise.all([railLabels(), profileEmail()]);
    return NextResponse.json({ labels, email });
  } catch (err) {
    return bffError(err);
  }
}
