import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { GmailApp } from "./_components/GmailApp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cold start: no session cookie → send the browser through the real OAuth flow
// against the API. Once a session exists, render the inbox. This is the only
// gate; the BFF routes assume a session and refresh transparently.
//
// The destination rides along as `next`, so a deep link (/?thread=<id>) survives
// the sign-in round trip instead of dumping you on the inbox after consent.
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) {
    const sp = await searchParams;
    const thread = Array.isArray(sp.thread) ? sp.thread[0] : sp.thread;
    const next = thread ? `/?thread=${encodeURIComponent(thread)}` : "/";
    redirect(`/oauth/login?next=${encodeURIComponent(next)}`);
  }
  return <GmailApp />;
}
