import { describe, expect, it } from "vitest";
import { wrap } from "../src/render";

// A fix that ran off the edge of an 80-column terminal would be a fix nobody
// could read, so wrapping must never drop or join words.

describe("wrap", () => {
  it("keeps every word, in order, under the width", () => {
    const text = "npm run db:init -w apps/gmail (every statement is CREATE IF NOT EXISTS, so it keeps your data)";
    const lines = wrap(text, "    ", 40);
    expect(lines.join(" ").split(/\s+/).filter(Boolean)).toEqual(text.split(" "));
    for (const line of lines) expect(line.startsWith("    ")).toBe(true);
  });

  it("does not lose a word longer than the whole width", () => {
    const long = "a".repeat(60);
    expect(wrap(`fix: ${long}`, "  ", 20).join("\n")).toContain(long);
  });
});
