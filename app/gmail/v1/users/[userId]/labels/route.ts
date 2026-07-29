import { handleGmail, json, runMutation } from "@/lib/gmail/route-helpers";
import { listLabelRows, shapeLabel, createLabel } from "@/lib/store/labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, ({ db }) => {
    // labels.list omits counts (get includes them).
    const labels = listLabelRows(db).map(shapeLabel);
    return json({ labels });
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  return handleGmail(req, userId, async ({ db }) => {
    const body = (await req.json().catch(() => ({}))) as {
      name?: string;
      messageListVisibility?: string;
      labelListVisibility?: string;
      color?: unknown;
    };
    const endpoint = new URL(req.url).pathname;
    const row = runMutation(
      db,
      () =>
        createLabel(db, {
          name: body.name ?? "",
          messageListVisibility: body.messageListVisibility,
          labelListVisibility: body.labelListVisibility,
          color: body.color,
        }),
      (r) => ({
        method: "POST",
        endpoint,
        actionType: "labelCreate",
        targetType: "label",
        targetId: r.id,
        request: { name: body.name },
        responseCode: 200,
        summary: `Created label “${r.name}” (${r.id})`,
      }),
    );
    return json(shapeLabel(row));
  });
}
