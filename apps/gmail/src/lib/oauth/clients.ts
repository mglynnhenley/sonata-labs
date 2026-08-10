import type { Database } from "better-sqlite3";
import { upsertClient, type ClientRow } from "./store";

// Well-known clients seeded so the bundled experience works with zero manual
// registration — the OAuth-era analog of today's default SANDBOX_TOKEN. Seeded
// idempotently into snapshot.db and working.db at db:init, and re-seeded after
// every reset (which copies snapshot over working), so the UI can always
// complete its flow.

/** The twin's own UI, a real confidential third-party OAuth client. */
export const DEV_UI_CLIENT_ID = process.env.GMAIL_UI_CLIENT_ID || "sonata-gmail-ui";
export const DEV_UI_CLIENT_SECRET =
  process.env.GMAIL_UI_CLIENT_SECRET || "dev-ui-secret-not-for-production";
/** Default UI callback — TWIN_UI_PORT for gmail is 3901 (see Phase 6 ports). */
export const DEV_UI_REDIRECT_URI =
  process.env.GMAIL_UI_REDIRECT_URI || "http://localhost:3901/oauth/callback";

/**
 * Internal client the admin mint (`POST /api/sandbox/token`) stamps onto tokens
 * it issues for the harness. Never runs the interactive flow, so it has no
 * usable redirect; it exists only to give minted tokens a stable client_id.
 */
export const HARNESS_CLIENT_ID = "sonata-harness";

export function seedDevClients(db: Database, now = Date.now()): void {
  const clients: ClientRow[] = [
    {
      client_id: DEV_UI_CLIENT_ID,
      client_secret: DEV_UI_CLIENT_SECRET,
      name: "Sonata Mail",
      redirect_uris: JSON.stringify([DEV_UI_REDIRECT_URI]),
      confidential: 1,
      created_at: now,
    },
    {
      client_id: HARNESS_CLIENT_ID,
      client_secret: null,
      name: "Sonata Benchmark Harness",
      redirect_uris: JSON.stringify([]),
      confidential: 0,
      created_at: now,
    },
  ];
  for (const c of clients) upsertClient(db, c);
}
