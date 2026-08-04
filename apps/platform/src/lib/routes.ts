// Every internal destination in one place, so a link written on Home and the
// page that answers it cannot drift apart.

export const ROUTES = {
  home: "/",
  scenarios: "/scenarios",
  runs: "/runs",
  results: "/results",
  settings: "/settings",
  run: (id: string) => `/runs/${id}`,
  /**
   * The first-run button. `/runs` opens with the demo world and the stock
   * escalation scenario preselected and the day already starting — the spec's
   * five-minutes-to-magic path, and the one link that must never 404.
   */
  guidedDemo: "/runs?demo=1",
} as const;
