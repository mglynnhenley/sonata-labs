// Gmail OAuth scopes — the real Google strings, so an agent that requests the
// scopes it would ask Google for gets the same grant here. Enforcement is
// per-route (see route-helpers.ts): each route declares the scope it needs, and
// a granted scope satisfies it if it is the same string or a strictly broader one.

export const GMAIL_SCOPE = {
  readonly: "https://www.googleapis.com/auth/gmail.readonly",
  send: "https://www.googleapis.com/auth/gmail.send",
  compose: "https://www.googleapis.com/auth/gmail.compose",
  modify: "https://www.googleapis.com/auth/gmail.modify",
  labels: "https://www.googleapis.com/auth/gmail.labels",
  /** Full mailbox access — Google's broadest Gmail scope. Satisfies everything. */
  full: "https://mail.google.com/",
} as const;

export type GmailScope = (typeof GMAIL_SCOPE)[keyof typeof GMAIL_SCOPE];

/** Every scope the server will grant. Anything else on an authorize request 400s. */
export const KNOWN_SCOPES: ReadonlySet<string> = new Set(Object.values(GMAIL_SCOPE));

// For each requirable scope, the set of granted scopes that satisfy it — mirroring
// Google's real hierarchy (modify implies read/write of most resources; the full
// mail scope implies everything; compose can send). A required scope always
// satisfies itself; `full` satisfies all.
const SATISFIED_BY: Record<string, ReadonlySet<string>> = {
  [GMAIL_SCOPE.readonly]: new Set([GMAIL_SCOPE.readonly, GMAIL_SCOPE.modify, GMAIL_SCOPE.full]),
  [GMAIL_SCOPE.labels]: new Set([GMAIL_SCOPE.labels, GMAIL_SCOPE.modify, GMAIL_SCOPE.full]),
  [GMAIL_SCOPE.send]: new Set([
    GMAIL_SCOPE.send,
    GMAIL_SCOPE.compose,
    GMAIL_SCOPE.modify,
    GMAIL_SCOPE.full,
  ]),
  [GMAIL_SCOPE.compose]: new Set([GMAIL_SCOPE.compose, GMAIL_SCOPE.modify, GMAIL_SCOPE.full]),
  [GMAIL_SCOPE.modify]: new Set([GMAIL_SCOPE.modify, GMAIL_SCOPE.full]),
  [GMAIL_SCOPE.full]: new Set([GMAIL_SCOPE.full]),
};

/** Parse a space-delimited scope string into a de-duplicated list. */
export function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/\s+/).filter(Boolean))];
}

/** Serialize scopes back to the space-delimited wire form. */
export function serializeScopes(scopes: Iterable<string>): string {
  return [...new Set(scopes)].join(" ");
}

/** True if `granted` (space-delimited or list) satisfies the single `required` scope. */
export function hasScope(granted: string | Iterable<string>, required: string): boolean {
  const grantedSet = new Set(typeof granted === "string" ? parseScopes(granted) : granted);
  const acceptable = SATISFIED_BY[required];
  if (!acceptable) return grantedSet.has(required); // unknown requirement: exact match only
  for (const s of acceptable) if (grantedSet.has(s)) return true;
  return false;
}

/** Split requested scopes into the ones we grant and the ones we reject. */
export function partitionScopes(requested: string[]): { granted: string[]; unknown: string[] } {
  const granted: string[] = [];
  const unknown: string[] = [];
  for (const s of requested) (KNOWN_SCOPES.has(s) ? granted : unknown).push(s);
  return { granted, unknown };
}
