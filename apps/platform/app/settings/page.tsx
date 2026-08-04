import { getSettingsView } from "@/lib/settings";
import { allTwinStatuses } from "@/lib/twins";
import { SettingsForm } from "../_components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [settings, twins] = await Promise.all([
    Promise.resolve(getSettingsView()),
    allTwinStatuses(),
  ]);
  return <SettingsForm initialSettings={settings} initialTwins={twins} />;
}
