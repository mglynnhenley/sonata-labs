import { proxyToApi } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator activity feed — proxied to the API control plane.
export async function GET(req: Request) {
  const search = new URL(req.url).search;
  return proxyToApi("/api/activity", { method: "GET", search });
}
