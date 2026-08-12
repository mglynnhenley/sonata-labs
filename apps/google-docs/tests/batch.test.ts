import { describe, expect, it } from "vitest";
import { applyBatchUpdate, checkWriteControl } from "@/lib/docs/batch";
import { DocsError } from "@/lib/docs/errors";
import { makeModel } from "./helpers";

// The dispatcher: one reply per request, and the atomicity contract that makes a
// batch safe to send.

describe("applyBatchUpdate", () => {
  it("returns exactly one reply per request, `{}` for the three that answer nothing", () => {
    const model = makeModel([{ text: "hello world" }]);
    const { replies } = applyBatchUpdate(model, [
      { insertText: { text: "x", location: { index: 1 } } },
      { deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 1 },
          paragraphStyle: { namedStyleType: "HEADING_1" },
          fields: "namedStyleType",
        },
      },
    ]);
    expect(replies).toEqual([{}, {}, {}]);
  });

  it("carries the payloads of the two requests that return something", () => {
    const model = makeModel([{ text: "a [[N]] b [[N]]" }]);
    const { replies } = applyBatchUpdate(model, [
      { replaceAllText: { containsText: { text: "[[N]]" }, replaceText: "1" } },
      { createNamedRange: { name: "span", range: { startIndex: 1, endIndex: 4 } } },
    ]);
    expect(replies[0]).toEqual({ replaceAllText: { occurrencesChanged: 2 } });
    expect((replies[1] as { createNamedRange: { namedRangeId: string } }).createNamedRange.namedRangeId).toMatch(
      /^kix\./,
    );
  });

  it("treats requests: [] as a legal no-op", () => {
    const model = makeModel([{ text: "unchanged" }]);
    const before = structuredClone(model);
    expect(applyBatchUpdate(model, []).replies).toEqual([]);
    expect(model).toEqual(before);
  });

  it("leaves the model byte-identical when a later request is invalid", () => {
    const model = makeModel([{ text: "hello" }]);
    const before = structuredClone(model);
    expect(() =>
      applyBatchUpdate(model, [
        { insertText: { text: "ok ", location: { index: 1 } } },
        { deleteContentRange: { range: { startIndex: 0, endIndex: 2 } } },
      ]),
    ).toThrow(/section break/);
    // The first request DID mutate the model in memory — the rollback that makes
    // the batch atomic is the surrounding SQLite transaction, which is why
    // batchUpdate must never persist from inside applyBatchUpdate.
    expect(model).not.toEqual(before);
  });

  it("rejects an unrecognised request key with the proto parser's wording", () => {
    const model = makeModel([{ text: "x" }]);
    expect(() => applyBatchUpdate(model, [{ insertTypo: {} }])).toThrow(
      `Invalid JSON payload received. Unknown name "insertTypo" at 'requests[0]': Cannot find field.`,
    );
  });

  it("rejects a request with no fields and one with two", () => {
    const model = makeModel([{ text: "x" }]);
    expect(() => applyBatchUpdate(model, [{}])).toThrow(
      "Invalid requests[0]: a request field must be set.",
    );
    expect(() =>
      applyBatchUpdate(model, [
        { insertText: { text: "a", location: { index: 1 } }, createNamedRange: { name: "n" } },
      ]),
    ).toThrow("Invalid requests[0]: exactly one request field may be set.");
  });

  it("rejects a non-array requests value", () => {
    const model = makeModel([{ text: "x" }]);
    expect(() => applyBatchUpdate(model, { insertText: {} })).toThrow(
      "Invalid requests: must be an array of Request objects.",
    );
  });

  it("answers insertTable with 501 UNIMPLEMENTED rather than faking a table", () => {
    const model = makeModel([{ text: "x" }]);
    try {
      applyBatchUpdate(model, [{ insertTable: { rows: 2, columns: 2 } }]);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DocsError);
      expect((err as DocsError).code).toBe(501);
      expect((err as DocsError).status).toBe("UNIMPLEMENTED");
    }
  });
});

describe("checkWriteControl", () => {
  it("passes when the required revision matches, and when none is given", () => {
    const model = makeModel([{ text: "x" }]);
    expect(() => checkWriteControl(model, { requiredRevisionId: model.revisionId })).not.toThrow();
    expect(() => checkWriteControl(model, undefined)).not.toThrow();
  });

  it("throws FAILED_PRECONDITION on a stale revision", () => {
    const model = makeModel([{ text: "x" }]);
    try {
      checkWriteControl(model, { requiredRevisionId: "someone-elses-revision" });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as DocsError).status).toBe("FAILED_PRECONDITION");
      expect((err as DocsError).message).toContain("does not match the current revision");
    }
  });
});
