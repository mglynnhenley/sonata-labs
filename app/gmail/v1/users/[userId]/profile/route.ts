import { handleGmail, json } from "@/lib/gmail/route-helpers";
import { currentHistoryId } from "@/lib/store/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, ({ db, userId: email }) => {
    const messagesTotal = (
      db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }
    ).n;
    const threadsTotal = (
      db.prepare("SELECT COUNT(DISTINCT thread_id) AS n FROM messages").get() as {
        n: number;
      }
    ).n;
    return json({
      emailAddress: email,
      messagesTotal,
      threadsTotal,
      historyId: String(currentHistoryId(db)),
    });
  });
}
