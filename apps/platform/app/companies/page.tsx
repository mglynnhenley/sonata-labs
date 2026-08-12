import { listCompanies } from "@/lib/engine/clone";
import { allTwinStatuses } from "@/lib/twins";
import { CompaniesClient } from "./_components/CompaniesClient";

// The product's opening move finally has an address: every fake company you have
// cloned, a button that puts one into Gmail, Slack and the calendar, and doors
// into the three apps so you can go and read what these people have been up to.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Companies",
  description: "The fake companies you've cloned, and the button that puts one into the clones.",
};

export default async function CompaniesPage() {
  // Rendered on the server so the list is right on first paint; the client
  // polls the same route afterwards, because clone health changes under it.
  const clones = await allTwinStatuses();
  return <CompaniesClient initial={{ companies: listCompanies(), clones, at: Date.now() }} />;
}
