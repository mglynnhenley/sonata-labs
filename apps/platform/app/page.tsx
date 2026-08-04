import { getOverview } from "@/lib/overview";
import { HomeClient } from "./_components/HomeClient";

// Rendered on the server so the first paint already has the real numbers; the
// client takes over polling from there.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  return <HomeClient initial={await getOverview()} />;
}
