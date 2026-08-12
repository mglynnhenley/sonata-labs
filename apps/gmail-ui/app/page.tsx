import { redirect } from "next/navigation";
import { API_URL } from "@/lib/oauth-config";
import { getSession } from "@/lib/session";
import { GmailApp } from "./_components/GmailApp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The API's health says how /gmail/v1/* is gated; the UI follows rather than
 *  carrying its own copy of SANDBOX_AUTH. Unreachable or older API → "oauth",
 *  the conservative read: worst case is a consent screen, never a broken inbox. */
async function apiAuthMode(): Promise<"token" | "oauth"> {
  try {
    const res = await fetch(`${API_URL}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    const body = (await res.json()) as { auth?: string };
    return body.auth === "token" ? "token" : "oauth";
  } catch {
    return "oauth";
  }
}

// Cold start: in token mode the inbox just renders — the BFF falls back to the
// static token. In oauth mode a missing session goes through the real OAuth flow
// against the API. An existing session works in either mode.
//
// The destination rides along as `next`, so a deep link (/?thread=<id>) survives
// the sign-in round trip instead of dumping you on the inbox after consent.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session && (await apiAuthMode()) === "oauth") {
    const sp = await searchParams;
    const thread = Array.isArray(sp.thread) ? sp.thread[0] : sp.thread;
    const next = thread ? `/?thread=${encodeURIComponent(thread)}` : "/";
    redirect(`/oauth/login?next=${encodeURIComponent(next)}`);
  }
  return <GmailApp />;
}
