import { canonicalize, type GeneratedWorld } from "../generate";
import agencyLaunchWeek from "./agency-launch-week.json";
import fintechPreAudit from "./fintech-pre-audit.json";
import meridianClinicalSupply from "./meridian-clinical-supply.json";
import saasSupportWeek from "./saas-support-week.json";
import smallConsultancy from "./small-consultancy.json";
import alderbridgeVentures from "./alderbridge-ventures.json";
import alderbridgeAiAssistant from "./alderbridge-ai-assistant.json";
import taxReportingWorkbook from "./tax-reporting-workbook.json";
import taxReportingWorkflow from "./tax-reporting-workflow.json";
import alderbridgeBusyDay from "./alderbridge-busy-day.json";

// Worlds a user can clone without spending a model call or thirty seconds
// waiting. They are the same shape a generated world is, so the preview, the
// injector and the episode engine cannot tell them apart — which also makes them
// the fixtures every test in this package runs against.
//
// Each one is deliberately unfinished business: something is late, someone is
// wrong, and two things want the same hour. A tidy company is not testable.

/** A template is a generated world plus the card copy the picker shows. */
export interface WorldTemplate extends GeneratedWorld {
  /** Card title, e.g. "Fintech, the week before an audit". */
  label: string;
}

// Through `canonicalize` on the way out: the JSON is written by hand, so the
// ordering, membership and channel ids it ships with are whatever the author
// typed. Normalizing here means a template and a freshly generated world are the
// same object in the same shape, and an edit to the JSON is repaired rather than
// quietly wrong. `templates.test.ts` guards the other half — that nothing is
// silently dropped on the way through.
function template(world: GeneratedWorld, label: string): WorldTemplate {
  return { ...canonicalize(world), label };
}

export const TEMPLATES: WorldTemplate[] = [
  template(taxReportingWorkbook as GeneratedWorld, "Tax reporting — adviser workflow in Excel"),
  template(taxReportingWorkflow, "Tax reporting — population reconciliation workflow pilot"),
  template(fintechPreAudit, "Fintech, the week before an audit"),
  template(agencyLaunchWeek, "Agency, launch week"),
  template(saasSupportWeek, "B2B SaaS, a bad support week"),
  template(smallConsultancy, "Consultancy, three clients at once"),
  template(meridianClinicalSupply, "Clinical supply, the morning after a cold-chain excursion"),
  template(alderbridgeVentures, "VC investment team — synthetic pilot"),
  template(alderbridgeAiAssistant, "VC AI assistant — human calls to investment memos"),
  template(alderbridgeBusyDay, "VC busy day — meetings, relationships and Attio"),
];

export function templateById(id: string): WorldTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
