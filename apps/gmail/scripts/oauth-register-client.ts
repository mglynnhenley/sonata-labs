// Register an OAuth client with the sandbox authorization server.
//
//   npm run oauth:client -w apps/gmail -- \
//     --name "My Agent" --redirect-uri http://localhost:8080/callback
//
// Prints the client_id and client_secret. The SECRET IS SHOWN ONCE — it is not
// recoverable afterward. Registration writes to both snapshot.db and working.db
// so the client survives a `reset` (which copies snapshot over working).

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { SNAPSHOT_PATH, WORKING_PATH } from "../src/lib/db.js";
import { insertClient, getClient } from "../src/lib/oauth/store.js";

function parseArgs(argv: string[]): { name?: string; redirectUris: string[]; public: boolean } {
  const out = { redirectUris: [] as string[], public: false } as {
    name?: string;
    redirectUris: string[];
    public: boolean;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") out.name = argv[++i];
    else if (a === "--redirect-uri") out.redirectUris.push(argv[++i]);
    else if (a === "--public") out.public = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.name || args.redirectUris.length === 0) {
  console.error(
    "Usage: npm run oauth:client -w apps/gmail -- --name <name> --redirect-uri <uri> [--redirect-uri <uri>...] [--public]",
  );
  process.exit(1);
}

const clientId = `client_${randomBytes(8).toString("hex")}`;
const clientSecret = args.public ? null : randomBytes(24).toString("base64url");

const row = {
  client_id: clientId,
  client_secret: clientSecret,
  name: args.name,
  redirect_uris: JSON.stringify(args.redirectUris),
  confidential: args.public ? 0 : 1,
  created_at: Date.now(),
};

let wrote = 0;
for (const path of [WORKING_PATH, SNAPSHOT_PATH]) {
  if (!existsSync(path)) continue; // snapshot may not exist before a sync
  const db = new Database(path);
  try {
    if (!getClient(db, clientId)) {
      insertClient(db, row);
      wrote++;
    }
  } finally {
    db.close();
  }
}

if (wrote === 0) {
  console.error("No database found — run `npm run db:init -w apps/gmail` first.");
  process.exit(1);
}

console.log("Registered OAuth client:");
console.log(`  client_id:     ${clientId}`);
console.log(`  client_secret: ${clientSecret ?? "(public client — none)"}`);
console.log(`  redirect_uris: ${args.redirectUris.join(", ")}`);
console.log("\nStore the secret now — it will not be shown again.");
