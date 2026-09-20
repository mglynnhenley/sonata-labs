import { describe, expect, it } from "vitest";
import { GoogleAdsError } from "@/lib/googleads/errors";
import { parseGaql } from "@/lib/googleads/gaql/parse";

// Pure parser cases over the AST — no database. The rejections matter at least
// as much as the acceptances: a restricted grammar is only useful if it says so
// in a way an agent can act on, so every negative case pins the error CODE and
// the message an agent will read.

function rejection(query: string): GoogleAdsError {
  try {
    parseGaql(query);
  } catch (err) {
    if (err instanceof GoogleAdsError) return err;
    throw err;
  }
  throw new Error(`expected ${JSON.stringify(query)} to be rejected`);
}

describe("parseGaql — accepts", () => {
  it("a bare SELECT/FROM", () => {
    expect(parseGaql("SELECT campaign.id, campaign.name FROM campaign")).toEqual({
      select: ["campaign.id", "campaign.name"],
      from: "campaign",
      where: [],
      orderBy: [],
      limit: undefined,
    });
  });

  it("single- and double-quoted values alike", () => {
    expect(parseGaql("SELECT campaign.id FROM campaign WHERE campaign.name = 'Acme'").where).toEqual(
      [{ field: "campaign.name", op: "=", values: ["Acme"] }],
    );
    expect(parseGaql('SELECT campaign.id FROM campaign WHERE campaign.name = "Acme"').where).toEqual(
      [{ field: "campaign.name", op: "=", values: ["Acme"] }],
    );
  });

  it("IN with a parenthesised list, and NOT IN", () => {
    expect(
      parseGaql("SELECT campaign.id FROM campaign WHERE campaign.status IN ('ENABLED', 'PAUSED')")
        .where[0],
    ).toEqual({ field: "campaign.status", op: "IN", values: ["ENABLED", "PAUSED"] });
    expect(
      parseGaql("SELECT campaign.id FROM campaign WHERE campaign.status NOT IN ('REMOVED')").where[0],
    ).toEqual({ field: "campaign.status", op: "NOT IN", values: ["REMOVED"] });
  });

  it("every supported DURING literal", () => {
    for (const literal of [
      "TODAY",
      "YESTERDAY",
      "LAST_7_DAYS",
      "LAST_14_DAYS",
      "LAST_30_DAYS",
      "THIS_MONTH",
      "LAST_MONTH",
    ]) {
      const q = parseGaql(
        `SELECT metrics.clicks FROM campaign WHERE segments.date DURING ${literal}`,
      );
      expect(q.where[0]).toEqual({ field: "segments.date", op: "DURING", values: [literal] });
    }
  });

  it("BETWEEN with two dates", () => {
    expect(
      parseGaql(
        "SELECT metrics.clicks FROM campaign WHERE segments.date BETWEEN '2026-07-27' AND '2026-08-02'",
      ).where[0],
    ).toEqual({ field: "segments.date", op: "BETWEEN", values: ["2026-07-27", "2026-08-02"] });
  });

  it("LIKE and NOT LIKE with the caller's wildcards intact", () => {
    expect(
      parseGaql("SELECT campaign.id FROM campaign WHERE campaign.name LIKE '%Payments%'").where[0]
        .values,
    ).toEqual(["%Payments%"]);
    expect(
      parseGaql("SELECT campaign.id FROM campaign WHERE campaign.name NOT LIKE '%Brand%'").where[0]
        .op,
    ).toBe("NOT LIKE");
  });

  it("ORDER BY with multiple keys and mixed directions", () => {
    expect(
      parseGaql(
        "SELECT campaign.id FROM campaign ORDER BY metrics.cost_micros DESC, campaign.name ASC",
      ).orderBy,
    ).toEqual([
      { field: "metrics.cost_micros", desc: true },
      { field: "campaign.name", desc: false },
    ]);
  });

  it("LIMIT", () => {
    expect(parseGaql("SELECT campaign.id FROM campaign LIMIT 5").limit).toBe(5);
  });

  it("extra whitespace and newlines", () => {
    expect(
      parseGaql("  SELECT\n  campaign.id ,\tcampaign.name\n FROM  campaign\n LIMIT 2 ").select,
    ).toEqual(["campaign.id", "campaign.name"]);
  });

  it("case-insensitive keywords but case-sensitive field names", () => {
    expect(parseGaql("select campaign.id from campaign Where campaign.status = 'ENABLED'").from).toBe(
      "campaign",
    );
    expect(rejection("SELECT Campaign.Id FROM campaign").errorCode).toEqual({
      queryError: "UNRECOGNIZED_FIELD",
    });
  });

  it("conditions joined with AND", () => {
    const q = parseGaql(
      "SELECT metrics.clicks FROM campaign WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_7_DAYS",
    );
    expect(q.where).toHaveLength(2);
  });
});

