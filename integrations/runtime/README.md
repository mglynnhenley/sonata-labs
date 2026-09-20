# Isolated workplace runtime

Every session uses its own Docker workplace. Docker must be running, with support
for internal bridge networks and `gateway_mode_ipv4=isolated` (verified locally
with Docker 29). Startup fails if this boundary cannot be created. The normal
host-process runner is no longer a fallback.

The platform, Inspect orchestration, director, model gateway and judge remain
trusted host processes. Only the tested agent's tool execution is moved into the
restricted MCP container. Docker containers share the Docker host or VM's kernel;
this does not create an independent VM for each agent.

## Build and checks

From the repository root, after `npm install`:

```sh
node integrations/runtime/build.mjs
node --test integrations/runtime/source.test.mjs
node --test integrations/runtime/gateway.test.mjs integrations/runtime/operator-proxy.test.mjs
node --test apps/platform/scripts/runtime-build-supervisor.test.mjs
node integrations/runtime/smoke.mjs
```

The builder creates `.context/runtime/images.json`, including immutable image IDs and
a source fingerprint. It reuses matching images; `--force` rebuilds. It sends Docker
an allowlisted temporary context, never the checkout, `.env`, clone databases, saved
worlds, or platform data. Linux native dependencies are installed in a build stage;
the host's `node_modules` is not copied. No host `.next` is built or changed.
The app context and MCP source bundle use the same captured bytes as the
fingerprint. If source files change during capture, the builder fails before
starting Docker so a concurrent edit cannot silently mislabel an image.
The product's shared image build has an independent 15-minute deadline and stops
its process group if its dashboard owner disappears. Cancelling one waiting run
returns immediately without cancelling a build still needed by another run.

## Network and credential boundary

| Component | Connections and purpose |
| --- | --- |
| Tool container | Joins only its run's internal agent network. DNS is disabled; a fixed hosts entry names the provider gateway. It has no published port. |
| Provider gateway | Joins that run's agent and app networks. It forwards an explicit list of supported provider routes to fixed app origins. |
| App containers | Join only the private app network. Each app mounts only its own database directory. |
| Operator proxy | Joins the app network and a separate operator network. Its ports are published on host `127.0.0.1` for browser and trusted harness use. It never joins the agent network. |

The provider gateway accepts URLs such as
`http://sonata-gateway:8080/slack/api/chat.postMessage`. It rejects app control,
activity, health, evaluation and browser routes; encoded traversal; HTTP CONNECT;
WebSocket upgrades; redirects; and arbitrary proxy destinations. Slack upload
URLs and LinkedIn pagination links are rewritten to supported gateway resources.
Gmail token access is limited to refreshing an existing grant. URLs supplied in
ordinary API bodies or queries remain data and cannot choose another upstream.

The operator proxy has a separate purpose: it forwards full app and browser
operations, including OAuth redirects and Next HMR, to one fixed app per listener.
It passes the caller's credentials and cookies without injecting a control
secret. Both proxies disable IP forwarding. The isolated agent network prevents
access to this operator proxy, the host, other runs and the public internet.

Agent and control credentials are different random values per run. After setup,
the session connection endpoint issues Gmail provider access to the trusted
harness. The tool container receives only its provider token, grants and private
API addresses. The host model gateway holds the real agent-model provider key;
Inspect receives a credential scoped to the selected model and run budget.

## Images and process restrictions

`sonata-apps:<source-hash>` contains the existing clones and their runtime dependencies.
Its entrypoint is `node /opt/sonata/runtime/apps-entrypoint.mjs <app>` and listens
on port 3000. Supported apps are Gmail, Slack, Calendar, Excel, Attio, Google Docs,
Google Ads, LinkedIn, and Gmail UI (using their directory names). The entrypoint
runs the app's existing `src/cli/db-init.ts` and Next server. Mount only that app's
private `data` directory at `/opt/sonata/apps/<app>/data`; `.next` and `/tmp` need
writable temporary mounts. The image runs as UID/GID 1000. App source is trusted
infrastructure; access to its administrative routes belongs behind the runtime's
authenticated control boundary.

`sonata-agent:<source-hash>` contains Node and one minified MCP bundle. It contains no
checkout, source maps, authored scenarios, reports, databases, grading prompts,
or provider credentials. The bundle uses the existing MCP tool implementation.
The builder audits contributing source files and refuses unexpected dependencies
such as the director, judge, or world generator. `bundle-inputs.json` records that
inventory. Its entrypoint is `node /opt/sonata/mcp.mjs <twin>...`; pass only the
surfaces assigned to the run. The launcher may keep a container alive with
`--entrypoint sleep ... infinity` and invoke MCP through `docker exec -i`.
Only `/workspace` and `/tmp` need writable temporary mounts, owned by UID/GID 1000.
The platform uses a private, size-limited memory-backed Docker volume for
`/workspace`, so it can retain the bytes during final capture without a host
directory mount.

Images supply the filesystem contents and non-root default. The platform runtime
is responsible for read-only roots, dropped capabilities, process/memory/CPU
limits, private networks, allowed HTTP routes, credentials, lifetime, and cleanup.
An image alone does not restrict network access. Neither image needs a Docker
socket or host checkout mount.

The platform sets a read-only root, UID/GID 1000, dropped capabilities,
`no-new-privileges`, bounded CPU/memory/process counts, bounded logs and temporary
storage. The MCP container has no hidden scenario, rubric, reports, operator
credentials or host filesystem mount. The existing tool bundle and its declared
dependencies are the only Sonata code in that image.

## Frozen inputs and lifecycle

`.context/workplaces/<runId>/workplace.json` records immutable app and agent image
IDs, the image source fingerprint, assigned containers/networks/volume names,
addresses and lifecycle state. Preparation copies the gateway, operator and
guardian scripts into that directory, records their hashes, and uses those
frozen copies for the run. It also retains `scenario.json` and its hash; the
agent cannot mount or read it. Opening snapshot hashes travel with the run
artifact. Subsequent source edits therefore do not change an already prepared
workplace's executable inputs.

A detached guardian owns cleanup independently of the dashboard's event loop.
Completion or cancellation triggers it; loss of the owner process or the external
wall-clock deadline triggers the same cleanup. It freezes the agent's workspace,
captures its bytes as `agent-workspace.tar`, saves bounded container logs, then
removes owned containers, networks and the temporary volume. The archive is raw
untrusted data: it is never extracted or executed on the host. Failed captures
retain partial evidence where available and record the failure in the manifest.
Private app database files and captured evidence remain for review. A finished
run's browser addresses no longer serve live apps.

This uses the existing clone seed/reset/capture functions: a reset still restores
the working SQLite file from its starting snapshot. There is no second simulation
or grading implementation inside Docker.

## Verification

The smoke command starts private containers for the four core apps and Gmail UI,
checks real health/control routes, initializes MCP over stdio, checks the tool
manifest, and probes read-only roots and writable scratch. It saves evidence in
`.context/stage2-images-verification.json` and removes its containers and network.
It makes no model calls and does not touch shared app databases.

`test-boundary.mjs` probes two live workplaces from inside the real tool
container. It checks own-provider access alongside denied host, other-run,
control-route and filesystem access. Invoke it with two `workplace.json` paths;
the first workplace must include seeded Slack. It saves summaries without
credentials or app contents and makes no model calls. The platform's workplace
tests and guardian tests separately cover setup, shutdown and evidence capture.

The Inspect adapter's Docker connection and credential handoff regressions run
with `.context/inspect-venv/bin/python -m pytest integrations/inspect/tests -q`.
Live fixtures are explicitly enabled and use the same session Docker runtime.
