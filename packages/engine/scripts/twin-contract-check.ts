// Does the harness still reach a running twin?
//
//   npm run dev:gmail:api                 # in one shell
//   npm run check:twin                    # in another
//   PORT=3131 npm run check:twin          # or against a twin on another port
//
// Every serious defect in this repo passed the type checker. This one drives the
// engine's actual TwinAdapter contract against a live server, because that is the
// only thing that can catch the class of bug that has already happened twice:
// Gmail moved behind OAuth2 and the episode engine was updated for it while the
// MCP connector was not, so twelve tools answered 401 with 1117 tests green.
//
// The specific property under test: the control plane (/api/health, /api/sandbox/*,
// /api/activity) takes the static admin token, the provider API (/gmail/v1/*) takes
// an OAuth access token minted through the admin-gated bridge, and the two never
// substitute for each other.

import { createGmailAdapter } from "../src/adapters/gmail";
import type { InjectContext, WorldSeed } from "@sonata/core";

const PORT = process.env.PORT || "3101";
const BASE_URL = process.env.TWIN_URL || `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log("      detail:", JSON.stringify(detail)?.slice(0, 300));
  }
}

/** A cast of two: the mailbox owner and someone to mail them. */
function person(id: string, name: string, email: string, relationship: string) {
  return {
    id,
    name,
    email,
    slackUserId: `U_${id.toUpperCase()}`,
    role: "Staff",
    relationship,
    style: "plain",
    timezone: "UTC",
  };
}

const world = {
  business: { name: "Contract Check", industry: "software", size: 2 },
  cast: [
    person("owner", "Sandbox User", "sandbox.user@gmail.com", "self"),
    person("boss", "Priya Nair", "priya@acme.co", "manager"),
  ],
  channels: [],
  mailboxOwner: "owner",
} as unknown as WorldSeed;

async function main(): Promise<void> {
  console.log(`\n\x1b[1mTwin contract — ${BASE_URL}\x1b[0m`);
  const gmail = createGmailAdapter({ baseUrl: BASE_URL });

  const health = await gmail.health();
  check("health answers on the control plane", health.ok, health);
  if (!health.ok) {
    console.log("\n  The twin is not up. Start it with `npm run dev:gmail:api`.");
    process.exit(1);
  }

  // Reads over /gmail/v1/*, which means TwinHttp had to mint a provider token
  // through POST /api/sandbox/token first. A 401 here is the regression.
  const before = await gmail.snapshot();
  const threadsBefore = (before as { threads?: unknown[] }).threads?.length ?? 0;
  check("snapshot reads the provider API with a minted token", threadsBefore > 0, {
    threads: threadsBefore,
  });

  const ctx: InjectContext = {
    atISO: new Date().toISOString(),
    resolve: () => undefined,
    world,
  };
  const ref = await gmail.inject(
    {
      twin: "gmail",
      kind: "email",
      payload: {
        from: "boss",
        to: ["owner"],
        subject: "Twin contract check",
        body: "Written by the engine adapter, over HTTP, exactly as a beat would be.",
      },
    },
    ctx,
  );
  check("a scripted beat injects", !!ref?.id, ref);

  const after = await gmail.snapshot();
  const threadsAfter = (after as { threads?: unknown[] }).threads?.length ?? 0;
  check("the beat shows up in the next snapshot", threadsAfter > threadsBefore, {
    before: threadsBefore,
    after: threadsAfter,
  });

  const audit = await gmail.auditSince(0);
  check("the twin's audit reads back", Array.isArray(audit), { rows: audit.length });

  const rendered = gmail.renderDiff(gmail.diff(before, after));
  check("diff renders the change for the judge", rendered.length > 0, rendered.slice(0, 120));

  // The credential contract, asserted per mode rather than assumed. The twin
  // reports SANDBOX_AUTH on /api/health: `oauth` means the admin token must be
  // refused by /gmail/v1/*; `token` (the default) means it must work there.
  const healthBody = (await fetch(`${BASE_URL}/api/health`).then((r) => r.json())) as {
    auth?: string;
  };
  const mode = healthBody.auth === "oauth" ? "oauth" : "token";
  const asAdmin = await fetch(`${BASE_URL}/gmail/v1/users/me/profile`, {
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  if (mode === "oauth") {
    check("the admin token is refused by the provider API (oauth mode)", asAdmin.status === 401, {
      got: asAdmin.status,
    });
  } else {
    check("the admin token reads the provider API (token mode)", asAdmin.status === 200, {
      got: asAdmin.status,
    });
  }

  const noAuth = await fetch(`${BASE_URL}/api/sandbox/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  check("the mint bridge is refused without the admin token", noAuth.status === 401, {
    got: noAuth.status,
  });

  console.log(`\n\x1b[1mResult:\x1b[0m ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Contract check crashed:", err);
  process.exit(2);
});