describe("parseGaql — rejects", () => {
  it("a blank query", () => {
    const err = rejection("   ");
    expect(err.errorCode).toEqual({ queryError: "UNEXPECTED_END_OF_QUERY" });
    expect(err.message).toBe("Unexpected end of query.");
  });

  it("a query that does not begin with SELECT", () => {
    const err = rejection("FROM campaign");
    expect(err.errorCode).toEqual({ queryError: "BAD_SYMBOL" });
    expect(err.message).toContain("must begin with SELECT");
  });

  it("a missing FROM", () => {
    expect(rejection("SELECT campaign.id").errorCode).toEqual({
      queryError: "UNEXPECTED_END_OF_QUERY",
    });
  });

  it("an unknown FROM resource", () => {
    const err = rejection("SELECT campaign.id FROM keyword_view");
    expect(err.errorCode).toEqual({ queryError: "BAD_RESOURCE_TYPE_IN_FROM_CLAUSE" });
    expect(err.message).toContain("'keyword_view'");
  });

  it("an unknown field, in Google's own wording", () => {
    const err = rejection("SELECT campaign.spend FROM campaign");
    expect(err.errorCode).toEqual({ queryError: "UNRECOGNIZED_FIELD" });
    expect(err.message).toBe("Unrecognized field in the query: 'campaign.spend'.");
    expect(err.trigger).toBe("campaign.spend");
    expect(err.fieldPath).toEqual([{ fieldName: "query" }]);
  });

  it("OR, which GAQL genuinely does not have", () => {
    const err = rejection(
      "SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED' OR campaign.status = 'PAUSED'",
    );
    expect(err.errorCode).toEqual({ queryError: "BAD_SYMBOL" });
    expect(err.message).toContain("joined with AND only");
  });

  it("REGEXP_MATCH, naming the supported operators", () => {
    const err = rejection("SELECT campaign.id FROM campaign WHERE campaign.name REGEXP_MATCH '.*'");
    expect(err.errorCode).toEqual({ queryError: "BAD_OPERATOR" });
    expect(err.message).toContain("DURING, BETWEEN");
  });

  it("NOT REGEXP_MATCH, spelled as written", () => {
    const err = rejection(
      "SELECT campaign.id FROM campaign WHERE campaign.name NOT REGEXP_MATCH '.*'",
    );
    expect(err.errorCode).toEqual({ queryError: "BAD_OPERATOR" });
    expect(err.trigger).toBe("NOT REGEXP_MATCH");
  });

  it("IS NULL and CONTAINS ANY, both spelled in full", () => {
    expect(rejection("SELECT campaign.id FROM campaign WHERE campaign.end_date IS NULL").trigger).toBe(
      "IS NULL",
    );
    expect(
      rejection("SELECT campaign.id FROM campaign WHERE campaign.name CONTAINS ANY ('a')").trigger,
    ).toBe("CONTAINS ANY");
  });

  it("the PARAMETERS clause", () => {
    const err = rejection("SELECT campaign.id FROM campaign PARAMETERS include_drafts=true");
    expect(err.errorCode).toEqual({ queryError: "BAD_SYMBOL" });
    expect(err.message).toContain("SELECT, FROM, WHERE, ORDER BY and LIMIT");
  });

  it("LIMIT 0 and a non-integer LIMIT", () => {
    expect(rejection("SELECT campaign.id FROM campaign LIMIT 0").errorCode).toEqual({
      queryError: "LIMIT_VALUE_TOO_LOW",
    });
    expect(rejection("SELECT campaign.id FROM campaign LIMIT 2.5").errorCode).toEqual({
      queryError: "LIMIT_VALUE_TOO_LOW",
    });
    expect(rejection("SELECT campaign.id FROM campaign LIMIT").errorCode).toEqual({
      queryError: "LIMIT_VALUE_TOO_LOW",
    });
  });

  it("a trailing token, naming it", () => {
    const err = rejection("SELECT campaign.id FROM campaign LIMIT 5 sideways");
    expect(err.errorCode).toEqual({ queryError: "BAD_SYMBOL" });
    expect(err.trigger).toBe("sideways");
  });

  it("an unterminated string literal", () => {
    expect(
      rejection("SELECT campaign.id FROM campaign WHERE campaign.name = 'Acme").errorCode,
    ).toEqual({ queryError: "STRING_NOT_TERMINATED" });
  });

  it("every rejection as an HTTP 400 pointing at `query`", () => {
    const err = rejection("SELECT campaign.spend FROM campaign");
    expect(err.httpStatus).toBe(400);
    expect(err.toItem().location).toEqual({ fieldPathElements: [{ fieldName: "query" }] });
  });
});
