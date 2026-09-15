# Stage 2 isolation verification

Scope: local evaluations using Sonata's fixed Inspect harness. The tested model's
app tools execute in the run's restricted MCP container. Inspect's solver and model
transport, the world engine, and the judge are trusted host processes. Launching an
unrelated command on the host does not place it inside this boundary. Hosted access
and arbitrary third-party harnesses remain later work.

## Implemented boundary

Each run has private app containers and SQLite files, a provider gateway, a restricted
MCP container, and a loopback operator proxy for its app windows. Three networks
separate app control, agent APIs, and human inspection. The agent has no host path,
repository, Docker socket, provider key, or evaluator material. Its sole writable
workspace volume is an owned, size-limited tmpfs volume. Ordinary app credentials do
not open control routes; the provider gateway also refuses those routes independently.

The launcher pins immutable image IDs, copies and hashes gateway/guardian scripts,
freezes the scenario and seed, and records starting snapshot hashes. The model gateway
holds the provider credential, allows the selected model, limits output and concurrent
requests, and stops further requests when captured spend reaches the declared limit
or a price is missing. Actual charges settle after a request: an in-flight completion
can exceed the limit. World calls already in flight can also settle after cancellation.
Final judging has its separate budget, as described in the product.

A trusted guardian enforces lifetime and resource cleanup outside the agent. Before
removing the containers it freezes the agent, captures its workspace as bounded raw
tar, and preserves stdout/stderr logs. The archive is never extracted or executed on
the host. Failed capture is an evaluation fault, with an incomplete report and no
completed score. App windows close on teardown; retained reports, transcripts,
databases, logs and archives remain under the run's recorded paths.

## Live acceptance checks

The checks use real Docker containers and app routes. Scripted provider responses
exercise transport and stopping behavior without paid model calls.

| Check | Evidence |
| --- | --- |
| Two workplaces: mutations, reset and audits remain separate; saved snapshots unchanged | `.context/stage2-data-verification.json`, `apps/platform/tests/workplace-live.test.ts` |
| Agent can use its provider API; cannot access control routes, the other run, host paths, hidden criteria, arbitrary outbound network or host services | 69 actual-container checks in `.context/stage2-boundary-verification.json` |
| Normal product launch runs Inspect, mutates Slack and retains a native transcript | `.context/stage2-product-verification.json`, success run `run_mu1op6gm_difh` |
| Provider failure, user stop and spend limit retain partial evidence and clean up | Same product verification file; three separate runs |
| Successful work, agent error, justified pending work, attribution and final capture through Inspect/MCP | Five passing live tests in `.context/stage2-inspect-live.log` |
| Workspace archive preserves actual notes and symlinks as data; oversized capture is bounded | `apps/platform/scripts/workplace-guardian.check.mjs` |
| Owner death and independent deadline preserve notes and remove all owned resources | `.context/stage2-lifecycle-verification.json`, `.context/stage2-no-restart-verification.json` |
| Gmail/Calendar and Slack/Excel browser sign-in, rendering, edits and reload work without asset failures | `.context/stage2-gmail-calendar-browser-verification.json`, `.context/stage2-slack-excel-browser-verification.json` |
| Gmail and Attio retain real OAuth/SDK compatibility with split credentials | `.context/stage2-gmail-sdk-smoke.log`, `.context/stage2-attio-sdk-smoke.log` |

Final regression checks passed: 2,471 workspace tests (including the final platform rerun), all workspace typechecks,
56 offline Inspect tests, 26 runtime checks (including real Docker capture), five
live Inspect fixtures, and the concurrent-workplace integration test. All test
workplaces were removed; no paid provider calls were made.

The verification exposed and fixed empty tmpfs archive export, browser public-origin
handling, and Gmail's app-container memory requirement. The checks establish the local
execution contract. They do not establish tax-domain validity, grading quality,
latency-independent comparisons, or the isolation requirements of a hosted service.

Reproduction commands and runtime requirements are in the
[runtime guide](../integrations/runtime/README.md) and
[Inspect guide](../integrations/inspect/README.md).
