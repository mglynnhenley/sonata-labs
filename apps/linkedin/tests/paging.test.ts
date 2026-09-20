import { describe, it, expect } from "vitest";
import { buildPaging, clampCount, nextHref, parseStart } from "@/lib/linkedin/paging";

describe("clampCount", () => {
  it("falls back to the default for anything unusable", () => {
    for (const raw of [null, "", "abc", "0", "-4", "NaN"]) {
      expect(clampCount(raw)).toBe(10);
    }
  });

  it("caps at LinkedIn's maximum", () => {
    expect(clampCount("50")).toBe(50);
    expect(clampCount("500")).toBe(100);
  });

  it("floors a fractional count rather than passing it to LIMIT", () => {
    expect(clampCount("7.9")).toBe(7);
  });
});

describe("parseStart", () => {
  it("returns 0 for anything unusable and never throws", () => {
    for (const raw of [null, "", "abc", "-1"]) {
      expect(parseStart(raw)).toBe(0);
    }
    expect(parseStart("20")).toBe(20);
  });
});

describe("buildPaging", () => {
  it("emits no link on the last page", () => {
    // An agent that follows a `next` on the last page gets an empty elements
    // array and concludes the world is empty.
    expect(
      buildPaging({ start: 0, count: 10, hasMore: false, nextHref: "/rest/posts?start=10" }).links,
    ).toEqual([]);
  });

  it("emits exactly one rel=next entry when rows remain", () => {
    const paging = buildPaging({
      start: 0,
      count: 10,
      hasMore: true,
      nextHref: "/rest/posts?start=10",
    });
    expect(paging.links).toEqual([
      { type: "application/json", rel: "next", href: "/rest/posts?start=10" },
    ]);
  });

  it("omits total unless the endpoint actually returns one", () => {
    expect("total" in buildPaging({ start: 0, count: 10, hasMore: false })).toBe(false);
    expect(buildPaging({ start: 0, count: 10, hasMore: false, total: 9 }).total).toBe(9);
  });

  it("gives a start past the end an empty page and no next link", () => {
    const paging = buildPaging({ start: 50, count: 10, hasMore: false, total: 9 });
    expect(paging.links).toEqual([]);
    expect(paging.start).toBe(50);
  });
});

describe("nextHref", () => {
  const params = () =>
    new URLSearchParams({
      q: "author",
      author: "urn:li:organization:7412903",
      count: "10",
      start: "0",
    });

  it("replaces only start and preserves everything else", () => {
    const href = nextHref("/rest/posts", params(), 10);
    const next = new URL(href, "http://x").searchParams;
    expect(next.get("start")).toBe("10");
    expect(next.get("q")).toBe("author");
    expect(next.get("author")).toBe("urn:li:organization:7412903");
    expect(next.get("count")).toBe("10");
  });

  it("sorts the keys so the href is stable across runs", () => {
    expect(nextHref("/rest/posts", params(), 10)).toBe(
      "/rest/posts?author=urn%3Ali%3Aorganization%3A7412903&count=10&q=author&start=10",
    );
  });

  it("adds start when the incoming request had none", () => {
    const href = nextHref("/rest/posts", new URLSearchParams({ q: "author" }), 10);
    expect(href).toBe("/rest/posts?q=author&start=10");
  });
});
