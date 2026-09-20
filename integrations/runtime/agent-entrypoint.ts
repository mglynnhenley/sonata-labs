// The sandbox gets the existing tool server, without the CLI's repository/config helpers.
import { serveStdio } from "../../packages/mcp/src/server";
import { isServedTwin, type ServedTwin } from "../../packages/mcp/src/config";

const requested = process.argv.slice(2);
if (requested.length === 0 || requested.some((name) => !isServedTwin(name))) {
  throw new Error("Pass the exact twin names assigned to this run.");
}
await serveStdio({ twins: [...new Set(requested)] as ServedTwin[] });
