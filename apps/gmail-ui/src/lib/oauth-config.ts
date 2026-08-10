// Configuration for the UI acting as a real third-party OAuth client of the
// API service. Defaults match the well-known dev client the API seeds
// (apps/gmail/src/lib/oauth/clients.ts) so the bundled experience works with no
// manual setup. Everything is overridable by env for a real deployment.

/** Base URL of the API service — used both for browser redirects (authorize)
 *  and server-side calls (token exchange, BFF). */
export const API_URL = (process.env.GMAIL_API_URL || "http://localhost:3101").replace(/\/+$/, "");

export const UI_CLIENT_ID = process.env.GMAIL_UI_CLIENT_ID || "sonata-gmail-ui";
export const UI_CLIENT_SECRET =
  process.env.GMAIL_UI_CLIENT_SECRET || "dev-ui-secret-not-for-production";
export const UI_REDIRECT_URI =
  process.env.GMAIL_UI_REDIRECT_URI || "http://localhost:3901/oauth/callback";

// The scopes the UI asks for. gmail.modify alone would satisfy every call the UI
// makes, but requesting the explicit set is what a real client would do.
export const UI_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.compose",
];

/** Admin token for the control-plane proxy routes (activity / eval / reset). */
export const ADMIN_TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

/** Secret used to seal the session + in-flight cookies (AES-256-GCM). */
export const COOKIE_SECRET =
  process.env.GMAIL_UI_COOKIE_SECRET || "dev-cookie-secret-change-me-please";

export const IS_PROD = process.env.NODE_ENV === "production";
