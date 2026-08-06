import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { GmailApp } from "./_components/GmailApp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cold start: no session cookie → send the browser through the real OAuth flow
// against the API. Once a session exists, render the inbox. This is the only
// gate; the BFF routes assume a session and refresh transparently.
export default async function Home() {
  const session = await getSession();
  if (!session) redirect("/oauth/login");
  return <GmailApp />;
}
