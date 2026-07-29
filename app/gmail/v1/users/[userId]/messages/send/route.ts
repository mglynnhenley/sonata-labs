import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { badRequest } from "@/lib/gmail/errors";
import { b64urlDecode } from "@/lib/gmail/base64";
import { prepareSend, commitSend } from "@/lib/send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, async ({ db }) => {
    const body = (await req.json().catch(() => ({}))) as { raw?: string; threadId?: string };
    if (!body.raw) return badRequest("Missing 'raw' RFC822 content.");

    // Async parse OUTSIDE the transaction; sync commit inside it.
    const prep = await prepareSend(b64urlDecode(body.raw));
    const endpoint = new URL(req.url).pathname;

    const result = runMutation(
      db,
      () => commitSend(db, prep, { threadId: body.threadId }),
      (r) => ({
        method: "POST",
        endpoint,
        actionType: "send",
        targetType: "message",
        targetId: r.messageId,
        request: { to: prep.normalized.to, subject: prep.normalized.subject },
        responseCode: 200,
        summary: `Sent “${prep.normalized.subject || "(no subject)"}” to ${prep.normalized.to || "(nobody)"}`,
      }),
    );
    return json(result.message);
  });
}
