// @sonata/world — one description in ("a 12-person fintech, the week before an
// audit"), one coherent fake company out: the same cast, with the same
// identities, appearing in Gmail, Slack, the calendar, the CRM and the shared
// documents.
//
// Four things live here and nothing else: what the model is allowed to write
// (schema), what makes a success criterion checkable at all (criteria), how a
// world is grown and assembled (generate), and how it is loaded into the running
// twins over HTTP (inject) — plus a pure summariser for the dashboard's preview
// step and four ready-made worlds so the first run costs nothing.

export * from "./criteria";
export * from "./schema";
export * from "./generate";
export * from "./inject";
export * from "./preview";
export * from "./llm";
export { TEMPLATES, templateById, type WorldTemplate } from "./templates/index";
