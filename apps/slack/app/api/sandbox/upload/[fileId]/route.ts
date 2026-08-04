import { NextResponse } from "next/server";
import { acceptUploadBytes } from "@/lib/slack/methods/files-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Byte sink for files.getUploadURLExternal — the SDK's filesUploadV2 POSTs the
// raw file here between getUploadURL and completeUpload.
export async function POST(req: Request, ctx: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await ctx.params;
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  let data: Buffer;
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = [...form.values()].find((v) => typeof v === "object");
    if (!file) return NextResponse.json({ ok: false, error: "no_file_data" }, { status: 400 });
    data = Buffer.from(await (file as Blob).arrayBuffer());
  } else {
    data = Buffer.from(await req.arrayBuffer());
  }
  if (!acceptUploadBytes(fileId, data)) {
    return NextResponse.json({ ok: false, error: "upload_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
