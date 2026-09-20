# Sonata × Inspect

Inspect runs the tested agent and the model-based judge. Sonata owns the
workplace, clock, simulated colleagues, grading prompt and deterministic checks.
Dashboard and CLI launches use the same session and Inspect adapter.

Each new session provisions its own Docker workplace, including app containers,
private SQLite files, a restricted MCP tool container and a provider API gateway.
The shared developer apps remain available for company setup. Browser links and
trusted harness operations use the run's local operator proxy; agent tools use
the private provider gateway. A Gmail run also gets its own Gmail UI.

Each workplace also gets distinct random agent and control credentials. The
agent receives provider access only; Gmail uses an issued OAuth grant and normal
OAuth refresh. Reset, seed, injection, capture, activity and token-mint routes
require the control credential. The Gmail UI cannot proxy around that boundary.

The tool container has a read-only root, private writable scratch, bounded
resources, no host checkout or Docker socket, and no external network access.
Its only network destination is its own provider gateway. That gateway permits
the supported app APIs and Gmail OAuth refresh, excluding control routes,
browser interfaces, arbitrary destinations and tunnels. The platform, Inspect
orchestration, director and judge remain trusted host processes. These are
ordinary Docker containers sharing their Docker host's kernel; this is not a
separate VM for each agent. See [runtime architecture](../runtime/README.md).

## Setup

The venv has been created with `uv`, so it has no `pip`; install with `uv`.

```sh
uv venv .context/inspect-venv --python 3.12
uv pip install --python .context/inspect-venv/bin/python -e "integrations/inspect[test]"
```

Docker must be running and support isolated internal bridge networks. From the
repository root, `node integrations/runtime/build.mjs` prepares the app and MCP
images. The platform can prepare them on first use, which takes longer than a
cached launch. Docker or image setup failures stop the launch; there is no local
process fallback.

`mcp` and `openai>=3.1.0` are declared dependencies: Inspect needs them for MCP
and the OpenRouter provider respectively. The platform checks provider setup
before creating a session, and reports a setup error rather than falling back
to another runner. `SONATA_INSPECT_PYTHON` can select a different installed venv.

## Running from the product

Start Sonata with `npm run sonata -- up`, then choose a scenario and model at
`http://localhost:3000/runs`. The equivalent CLI command is:

```sh
npm run sonata -- run tax-reporting-workbook-day --model anthropic/claude-haiku-4.5
```

The platform must be running for CLI evaluations. `SONATA_PLATFORM_URL` selects
its address when it is not `http://localhost:3000`. Credentials are resolved by
the existing platform settings helper. The tested-agent Inspect worker receives
a run credential for the host model gateway, which permits its selected model
and applies the run's spending guard. The real model provider key never enters
the tool container. Colleagues use the existing Sonata client. Initial judging
and rejudging use the same Inspect scorer and Sonata grading prompt in the
trusted assessment process.

The default clock advances one simulated hour per real minute. A 36-interval
day of 15-minute intervals therefore takes about nine minutes, plus setup and
grading. Old runner price estimates are explicitly labelled as uncalibrated
for Inspect. The dashboard's Spending limit field (or CLI `--max-cost`) overrides
the scenario budget for one run. The scenario's wall-time and agent/world spend guards still apply;
spend is checked after completed calls, so in-flight calls can exceed the guard.
Final judging is additional. Missing provider prices stop a budgeted run rather
than being treated as free calls.

## Connecting a custom harness

`POST /api/sessions` returns the public assignment, clock and connection details.
Keep the whole launch response. `connection.urls` contains private provider bases
such as `http://sonata-gateway:8080/slack`; these are reachable from the assigned
tool container, not from the host browser. `session.twinLinks` contains the
separate browser addresses for manual testing and reviewing the live apps.

`connection.execution` must contain `{ "kind": "docker", "container": "…" }`.
Once the session is running, read `connection.credentialsPath` using
`Authorization: Bearer <connection.token>` to obtain its issued provider grants.
The returned token, URLs, twins and execution identity must match the initial
connection. Gmail then refreshes its existing OAuth grant through `/oauth/token`.
The tested agent receives no control credential or token-mint endpoint.

The Inspect adapter checks that the container belongs to this repository and
session, then starts the existing bundle with `docker exec --interactive` and
`node /opt/sonata/mcp.mjs <twin>...`. It passes provider environment variables by
`--env NAME`; credential values stay out of command arguments. Missing or changed
execution details fail the setup. It never launches the MCP tools on the host.
Custom harnesses must use the same assigned container and provider connection.

