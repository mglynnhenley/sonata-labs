import { templateSummaries } from "../../api/_lib/templates";
import { NewScenarioComposer } from "../_components/NewScenarioComposer";

export const metadata = {
  title: "New scenario",
  description: "Describe a business in plain language and watch it become an inbox, channels and a calendar.",
};

// The shipped days travel with the page rather than being fetched on failure:
// the moment they are needed is the moment a generation has just failed, and a
// second request that could fail the same way is not the thing to offer then.
export default function NewScenarioPage() {
  return <NewScenarioComposer templates={templateSummaries()} />;
}
