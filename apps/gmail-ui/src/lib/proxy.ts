import { NextResponse } from "next/server";
import { API_URL, ADMIN_TOKEN } from "./oauth-config";

// Same-origin proxy for the API's CONTROL-PLANE routes (activity feed, eval runs,
// reset) that the operator panels in the UI use. These are not part of the OAuth
// provider API — they are admin-gated — so the proxy attaches the static admin
// token server-side. Keeping this same-origin is what lets the API stay
// CORS-free, matching real providers (whose APIs are called server-side).

export async function proxyToApi(
  path: string,
  init: { method: string; body?: BodyInit | null; search?: string } = { method: "GET" },
): Promise<NextResponse> {
  const url = `${API_URL}${path}${init.search ?? ""}`;
  const res = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "X-Sandbox-Token": ADMIN_TOKEN,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ?? undefined,
  });
  const text = await res.text();
  return new NextResponse(text || null, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
  });
}
