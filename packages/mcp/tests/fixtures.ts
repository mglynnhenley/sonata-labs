import type { SonataConfig } from "../src/config";

// A twin that answers from a table and remembers what it was asked.
//
// Same idea as the engine's own test fetch fake, kept local rather than imported:
// a package's tests should not need another package's tests on disk to run. The
// difference is that routes here may be functions, because the whats_new tests
// need a world that changes between two polls.

export const testConfig: SonataConfig = {
  token: "test-token",
  urls: {
    gmail: "http://gmail.test",
    slack: "http://slack.test",
    calendar: "http://calendar.test",
    attio: "http://attio.test",
    "google-docs": "http://google-docs.test",
  },
};

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Route = unknown | ((call: Call) => unknown);

export interface FetchFake {
  fetch: typeof globalThis.fetch;
  calls: Call[];
  find(needle: string): Call | undefined;
  all(needle: string): Call[];
}

/**
 * The admin-gated bridge every Gmail client now goes through before it can touch
 * /gmail/v1/*. It is answered here rather than in each test because it is part of
 * the world, not part of any one case: a test that forgot it would fail with a
 * 404 on a route it never meant to exercise.
 */
const MINT_ROUTE = "/api/sandbox/token";
const MINT_RESPONSE = { access_token: "test-access-token", token_type: "Bearer", expires_in: 3600 };

/** `routes` maps a URL substring to the JSON the twin answers with. */
export function fetchFake(routes: Record<string, Route>): FetchFake {
  const withMint: Record<string, Route> = { [MINT_ROUTE]: MINT_RESPONSE, ...routes };
  routes = withMint;
  const calls: Call[] = [];
  const fake: typeof globalThis.fetch = (input, init) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: raw ? parseBody(raw, init) : undefined,
    };
    calls.push(call);
    // Longest match wins: "/messages/x" must not be answered by "/messages".
    const key = Object.keys(routes)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    const status = key === undefined ? 404 : 200;
    const value = key === undefined ? { error: `no route for ${url}` } : routes[key];
    const body = typeof value === "function" ? (value as (c: Call) => unknown)(call) : value;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return {
    fetch: fake,
    calls,
    find: (needle) => [...calls].reverse().find((c) => c.url.includes(needle)),
    all: (needle) => calls.filter((c) => c.url.includes(needle)),
  };
}

function parseBody(raw: string, init: RequestInit | undefined): unknown {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (headers["Content-Type"]?.includes("x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** A fetch that fails the way a twin nobody started fails. */
export function refusingFetch(port: number): typeof globalThis.fetch {
  return () =>
    Promise.reject(
      new TypeError("fetch failed", {
        cause: new Error(`connect ECONNREFUSED 127.0.0.1:${port}`),
      }),
    );
}

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

/** A Gmail message in the shape the twin returns for `format=full`. */
export function gmailMessage(over: {
  id: string;
  threadId?: string;
  from?: string;
  subject?: string;
  date?: string;
  body?: string;
  labelIds?: string[];
}): Record<string, unknown> {
  return {
    id: over.id,
    threadId: over.threadId ?? `t-${over.id}`,
    labelIds: over.labelIds ?? ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: over.from ?? "dana@acme.test" },
        { name: "To", value: "priya@northwind.test" },
        { name: "Subject", value: over.subject ?? "Where is my freight" },
        { name: "Date", value: over.date ?? "Tue, 04 Aug 2026 09:00:00 +0000" },
        { name: "Message-ID", value: `<${over.id}@acme.test>` },
      ],
      body: { data: b64(over.body ?? "Well?") },
    },
  };
}
