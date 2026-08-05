// @sonata/mcp — the plug.
//
// Step one of the product is "connect your tools". This package is that step: one
// stdio MCP server fronting the Gmail, Slack and Calendar twins, so an external,
// long-lived agent — OpenClaw, Claude Code, Cowork, anything that speaks MCP —
// can be inside the fake company without Sonata ever calling it. The agent
// notices the world by polling its own tools; the twins audit-log everything it
// does; the existing judge scores the session afterwards, unchanged.
//
// The tools are not defined here. They are packages/engine/src/tools, imported —
// see ./manifest for why that is the whole design.

export * from "./config";
export * from "./errors";
export * from "./manifest";
export * from "./whatsNew";
export * from "./server";
export * from "./snippets";
export * from "./validate";
