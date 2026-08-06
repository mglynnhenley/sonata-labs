import { proxyToApi } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Eval-run trace/judge feeds for the operator Trace panel — proxied to the API
// control plane. Catch-all so /api/eval/runs, /runs/:id/trace, /runs/:id/judge
// all forward unchanged.
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const search = new URL(req.url).search;
  return proxyToApi(`/api/eval/${path.map(encodeURIComponent).join("/")}`, { method: "GET", search });
}
