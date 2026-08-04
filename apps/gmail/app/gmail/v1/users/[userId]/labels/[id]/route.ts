import { handleGmail, json, runMutation, noContent } from "@/lib/gmail/route-helpers";
import { notFound } from "@/lib/gmail/errors";
import {
  getLabelRow,
  shapeLabel,
  shapeLabelWithCounts,
  updateLabel,
  deleteLabel,
} from "@/lib/store/labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, ({ db }) => {
    const row = getLabelRow(db, id);
    if (!row) return notFound();
    // labels.get includes live-computed counts.
    return json(shapeLabelWithCounts(db, row));
  });
}

async function patchOrPut(
  req: Request,
  params: Promise<{ userId: string; id: string }>,
) {
  const { userId, id } = await params;
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
      () => updateLabel(db, id, body),
      (r) => ({
        method: req.method,
        endpoint,
        actionType: "labelUpdate",
        targetType: "label",
        targetId: r.id,
        request: body,
        responseCode: 200,
        summary: `Updated label “${r.name}” (${r.id})`,
      }),
    );
    return json(shapeLabel(row));
  });
}

// Gmail supports both PATCH (partial) and PUT (full) label updates.
export const PATCH = (
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) => patchOrPut(req, params);
export const PUT = (
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) => patchOrPut(req, params);

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ userId: string; id: string }> },
) {
  const { userId, id } = await params;
  return handleGmail(req, userId, ({ db }) => {
    const endpoint = new URL(req.url).pathname;
    runMutation(
      db,
      () => deleteLabel(db, id),
      () => ({
        method: "DELETE",
        endpoint,
        actionType: "labelDelete",
        targetType: "label",
        targetId: id,
        responseCode: 204,
        summary: `Deleted label ${id}`,
      }),
    );
    return noContent();
  });
}
