import { canonicalize, type GeneratedWorld } from "../generate";
import agencyLaunchWeek from "./agency-launch-week.json";
import fintechPreAudit from "./fintech-pre-audit.json";
import saasSupportWeek from "./saas-support-week.json";
import smallConsultancy from "./small-consultancy.json";

// Four worlds a user can clone without spending a model call or thirty seconds
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
  template(fintechPreAudit, "Fintech, the week before an audit"),
  template(agencyLaunchWeek, "Agency, launch week"),
  template(saasSupportWeek, "B2B SaaS, a bad support week"),
  template(smallConsultancy, "Consultancy, three clients at once"),
];

export function templateById(id: string): WorldTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
