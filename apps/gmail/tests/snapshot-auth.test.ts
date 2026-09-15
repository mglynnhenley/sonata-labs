import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { captureTwinSnapshot } from "../src/lib/sandbox/snapshot";

afterEach(() => vi.unstubAllEnvs());

it("captures through OAuth when the workplace has separate provider and control credentials", async () => {
  vi.stubEnv("SANDBOX_TOKEN", "snapshot-agent-only");
  vi.stubEnv("SANDBOX_CONTROL_TOKEN", "snapshot-control-only");
  const calls: Array<{ path: string; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    const pathname = new URL(req.url!, "http://localhost").pathname;
    calls.push({ path: pathname, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    const mint = pathname === "/api/sandbox/token";
    const expected = mint ? "Bearer snapshot-control-only" : "Bearer snapshot-oauth-access";
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
    } else if (mint) {
      res.end(JSON.stringify({ access_token: "snapshot-oauth-access" }));
    } else {
      const resource = pathname.split("/").at(-1)!;
      res.end(JSON.stringify({ [resource]: [] }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const snapshot = await captureTwinSnapshot(`http://127.0.0.1:${address.port}`);
    expect(snapshot).toMatchObject({ twin: "gmail", labels: [], threads: [], drafts: [] });
    expect(calls).toEqual([
      { path: "/api/sandbox/token", authorization: "Bearer snapshot-control-only" },
      { path: "/gmail/v1/users/me/labels", authorization: "Bearer snapshot-oauth-access" },
      { path: "/gmail/v1/users/me/threads", authorization: "Bearer snapshot-oauth-access" },
      { path: "/gmail/v1/users/me/drafts", authorization: "Bearer snapshot-oauth-access" },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
