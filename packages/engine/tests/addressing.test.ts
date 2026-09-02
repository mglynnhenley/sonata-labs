import { describe, expect, it } from "vitest";
import type { BeatBody, InjectContext } from "@sonata/core";
import { createAttioAdapter } from "../src/adapters/attio";
import { createGoogleDocsAdapter } from "../src/adapters/google-docs";
import { world } from "./fixtures";

// How a beat says which thing it means, on the two surfaces where the thing
// already exists before the day starts.
//
// This is the property the whole file is about: an episode author writes against
// a WorldSeed, and a WorldSeed names no CRM record and no document. Every id on
// these two surfaces is a hash minted at seed time inside @sonata/world and
// published nowhere a person reads — so a beat that could only point at ids
// could only ever touch what its own siblings had created, and `injectBody`
// never throws, which means every attempt to name the deal the day is about
// became a per-beat error nobody saw.
//
// Offline: each adapter is handed a fetch that answers the twin's routes from a
// literal, and the assertions are on what was POSTed.

/** One recorded request, so a test can assert on what actually crossed the wire. */
interface Sent {
  url: string;
  body: unknown;
}

/**
 * A twin, as far as these tests are concerned: a table from path to response.
 * Anything unrouted is a 404 with the twin's own envelope, so a test that meant
 * to stub a route and misspelled it fails as a missing route rather than as a
 * confusing undefined.
 */
function stubTwin(routes: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    if (init?.method === "POST") {
      sent.push({ url: path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    }
    const hit = Object.entries(routes).find(([key]) => path === key || path.startsWith(key));
    if (!hit) {
      return new Response(JSON.stringify({ ok: false, error: `no route ${path}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(hit[1]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { sent, fetchImpl };
}

const ctx = (atISO = "2026-03-02T09:00:00.000Z"): InjectContext => ({
  atISO,
  // Empty on purpose: this file is about everything the registry CANNOT answer.
  // `createRefRegistry()` starts empty on every run, which is exactly why naming
  // a seeded thing had to become possible.
  resolve: () => undefined,
  world,
});

describe("attio addressing", () => {
  const RECORDS = {
    data: [
      { id: { record_id: "88a4c3b2-f525-8a44-cc57-57346e5836aa" }, values: { name: [{ value: "Harrowgate — pricing engagement" }] } },
      { id: { record_id: "11111111-2222-3333-4444-555555555555" }, values: { name: [{ value: "Cormorant Energy — market entry" }] } },
    ],
  };

  it("resolves a seeded deal by the name the world wrote", async () => {
    const { sent, fetchImpl } = stubTwin({
      "/v2/objects/deals/records/query": RECORDS,
      "/api/sandbox/inject": { updates: [{ id: "x", object: "deals" }] },
    });
    const adapter = createAttioAdapter({ baseUrl: "http://twin.test", fetchImpl });

    await adapter.inject(
      {
        twin: "attio",
        kind: "update",
        payload: {
          recordRef: "Harrowgate — pricing engagement",
          object: "deals",
          values: { stage: "Won 🎉" },
        },
      } satisfies BeatBody,
      ctx(),
    );

    const inject = sent.find((s) => s.url === "/api/sandbox/inject");
    expect(inject?.body).toMatchObject({
      updates: [{ object: "deals", recordId: "88a4c3b2-f525-8a44-cc57-57346e5836aa" }],
    });
  });

  it("passes an unmatched ref through as an id, so the twin names it", async () => {
    // Not this adapter's error to raise: the twin's 400 says which id it could
    // not find, which is more accurate than anything guessed from here.
    const { sent, fetchImpl } = stubTwin({
      "/v2/objects/companies/records/query": RECORDS,
      "/api/sandbox/inject": { notes: [{ ref: "n", id: "note-1" }] },
    });
    const adapter = createAttioAdapter({ baseUrl: "http://twin.test", fetchImpl });

    await adapter.inject(
      {
        twin: "attio",
        kind: "note",
        payload: {
          parentObject: "companies",
          parentRecordRef: "no such account",
          title: "Called them",
          content: "Left a voicemail.",
        },
      } satisfies BeatBody,
      ctx(),
    );

    expect(sent.find((s) => s.url === "/api/sandbox/inject")?.body).toMatchObject({
      notes: [{ parentObject: "companies", parentRecordId: "no such account" }],
    });
  });
});

describe("google-docs addressing", () => {
  const SNAPSHOT = {
    documents: [
      { documentId: "g7OPJMGzYEQMiajEAsMZYL-q5Gk3KdD-5ISlLobYSxMg", title: "Elasticity model v6 — assumptions" },
      { documentId: "smjhIIEWtbpiYM6sc5DTAPmgnmDk6HUW2vo1u6fQjNR6", title: "Harrowgate — board pack" },
    ],
  };

  it("resolves a seeded document by its title", async () => {
    const { sent, fetchImpl } = stubTwin({
      "/api/sandbox/snapshot": SNAPSHOT,
      "/api/sandbox/inject": { ok: true, injected: { edits: [{ occurrencesChanged: 1 }] } },
    });
    const adapter = createGoogleDocsAdapter({ baseUrl: "http://twin.test", fetchImpl });

    const handle = await adapter.inject(
      {
        twin: "google-docs",
        kind: "append",
        payload: {
          documentRef: "Elasticity model v6 — assumptions",
          paragraphs: [{ text: "Mei has checked sheets three and four." }],
        },
      } satisfies BeatBody,
      ctx(),
    );

    expect(handle.id).toBe("g7OPJMGzYEQMiajEAsMZYL-q5Gk3KdD-5ISlLobYSxMg");
    expect(sent.find((s) => s.url === "/api/sandbox/inject")?.body).toMatchObject({
      edits: [{ documentId: "g7OPJMGzYEQMiajEAsMZYL-q5Gk3KdD-5ISlLobYSxMg" }],
    });
  });

  it("refuses to give a document an owner who is not in the cast", async () => {
    // The one rule the twin states outright — a twin must never invent an
    // identity — and the beat path was the hole in it: `emailOf` falls back to
    // the ref, so a typo produced a document owned by `mai`, who is nobody.
    const { sent, fetchImpl } = stubTwin({
      "/api/sandbox/inject": { ok: true, injected: { documents: [{ documentId: "d1" }] } },
    });
    const adapter = createGoogleDocsAdapter({ baseUrl: "http://twin.test", fetchImpl });

    await expect(
      adapter.inject(
        {
          twin: "google-docs",
          kind: "document",
          payload: { title: "Owned by a typo", owner: "prya", paragraphs: [{ text: "…" }] },
        } satisfies BeatBody,
        ctx(),
      ),
    ).rejects.toThrow(/"prya", who is not in the cast/);
    expect(sent).toHaveLength(0);
  });
});