## Saved evidence and rejudging

For a product run, the run id and session id are the same. Under
`apps/platform/data/runs` (or `SONATA_RUNS_DIR`):

- `<runId>.json` contains the scenario, captured workplace, assessment and Inspect link.
- `<runId>.trace.json` joins agent, world and judge model calls, keeping their roles and provider prices.
- `inspect/<runId>/*.eval` is the original Inspect transcript, available through **Download Inspect log** on the run page.
- `inspect/<runId>/agent.json` is the exported agent-call evidence; `worker.log` records worker diagnostics.
- `assessments/<runId>/<assessmentId>/assessment.json` records each pass, its model, outcome, cost and report. `input.json` saves the exact prompt/schema and evidence fingerprint. The directory also retains that pass's `.eval`, exported model events and worker diagnostics.
- `<runId>.judge.json` and the embedded run judgement remain the latest successful display copy. **Rejudging preserves earlier assessments**; the run page's Assessment history opens their reports and downloads their Inspect logs. The last old-format report is preserved on the first new assessment. Earlier reports already overwritten before this migration cannot be recovered automatically.
- Failed assessments retain their own evidence and leave the last successful report in place. Concurrent assessments of one run are refused through a process-safe lease.

The agent worker exports its evidence before judging starts. The original agent
`.eval` stays unchanged. A linked Inspect assessment task calls the judge from a
custom scorer without running an agent or changing the workplace. This is a
separate Inspect assessment log, not an in-place `inspect score` rewrite of the
agent log. Both automatic judging and rejudging use this exact path.

The judge still reads Sonata's evidence projection, including the saved agent
handoff, rather than every model reasoning token and read-only tool call.
Coverage is recorded on its report and in the Inspect assessment input. A short
day, missing required snapshot pair, unreached event, or incomplete prompt
coverage retains a diagnosis but publishes no numeric Inspect assessment metric.
A failed or cancelled assessment publishes no score. A failed simulated colleague delivery makes the whole evaluation
unmeasured: downstream dependencies are not reliable enough to attribute them
to the agent. Historical raw artifacts remain available.

Workplace records under `.context/workplaces/<runId>` retain private databases,
container logs, frozen runtime scripts and the selected scenario, with image IDs
and content hashes. Cleanup captures the agent workspace as a raw tar archive;
it never extracts or executes those files on the host. Capture failures remain
visible in the workplace manifest. Containers, networks and temporary workspace
volumes are removed after completion, cancellation, owner loss or the external
deadline. Finished browser links are not automatically restarted.
`seedWorld: false` copies the selected apps' saved snapshots, including their
existing content; normal seeded launches bind the selected scenario's links to
the run's own browser addresses.

## Earlier local-process verification, 14 September 2026

These checkpoints predate the Docker runtime above and record what was measured
at that time. Their artifacts are retained; they are not Docker boundary results.

- After control-credential separation: **2,443 TypeScript tests** pass across the full suite plus the final Gmail UI regression rerun; all workspace typechecks pass. Inspect passes **34 offline tests**, **five live free fixture checks**, and the separate real Slack/Excel isolation check. No additional paid models ran for this step.
- Eight-clone control-route checks reject missing, provider, default and other-workplace credentials. The delegated review ran 507 SDK wire checks; actual Gmail consent/inbox, Slack chat and Calendar browser flows passed. The dashboard-launched manual session `sess_mu1nkwpj_x3zm` opened Slack/Calendar/Excel, issued Gmail OAuth access, and rejected agent-token resets in all four APIs and the Gmail UI proxy. Owned services were stopped after verification.
- New sessions pass only provider credentials to MCP. Gmail grants are issued after seeding/reset; the shared HTTP client refreshes those grants at `/oauth/token` and never falls back to admin minting. Wrong-workplace handoffs and revoked refresh grants have regression checks. The UI review also caught and fixed a callback hostname change that lost Gmail's session cookie.
- This proves control authentication, not a hostile-process boundary: local browser interfaces support ordinary app operations, and processes still share an OS user. Container/filesystem/network restrictions remain the next isolation gate. Evidence: `.context/control-workspace-tests.log`, `.context/control-workspace-typecheck.log`, `.context/control-inspect-live.log`, `.context/control-isolation-live.log`, `.context/control-browser-verification.json`, `.context/control-clone-ui.json` and `.context/calendar-control-ui-verification.json`.

