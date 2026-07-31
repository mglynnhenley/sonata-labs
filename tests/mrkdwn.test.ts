import { describe, it, expect } from "vitest";
import { parseMrkdwn, mrkdwnToPlain, type Token } from "@/lib/ui/mrkdwn";

const ctx = {
  users: { U0PRIYA0001: "priya" },
  channels: { C0ENGINEER1: "engineering" },
};

/** Collect every token type present in a tree (for structural assertions). */
function types(tokens: Token[]): string[] {
  const out: string[] = [];
  const walk = (ts: Token[]) => {
    for (const t of ts) {
      out.push(t.t);
      if ("children" in t) walk(t.children);
    }
  };
  walk(tokens);
  return out;
}

describe("mrkdwn parsing", () => {
  it("plain text passes through", () => {
    expect(parseMrkdwn("hello world")).toEqual([{ t: "text", v: "hello world" }]);
  });

  it("parses bold / italic / strike", () => {
    expect(types(parseMrkdwn("*b* _i_ ~s~"))).toContain("bold");
    expect(types(parseMrkdwn("*b* _i_ ~s~"))).toContain("italic");
    expect(types(parseMrkdwn("*b* _i_ ~s~"))).toContain("strike");
  });

  it("does not treat mid-word asterisks as emphasis", () => {
    expect(types(parseMrkdwn("2*3*4"))).not.toContain("bold");
  });

  it("parses inline code and fenced blocks", () => {
    expect(parseMrkdwn("use `npm run seed` now")[1]).toEqual({ t: "code", v: "npm run seed" });
    const pre = parseMrkdwn("```\nline1\nline2\n```");
    expect(pre[0]).toEqual({ t: "pre", v: "line1\nline2\n" });
  });

  it("does not apply emphasis inside code", () => {
    const toks = parseMrkdwn("`*not bold*`");
    expect(toks).toEqual([{ t: "code", v: "*not bold*" }]);
  });

  it("resolves user and channel mentions", () => {
    expect(parseMrkdwn("hi <@U0PRIYA0001>", ctx)[1]).toEqual({
      t: "user",
      id: "U0PRIYA0001",
      label: "priya",
    });
    expect(parseMrkdwn("see <#C0ENGINEER1>", ctx)[1]).toEqual({
      t: "channel",
      id: "C0ENGINEER1",
      label: "engineering",
    });
  });

  it("honors explicit labels and special mentions", () => {
    expect(parseMrkdwn("<@U0X|custom>")[0]).toMatchObject({ t: "user", label: "custom" });
    expect(parseMrkdwn("<!here>")[0]).toMatchObject({ t: "user", label: "@here" });
  });

  it("parses emoji shortcodes", () => {
    expect(parseMrkdwn("nice :tada: ok")[1]).toEqual({ t: "emoji", name: "tada" });
  });

  it("linkifies angle-bracket and bare URLs", () => {
    expect(parseMrkdwn("<https://x.com|X>")[0]).toEqual({
      t: "link",
      href: "https://x.com",
      label: "X",
    });
    expect(parseMrkdwn("go to https://x.com now")[1]).toMatchObject({
      t: "link",
      href: "https://x.com",
    });
  });

  it("preserves newlines as br tokens", () => {
    expect(types(parseMrkdwn("a\nb"))).toEqual(["text", "br", "text"]);
  });

  // --- security ---
  it("never emits raw HTML for script payloads", () => {
    const toks = parseMrkdwn('<script>alert(1)</script>');
    const json = JSON.stringify(toks);
    // The angle-bracket body is unrecognized → rendered literally as TEXT.
    expect(json).not.toContain('"t":"link"');
    expect(mrkdwnToPlain('<script>alert(1)</script>')).toContain("script");
  });

  it("blocks javascript: and data: URIs", () => {
    expect(parseMrkdwn("<javascript:alert(1)|click>")[0]).toMatchObject({ t: "text" });
    expect(parseMrkdwn("<data:text/html;base64,PHNjcmlwdD4=|x>")[0]).toMatchObject({ t: "text" });
    expect(types(parseMrkdwn("<javascript:alert(1)>"))).not.toContain("link");
  });

  it("handles unterminated markup without throwing", () => {
    for (const s of ["`unclosed", "```unclosed", "<unclosed", "*unclosed", "<@", ":::"]) {
      expect(() => parseMrkdwn(s)).not.toThrow();
    }
  });

  it("flattens to plain text", () => {
    expect(mrkdwnToPlain("*bold* and <@U0PRIYA0001> in <#C0ENGINEER1>", ctx)).toBe(
      "bold and @priya in #engineering",
    );
  });
});
