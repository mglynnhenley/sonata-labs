// Every internal destination in one place, so a link written on Home and the
// page that answers it cannot drift apart.

export const ROUTES = {
  home: "/",
  companies: "/companies",
  scenarios: "/scenarios",
  runs: "/runs",
  /** Bring-your-own-agent days. Once orphaned — no nav entry, no route here —
   *  which made the product's headline flow reachable only by typed URL.
   *  Never again: if it is a page, it is in this table and in the nav. */
  sessions: "/sessions",
  /** Where an external agent gets pointed at the clones. Same story. */
  connect: "/connect",
  compare: "/compare",
  settings: "/settings",
  /** The only run URL. Live and finished are states of one page, not two addresses. */
  run: (id: string) => `/runs/${id}`,
} as const;