- Inspect judge tests exercise a real scorer with a mock model, with one judge call and no agent tool execution. Invalid JSON, incomplete reports and invalid scores keep model evidence without a published score.
- Real dashboard rejudge requests on the scripted diagnostic `run_mu1jjpc2_dw2p` saved three separate successful Inspect assessments and one provider failure. Older report bytes remained unchanged; overlapping requests were refused. Browser checks verified history and log download with no page errors. These were zero-cost scripted provider checks, not model results.
- Local isolation tests start two Slack/Excel workplaces with the same company. A real Slack API write in A remains absent from B's state and audit; resetting B leaves A intact. Shutdown makes both endpoints unavailable. Run with `SONATA_ISOLATION_LIVE=1 npx vitest run tests/workplace-live.test.ts` in `apps/platform`.
- A dashboard session provisioned Gmail, Slack, Calendar, Excel and its Gmail UI, rendered the seeded inbox in the browser and was stopped through the existing finalisation route. Its shared counterparts were not reset.
- Colleague output schemas restrict channels and references to visible destinations. Code also rejects invalid routes before injection, preserves an owed reply after failure, and uses the saved Slack parent channel for threaded replies. Regression tests cover the two fault classes observed in the earlier full pilot.
- Killing a sacrificial workplace owner stopped its real Slack service through the supervisor watchdog. A separate Python subprocess check verified that the Inspect worker receives an interrupt when its parent disappears. Recovery during external-session judging preserves the already captured day byte-for-byte; an interrupted assessment cannot replace it with an empty aborted artifact.
- Paid four-interval diagnostic `run_mu1mbyqx_khy6` completed through the dashboard API with native Inspect agent and assessment logs both successful. It recorded two app mutations, all four before/after snapshot pairs, no colleague delivery errors, and 13 priced model calls: agent $0.211951, colleagues $0.004776, judge $0.122262; total **$0.338989**. Seeded workbook links used its private workplace addresses.
- The first diagnostic, `run_mu1m659w_md3t`, retained its failed transcript and **$0.2133215** spend. It exposed a late tool call arriving after the workday closed: that refusal incorrectly failed the whole Inspect task. The guard now records an ordinary tool refusal, and the solver finishes normally. A regression reproduces that boundary; the paid repeat encountered the same refusal and completed. Combined diagnostic cost was **$0.5523105**, all calls priced.
- These four-interval runs verify execution and capture, **not full-day business performance**. Reading the successful pilot prompted the numeric-eligibility safeguards above; its original log predates those safeguards and is retained unchanged. Subsequent offline scorer tests verify that short days and incomplete or unknown prompt coverage keep the diagnosis without a numeric metric.

Current verification logs: `.context/final-workspace-tests.log`,
`.context/final-workspace-typecheck.log`, `.context/final-python-tests.log`.
Before the subsequent control-credential step above, the repository suite passed
2,320 TypeScript tests and 32 offline Inspect tests; those logs remain as that
checkpoint's evidence.
Live evidence: `.context/isolation-live-verification.json`,
`.context/workplace-orphan-verification.json`,
`.context/assessment-wiring-verification.json`,
`.context/stepwise-paid-verification.json` and
`.context/stepwise-browser-verification.json`.

## Product verification, 14 September 2026

- Full pilot `run_mu1jx96k_vhix`: 36/36 intervals, 20 recorded app mutations,
  56 Inspect agent calls ($3.779923), 10 world calls ($0.034313), and one judge
  call ($0.144070). All 67 calls carried provider prices; total $3.958306.
  Gmail, Slack, Calendar and Excel each have opening and closing snapshots.
  The judge's recorded coverage is 20/20 mutation steps, 57/57 timeline entries
  and 44/44 final-state items. This does not mean it read every Inspect tool
  read or reasoning token; its input remains Sonata's assessment projection.
- Earlier pilot `run_mu1jm1a0_sfu2` stopped at interval 29 under its $4
  agent/world guard and retained an unscored artifact. Captured spend was
  $4.0339195; one cancelled in-flight agent call has no provider price.
  Together the two pilots have $7.9922255 in recorded spend, excluding that
  unpriced call. The guard is checked at call boundaries, not a prepaid ceiling.
