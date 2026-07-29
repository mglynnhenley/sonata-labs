// Loopback OAuth for the sync CLI. READ-ONLY scope. Real credentials are used
// ONLY here — never by the sandbox runtime.
//
// Setup (one time):
//   1. Create an OAuth "Desktop app" client in Google Cloud Console with the
//      Gmail API enabled.
//   2. Download its JSON to data/credentials.json (or set GOOGLE_CREDENTIALS_PATH).
// The consent screen will show read-only Gmail access only.

import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "../lib/db.js";

// gmail.readonly ONLY. Nothing here can write to Google.
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = path.join(DATA_DIR, "google-token.json");
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH || path.join(DATA_DIR, "credentials.json");

function loadSaved(): OAuth2Client | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const content = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
    return google.auth.fromJSON(content) as OAuth2Client;
  } catch {
    return null;
  }
}

function save(client: OAuth2Client): void {
  const keys = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  const key = keys.installed || keys.web;
  writeFileSync(
    TOKEN_PATH,
    JSON.stringify({
      type: "authorized_user",
      client_id: key.client_id,
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token,
    }),
  );
}

export async function authorize(): Promise<OAuth2Client> {
  ensureDataDir();
  const saved = loadSaved();
  if (saved) return saved;

  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing OAuth client at ${CREDENTIALS_PATH}. Create a Desktop OAuth client in ` +
        `Google Cloud (Gmail API enabled) and download its JSON there, or set GOOGLE_CREDENTIALS_PATH.`,
    );
  }
  const client = (await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  })) as OAuth2Client;
  if (client.credentials.refresh_token) save(client);
  return client;
}
