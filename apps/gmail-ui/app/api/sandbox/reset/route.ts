import { proxyToApi } from "@/lib/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reset button in the operator panel — proxied to the API control plane.
export async function POST(req: Request) {
  const body = await req.text().catch(() => "");
  return proxyToApi("/api/sandbox/reset", { method: "POST", body: body || "{}" });
}
