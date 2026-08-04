import { NextResponse } from "next/server";
import { getSettingsView, updateSettings, type SettingsPatch } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Never returns the API key itself — only its source and a mask. */
export function GET() {
  try {
    return NextResponse.json(getSettingsView());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** Partial update: the settings page saves one field as it changes. */
export async function PATCH(request: Request) {
  let patch: SettingsPatch;
  try {
    patch = (await request.json()) as SettingsPatch;
  } catch {
    return NextResponse.json({ error: "expected a JSON body" }, { status: 400 });
  }

  try {
    return NextResponse.json(updateSettings(patch));
  } catch (err) {
    // Validation errors are the user's to fix, so they say what was wrong.
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
