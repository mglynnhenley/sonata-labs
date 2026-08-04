import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { badRequest } from "@/lib/gmail/errors";
import { b64urlDecode } from "@/lib/gmail/base64";
import { listDraftRows, countDrafts } from "@/lib/store/drafts";
import { getMessageRow, getLabelIds } from "@/lib/store/messages";
import { shapeMessage } from "@/lib/gmail/shape";
import { clampMaxResults, decodePageToken, encodePageToken } from "@/lib/gmail/pagination";
import { prepareSend, commitCreateDraft } from "@/lib/drafts-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, ({ db }) => {
    const sp = new URL(req.url).searchParams;
    const limit = clampMaxResults(sp.get("maxResults"));
    const { offset } = decodePageToken(sp.get("pageToken"));
    const total = countDrafts(db);
    const rows = listDraftRows(db, limit, offset);
    const drafts = rows.map((d) => {
      const row = getMessageRow(db, d.message_id);
      return {
        id: d.id,
        message: row ? shapeMessage(row, getLabelIds(db, d.message_id), "minimal") : undefined,
      };
    });
    const body: { drafts?: typeof drafts; nextPageToken?: string; resultSizeEstimate: number } = {
      drafts: drafts.length ? drafts : undefined,
      resultSizeEstimate: total,
    };
    if (offset + rows.length < total) body.nextPageToken = encodePageToken({ offset: offset + limit });
    return json(body);
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, async ({ db }) => {
    const body = (await req.json().catch(() => ({}))) as {
      message?: { raw?: string; threadId?: string };
      raw?: string;
    };
    const raw = body.message?.raw ?? body.raw;
    if (!raw) return badRequest("Missing draft 'message.raw'.");
    const prep = await prepareSend(b64urlDecode(raw));
    const endpoint = new URL(req.url).pathname;
    const draft = runMutation(
      db,
      () => commitCreateDraft(db, prep),
      (d) => ({
        method: "POST",
        endpoint,
        actionType: "draftCreate",
        targetType: "draft",
        targetId: d.id ?? undefined,
        request: { subject: prep.normalized.subject },
        responseCode: 200,
        summary: `Created draft “${prep.normalized.subject || "(no subject)"}”`,
      }),
    );
    return json(draft);
  });
}