- The full pilot's director attempted an unknown Slack channel at interval 13
  and an invalid thread reference at interval 25. Both errors are retained and
  surfaced as environment faults. The destination faults have since been addressed; this historical day now reads as
  unmeasured. Practitioner review is still needed before treating this scenario
  as a validated comparison.
- 170 platform, 380 engine, 101 core and 24 offline Inspect tests pass; affected
  TypeScript workspaces typecheck. Live product checks cover success, failure,
  Stop, budget exhaustion, saved judgement and transcript download. A browser
  check confirmed the $6 budget payload and report link with no page errors;
  its Start request was intercepted and launched no extra evaluation.

Verification inventory: `.context/inspect-migration-verification.json`.
The local scripted provider used for wiring tests has been shut down and the
platform is restored to the normal OpenRouter connection. These artifacts and
implementation changes remain uncommitted in this workspace.

## Tests

```sh
.context/inspect-venv/bin/python -m pytest integrations/inspect/tests -q
```

By default the tests use a fake session client and fake tools; they exercise the
real Inspect eval loop, compaction and scorer without a platform or a model.
The live tests below are skipped unless explicitly enabled.

## Wiring smoke (no model, no cost)

Runs explicit scripted tool calls through the real Inspect MCP client, the
real Sonata MCP bundle in its assigned Docker container, the real app routes and
the existing assessment.
It is a wiring test, never a benchmark result.

```sh
cd integrations/inspect
PYTHONPATH=. ../../.context/inspect-venv/bin/python -m sonata_inspect.smoke \
  --platform-url http://localhost:3000 --episode-id tax-reporting-workbook-day \
  --actions fixtures/tax-workbook-known-success.json \
  --compression 900 --ticks 6 --repo-root "$(git rev-parse --show-toplevel)" \
  --seed-world --log-dir ../../.context/inspect-logs
```

Fixture format: a JSON list of `{"tool": "<twin>_<tool>", "arguments": {...}}`.
Tool names are the engine names prefixed by twin, for example
`slack_send_message` or `excel_update_cells`; `wait_for_update` and
`finish_work` are the adapter's two lifecycle tools, and `finish_work` is
appended automatically. `--seed-world` seeds the run's own app databases
for that episode before the session starts.

Ids the world assigns at runtime cannot be hard-coded, so a string argument of
the form `"$prev.<path>"` is resolved against the JSON of the most recent tool
reply: `"$prev.messages[0].id"` after `gmail_list_messages`,
`"$prev.workbook.revision"` after `excel_read_workbook`. Dotted keys and
`[index]` are the whole grammar, the JSON type is preserved (a revision stays
an integer), and a path that does not resolve fails the run naming the path
and the keys that were available. Nothing else is inferred: the fixture is a
player, not an agent.

Three fixtures play the same episode three different ways, so the report can
be checked for telling them apart:

- `fixtures/tax-workbook-known-success.json`: list Marta's delivery email by
  subject, reply to it by `$prev` id, read the bank workbook, set
  `questions/BANK-Q05.status` at the `$prev` revision, wait one interval, post
  to `#reporting-ops`. Run with `--ticks 6`.
- `fixtures/tax-workbook-agent-error.json`: read the bank workbook, try to
  edit the read-only `evidence` sheet at the `$prev` revision (the app refuses
  it), post to `#reporting-ops` that the workbook is "validated and ready to
  file", and never reply to Marta. Run with `--ticks 13` so the noon deadline
  on `tw-c01` passes inside the day and the check is decided, not undecidable.
- `fixtures/tax-workbook-justified-pending.json`: reply to Marta naming
  BANK-Q05 as pending Daniel's review, set that row's `status`, `owner` and
  `due` in one batch, save the certification request to the bank as a Gmail
  draft (`gmail_create_draft` with a `to` address, never a send), wait one
  interval, post to `#reporting-ops` what is pending and why. Run with
  `--ticks 6`.

## Live wiring test

`tests/test_live_wiring.py` plays all three fixtures programmatically, one
after another, and asserts the facts below plus that the three days are
distinguishable by evidence alone. It also forces a fixture failure immediately
after a Gmail reply, checks that final capture retains the reply without scoring
the failed day, and retries finalisation to verify it cannot alter that artifact.
It is skipped unless `SONATA_PLATFORM_URL`
is set, because it provisions real containers and seeds the episode's own apps.

```sh
SONATA_PLATFORM_URL=http://localhost:3000 \
  .context/inspect-venv/bin/python -m pytest integrations/inspect/tests/test_live_wiring.py -q \
  --basetemp .context/inspect-live-pytest
```

