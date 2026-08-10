// The wire shape of a pre-flight price. Types and nothing else, with no imports
// at all, so the run panel (a client component) and `/api/runs/estimate` (which
// reaches into @sonata/benchmark) can share one contract without the browser
// bundle ever touching the estimator.
//
// The labels are formatted SERVER-side and sent down as strings. The alternative
// — shipping the numbers and formatting them in the panel — is a second copy of
// `formatUsd`/`formatDuration`, and two copies is how the CLI's dry-run and this
// page start rounding the same day to two different prices.

export interface RunEstimate {
  /** Length this was priced for. */
  ticks: number;
  /** The agent model it was priced for. */
  model: string;
  usd: number;
  /** "$0.18" / "$0.0412" — already rounded for display. */
  usdLabel: string;
  seconds: number;
  /** "2m 12s" / "1h 04m". */
  durationLabel: string;
  /** Model calls across agent, director and judge. */
  calls: number;
  /**
   * Whether the agent's prompts were priced as cached.
   *
   * Every run Sonata has actually measured is on an Anthropic model, where the
   * engine sets cache breakpoints and the agent re-reads its own day at a tenth
   * of list price. Elsewhere the estimator assumes no caching, which makes the
   * figure a CEILING rather than a fit — and the panel has to say which of the
   * two it is showing, or a $0.22 quote reads as measured when it is a guess.
   */
  cachePriced: boolean;
  /**
   * Models in this run with no price on file. Non-empty means `usd` is missing
   * their spend entirely — the panel must not present it as the whole bill.
   */
  unpriced: string[];
}

export interface RunEstimateResponse {
  estimates: RunEstimate[];
  /** Director and judge, which the run panel does not choose — from Settings. */
  harness: { director: string; judge: string };
}
