import { describe, expect, it } from "vitest";
import { configFromEnv, DEFAULT_TWIN_URLS } from "../src/config";
import { parseArgv, helpText } from "../src/cli";
import {
  claudeCodeSnippet,
  connectionSnippets,
  launchFor,
  mcpServersJson,
  restSnippet,
} from "../src/snippets";
import { testConfig } from "./fixtures";

// These strings are the product's first screen — the Connect page renders them and
// a user pastes them without reading. Asserting them character for character is
// the only way a reworded snippet cannot quietly become one that does not run.

const launch = launchFor("/repo/sonata", undefined);

describe("connection snippets", () => {
  it("renders the Claude Code command", () => {
    expect(claudeCodeSnippet({ config: testConfig, launch })).toBe(
      "claude mcp add sonata " +
        "--env SONATA_TOKEN=test-token " +
        "--env SONATA_GMAIL_URL=http://gmail.test " +
        "--env SONATA_SLACK_URL=http://slack.test " +
        "--env SONATA_CALENDAR_URL=http://calendar.test " +
        "-- /repo/sonata/node_modules/.bin/sonata-mcp",
    );
  });

  it("passes the twin as a positional argument when only one is served", () => {
    const one = launchFor("/repo/sonata/", ["gmail"]);
    expect(one.args).toEqual(["gmail"]);
    expect(claudeCodeSnippet({ config: testConfig, twins: ["gmail"], launch: one })).toBe(
      "claude mcp add sonata " +
        "--env SONATA_TOKEN=test-token " +
        "--env SONATA_GMAIL_URL=http://gmail.test " +
        "-- /repo/sonata/node_modules/.bin/sonata-mcp gmail",
    );
  });

  it("renders an mcpServers block any client can paste", () => {
    expect(JSON.parse(mcpServersJson({ config: testConfig, launch }))).toEqual({
      mcpServers: {
        sonata: {
          command: "/repo/sonata/node_modules/.bin/sonata-mcp",
          args: [],
          env: {
            SONATA_TOKEN: "test-token",
            SONATA_GMAIL_URL: "http://gmail.test",
            SONATA_SLACK_URL: "http://slack.test",
            SONATA_CALENDAR_URL: "http://calendar.test",
          },
        },
      },
    });
  });

  it("renders raw REST details for an agent that speaks no MCP", () => {
    const text = restSnippet({ config: testConfig, launch });
    expect(text).toContain("Authorization: Bearer test-token");
    expect(text).toContain("gmail     http://gmail.test");
    expect(text).toContain("slack     http://slack.test");
    expect(text).toContain("calendar  http://calendar.test");
    expect(text).toContain(
      'curl -s -H "Authorization: Bearer test-token" \\\n' +
        '  "http://gmail.test/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=10"',
    );
  });

  it("quotes a path with spaces, and leaves a plain one alone", () => {
    const spaced = claudeCodeSnippet({
      config: testConfig,
      launch: { command: "/Users/me/My Repo/node_modules/.bin/sonata-mcp", args: [] },
    });
    expect(spaced).toContain("-- '/Users/me/My Repo/node_modules/.bin/sonata-mcp'");
  });

  it("names the server the same way in every form", () => {
    const all = connectionSnippets({ config: testConfig, launch, serverName: "workday" });
    expect(all.claudeCode).toContain("claude mcp add workday ");
    expect(JSON.parse(all.mcpJson)).toHaveProperty("mcpServers.workday");
  });
});

describe("config", () => {
  it("defaults to the ports the monorepo's dev scripts bind", () => {
    const config = configFromEnv({});
    expect(config.urls).toEqual(DEFAULT_TWIN_URLS);
    expect(config.token).toBe("sandbox-token");
  });

  it("takes the twins' own SANDBOX_TOKEN when SONATA_TOKEN is unset", () => {
    expect(configFromEnv({ SANDBOX_TOKEN: "shared" }).token).toBe("shared");
    expect(configFromEnv({ SANDBOX_TOKEN: "shared", SONATA_TOKEN: "mine" }).token).toBe("mine");
  });

  it("trims a trailing slash, so no URL is ever built with a double one", () => {
    expect(configFromEnv({ SONATA_GMAIL_URL: "http://box.test/" }).urls.gmail).toBe(
      "http://box.test",
    );
  });
});

describe("cli", () => {
  it("serves all three twins by default and one when named", () => {
    expect(parseArgv([]).twins).toEqual(["gmail", "slack", "calendar"]);
    expect(parseArgv(["gmail"]).twins).toEqual(["gmail"]);
    expect(parseArgv(["slack", "calendar"]).twins).toEqual(["slack", "calendar"]);
    expect(parseArgv(["gmail", "gmail"]).twins).toEqual(["gmail"]);
  });

  it("reports a typo instead of silently serving everything", () => {
    expect(parseArgv(["gmial"]).unknown).toEqual(["gmial"]);
  });

  it("has a connect mode and a help mode", () => {
    expect(parseArgv(["connect"]).mode).toBe("connect");
    expect(parseArgv(["--help"]).mode).toBe("help");
    expect(helpText()).toContain("SONATA_CALENDAR_URL");
  });
});