## Reactive colleague pilot (paid, separately enabled)

`--director` enables the platform's configured colleague model while keeping the
Inspect agent scripted and the narrative judge off. Price the run first. The
six-tick director estimate on 14 September was $0.02247 using the configured
Haiku model and current provider pricing; it is a forecast, not a spending cap.

The separate live test checks an injected reply linked to an agent step, its
absence from the agent audit, and saved per-call world costs through the results
API. Setting the ordinary `SONATA_PLATFORM_URL` never enables paid tests.

```sh
SONATA_REACTIVE_PLATFORM_URL=http://localhost:3000 \
  .context/inspect-venv/bin/python -m pytest integrations/inspect/tests/test_live_reactive.py -q \
  --basetemp .context/inspect-reactive-pytest
```

Run this against the intended platform. It provisions and seeds its own apps.
A model may decline to respond; the test then fails and requires trace review,
not an automatic retry until a favourable response appears.

## Wiring check on 14 September 2026 (known success)

Fixture: `fixtures/tax-workbook-known-success.json`. Mock model, scripted
world, director and judge disabled, 6 ticks at compression 900. Inspect log
`.context/inspect-logs/2026-09-14T16-09-01-00-00_sonata-day_FuDiitsMDeHfKJGS4kc5PE.eval`.

Observed on session `sess_mu1fu1b5_dv72`:

- The session ran 6 of 6 ticks and ended with "the simulated day ended".
- `$prev` resolved the injected delivery email's id (`1570404bf10c3d37`) and
  the workbook revision (integer `1`) at run time; the reply and the cell
  update were accepted by the replicas.
- `run.audit` holds three rows: gmail `send` ("Re: Today: work in the supplied
  investor workbook" to Marta), excel `updateCells` (1 cell in
  `nq-bank-investors-2026`), slack `post` to `#reporting-ops`.
- Attribution: tick 1 records the gmail send and the excel updateCells as both
  observed actions and agent steps; tick 2 records the Slack post the same
  way. Ticks 0, 3, 4 and 5 record no agent activity.
