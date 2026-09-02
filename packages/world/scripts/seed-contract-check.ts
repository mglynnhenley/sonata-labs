// Does every wire seed this package builds still satisfy the twin that receives it?
//
//   npm run check:seed
//
// No server, no database, no ports: each twin's `parseSeedRequest` is a pure
// function over the exact body `buildSeedRequest` posts, so the whole contract
// can be checked offline, for every shipped template, in under a second.
//
// This exists because the seed contract is the one boundary in the repo that the
// type checker cannot see across. A twin is deliberately NOT typed against
// @sonata/core — it has to build and be tested with no orchestrator installed —
// so both halves are written to a shape that is described in prose at the top of
// packages/world/src/inject.ts and enforced nowhere. A field renamed on one side
// is green on both, and the failure arrives as a 400 in the middle of seeding a
// run somebody is waiting for.
//
// It is a script rather than a vitest case for one reason: it imports two Next
// applications' source, and @sonata/world must keep depending on nothing but
// @sonata/core.

import { buildSeedRequest } from "../src/inject";
import { TEMPLATES } from "../src/templates/index";
import { parseSeedRequest as parseAttio } from "../../../apps/attio/src/lib/sandbox/parse";
import { parseSeedRequest as parseDocs } from "../../../apps/google-docs/src/lib/sandbox/parse";

/** Fixed, so a failure is reproducible rather than a thing that happened once. */
const NOW = Date.UTC(2026, 7, 14, 13, 0, 0);

const PARSERS = {
  attio: parseAttio,
  "google-docs": parseDocs,
} as const;

let passed = 0;
let failed = 0;

for (const template of TEMPLATES) {
  console.log(`\n${template.label} (${template.id})`);
  for (const [twin, parse] of Object.entries(PARSERS)) {
    const request = buildSeedRequest(template, twin as keyof typeof PARSERS, NOW);
    try {
      // Through JSON, because that is what the twin actually receives: a shape
      // that only holds together in memory is not a shape that crosses the wire.
      const parsed = parse(JSON.parse(JSON.stringify(request))) as Record<string, unknown>;
      const counts = Object.entries(parsed)
        .filter(([, value]) => Array.isArray(value))
        .map(([key, value]) => `${key}=${(value as unknown[]).length}`)
        .join(" ");
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${twin.padEnd(12)} ${counts}`);
    } catch (err) {
      failed++;
      console.log(`  \x1b[31m✗\x1b[0m ${twin.padEnd(12)} ${(err as Error).message}`);
    }
  }
}

console.log(`\n${passed} accepted, ${failed} refused`);
process.exit(failed === 0 ? 0 : 1);
