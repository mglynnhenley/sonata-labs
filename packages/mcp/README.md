# @sonata/mcp

Step one of Sonata: **connect your tools**. One stdio MCP server fronts all three
twins, so any external agent — Claude Code, OpenClaw, Cowork, anything that speaks
MCP — is inside the fake company after one paste.

```bash
npm run dev:gmail     # port 3101
npm run dev:slack     # port 3200
npm run dev:calendar  # port 3400

node_modules/.bin/sonata-mcp connect   # prints the config to paste
```

The agent is external and long-lived; Sonata never invokes it. The world runs on
its own compressed schedule whether or not the agent is looking, the agent notices
by polling `sonata_whats_new`, and every action it takes is audit-logged by the
twins for the judge to score afterwards.

## Tools

28 of them: `gmail_*` (12), `slack_*` (8), `calendar_*` (7), and `sonata_whats_new`.

The twin tools are not defined in this package. They are
`packages/engine/src/tools/` — the same names, descriptions and schemas the
benchmark scores — imported and prefixed. `tests/manifest.test.ts` fails if the two
lists ever diverge.

`sonata_whats_new` answers "what changed since I last looked" across all three
surfaces: new mail, new channel posts, events added/moved/cancelled. The first call
sets the baseline, later calls return only deltas. It is composed out of the same
twin tools, so it tells the agent nothing it could not have found itself — it just
makes finding it cheap enough to do on a loop.

## Configuration

| Variable | Default |
| --- | --- |
| `SONATA_TOKEN` | `sandbox-token` (`SANDBOX_TOKEN` is accepted too) |
| `SONATA_GMAIL_URL` | `http://localhost:3101` |
| `SONATA_SLACK_URL` | `http://localhost:3200` |
| `SONATA_CALENDAR_URL` | `http://localhost:3400` |

`sonata-mcp` serves all three; `sonata-mcp gmail` serves one, for episodes that
should only put a mailbox in front of the agent.

## No MCP?

The twins are the product; MCP is one door into them. `sonata-mcp connect` also
prints the raw base URLs and bearer token — every tool here is a thin call onto
those same routes.