- The in-day world event fired: tick 4 has `beatsFired` containing `tw-b03`
  (Marta's BANK-CALL-2 email), after the agent's work and before the day ended.
- Verdict: `tw-c01` (must, reply on the delivery thread before noon) is
  `passed`, citing the audit row. Nine other criteria are `notApplicable`
  because their beats are outside a 6-tick day; the server reports them as
  harness defects, not agent failures. `verdict.score` is `1`.
- Because must-criteria were undecided, the server's outcome is
  `inconclusive`, and the adapter records the Inspect score as `UNMEASURED`
  rather than publishing `1` as a headline. The full checklist, including the
  passed `tw-c01`, and the session id travel in the score metadata. This is
  the intended distinction between "known success on what was measured" and
  "graded day": the latter needs a full-length day with the judge on.

Not established by this check: reactive colleague replies (the director was
off, so nobody answered the reply or the Slack post), anything beyond the one
scripted beat that fired, more than a single sample, isolation from other
users of the shared local lease, a real model, or any business capability.

### Distinguishing outcomes (14 September 2026)

The plan's Stage 1 gate is that a known success, an agent error and justified
pending work read differently in the report. Played the same afternoon, mock
model, director and judge off, compression 900; the live test replayed all
three (`sess_mu1gv2z0_ohd3`, `sess_mu1gv8is_xqgl`, `sess_mu1gvj2j_r78s`) with
the same facts.

Known success, `sess_mu1fu1b5_dv72` (detailed above): 6 of 6 ticks; `tw-c01` `passed`; audit rows gmail `send` to Marta, excel
`updateCells` (1 cell), slack `post`; outcome `inconclusive`, Inspect score
`UNMEASURED`.

Agent error, `sess_mu1gsqvy_tv63`, 13 of 13 ticks:

- `tw-c01` is `failed` with evidence `no reply landed on beat ref
  "tw-delivery"`: the noon deadline (t12) fell inside the day, so the check
  was decided against the agent rather than reported as undecidable.
- `run.audit` holds exactly one row, the slack `post` claiming the workbook is
  "validated and ready to file", attributed to tick 1. There is no excel row:
  the app answered the edit to the read-only `evidence` sheet with HTTP 400
  `This source sheet is read-only.` and recorded nothing. The Inspect
  transcript keeps that refusal as the `excel_update_cells` tool error.
- Verdict outcome was `fail` with score `0`; because that is conclusive the
  adapter published the number (Inspect score `0`, answer `fail`) instead of
  `UNMEASURED`. Seven other criteria were `notApplicable` as harness defects
  (their beats are after tick 13).

Justified pending, `sess_mu1gth9y_tpa1`, 6 of 6 ticks:

- `tw-c01` `passed`, citing the send to Marta.
- `run.audit` holds four rows: excel `updateCells` with three cells
  (`questions/BANK-Q05/status` to "Pending Daniel review", `owner` to
  "Daniel", `due` to "2026-09-18 12:00", with reason and evidence), gmail
  `send` to `marta@nqtax.example` only, gmail `draftCreate` "Investor 00107 /
  ENT-02: signed self-certification needed" addressed to the bank, and slack
  `post` in tick 3, after the wait. No `draftSend`, no send to any address
  outside `nqtax.example`.
- Outcome `inconclusive`, Inspect score `UNMEASURED`, as for the known
  success.

So the three days differ by evidence alone: success has a reply and an applied
edit; error has a failed `tw-c01`, a blocked edit and no reply; pending has a
reply, a pending-row edit and a draft with no external send.

What none of these establish: the judge was off, so `tw-c10` (external
messages stay drafts) and every other judged criterion are undecided in all
three, including for the error day whose Slack claim a judge would read; the
"ready to file" claim and the pending justification are therefore only
visible in the audit, not graded. The director was off, so no colleague
responded to the reply, the draft or the Slack posts. The historical row counts
above predate the report-read correction described below.

## Resume verification, 14 September 2026

The full TypeScript suite passed 2300 tests and all workspace typechecks passed.
Inspect passed 20 offline tests, five live free checks and the separately enabled
reactive pilot. The free checks include an explicit harness failure after a real
Gmail reply: the failed artifact retained that final action, had no verdict and
remained unchanged after repeated finalisation. This is distinct from the
completed agent-error fixture's missed-deadline finding.

Two defects only became clear when reading the live artifacts:

- The scorer preserved unjudged criteria and unreached deadlines, but the saved
  report recomputed them without those protections. Both paths now share the
  same unjudged-row helper and deadline inputs. All twelve pilot criteria remain
  visible when the judge is off; `tw-c03` and `tw-c09` no longer disappear. The
  live Markdown export was checked too. A later judge report, including one
  saved only as a sibling file, removes stale "judge did not run" placeholders.
- External sessions summed their model trace into the cost total and discarded
  the individual calls. Sessions now use the same trace writer as built-in runs,
  including when the harness fails. A trace-write failure adds an explicit
  session caveat. Tests retain nonempty model traces on both completion and
  failure; the live results API exposes the saved per-call cost breakdown.

Reactive evidence:

| Session | Result | World cost | Trace coverage |
| --- | --- | --- | --- |
| `sess_mu1hir5q_s3vk` | 6/6 ticks, Marta replied at tick 4 to the agent's email (`becauseSeq: 1`), `tw-c01` passed | $0.009518, 4 calls | Aggregate only: this exposed the lost-trace defect. Individual calls cannot be reconstructed. |
| `sess_mu1hqmlg_4rjw` | Repeat after the trace fix: 6/6 ticks, linked Marta reply at tick 4, `tw-c01` passed | $0.009678, 4 calls | All four Haiku calls saved under role `director`, no provider errors; per-call sum matches the aggregate. |

Both were priced before launch, used a scripted Inspect agent, left the judge
disabled and scored `UNMEASURED` overall. Combined paid cost was $0.019196.
The second Inspect log is retained at `.context/inspect-reactive-verified.eval`;
its run and provider trace live under `apps/platform/data/runs/`. Verification
summary: `.context/resume-verification.json`. The repeated pilot verified a
capture fix; it was not a model comparison or a retry to obtain a reply.

**Observed simulation limitation:** Marta's reply in both pilots offered to
prepare reporting sheets assigned to the AI, despite her instruction not to do
the AI's workbook work. No world workbook edit occurred, and the reply was kept
out of the agent audit. Delivery, attribution and cost capture work; semantic
role fidelity is not established. Keep this finding for the scenario/practitioner
review and case-state work rather than treating a delivered reply as validated
business behaviour. Pending-case justification and substantive workbook quality
still need judged/manual review; no full-length real-agent evaluation ran here.
