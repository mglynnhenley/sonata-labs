# @sonata/mcp

The connector: one stdio MCP server that fronts all three [Sonata
Labs](../../README.md) twins, so any external agent — Claude Code, OpenClaw,
Cowork, anything that speaks MCP — is inside the fake company after one paste.

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

## `SONATA_TOKEN` is an admin token, not a Gmail credential

Gmail sits behind a real OAuth2 authorization server (see
[apps/gmail](../../apps/gmail/README.md)), so on that twin the token opens
`/api/sandbox/*` and nothing else — presenting it to `/gmail/v1/*` earns a 401.
`manifest.ts` therefore builds the Gmail client with `TwinHttp`'s `oauth` flag:
it mints a provider access token through the admin-gated
`POST /api/sandbox/token` on first use and re-mints on a 401 (expiry, or a reset
that wiped the token table). Slack and Calendar take the static token directly.

That is the same mechanism the episode engine uses — one implementation, so an
agent connected over MCP and an agent driven by the engine authenticate
identically, and a Gmail auth change cannot pass the benchmark while breaking
the connector.

## No MCP?

The twins are the product; MCP is one door into them. `sonata-mcp connect` also
prints the raw base URLs and bearer token — every tool here is a thin call onto
those same routes.

The printed `curl` works as-is against Slack and Calendar. For Gmail, mint a
token first:

```bash
TOKEN=$(curl -s -X POST localhost:3101/api/sandbox/token \
  -H 'authorization: Bearer sandbox-token' -H 'content-type: application/json' \
  -d '{}' | jq -r .access_token)

curl -s -H "authorization: Bearer $TOKEN" \
  "localhost:3101/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=10"
```
