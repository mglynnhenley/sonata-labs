import { handleSlack } from "@/lib/slack/route-helpers";
import { err } from "@/lib/slack/envelope";
import { METHODS } from "@/lib/slack/methods";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Slack-compatible Web API: /api/<method> (e.g. /api/chat.postMessage).
// Slack accepts both POST (canonical) and GET for most methods; errors are
// HTTP 200 with {ok:false} — see envelope.ts.

async function dispatch(req: Request, params: Promise<{ method: string }>) {
  const { method } = await params;
  const handler = METHODS[method];
  if (!handler) return err("unknown_method", { req_method: method });
  return handleSlack(req, method, handler);
}

export async function POST(req: Request, ctx: { params: Promise<{ method: string }> }) {
  return dispatch(req, ctx.params);
}

export async function GET(req: Request, ctx: { params: Promise<{ method: string }> }) {
  return dispatch(req, ctx.params);
}
