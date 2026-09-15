import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let store: typeof import("../src/lib/store");
let routes: typeof import("../app/api/[...path]/route");
const directory = mkdtempSync(path.join(tmpdir(), "excel-control-auth-"));
beforeAll(async () => {
  vi.stubEnv("EXCEL_DATA_DIR", directory);
  vi.stubEnv("SANDBOX_TOKEN", "excel-agent");
  vi.stubEnv("SANDBOX_CONTROL_TOKEN", "excel-harness");
  store = await import("../src/lib/store");
  routes = await import("../app/api/[...path]/route");
  store.seedWorkbooks([{ id: "report", title: "Report", revision: 1, sheets: [
    { id: "sheet", name: "Report", columns: [{ key: "amount", label: "Amount", type: "number" }],
      rows: [{ id: "row", values: { amount: 1 } }] },
  ] }]);
});
afterAll(() => { store?.closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function request(route: string, token?: string, method = "GET", body?: unknown) {
  return routes.GET(new Request(`http://localhost/api/${route}`, { method,
    headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { params: Promise.resolve({ path: route.split("/") }) });
}

describe("workbook control boundary", () => {
  it("rejects agent, missing and other workplace credentials without changing data or audit", async () => {
    const before = store.snapshotWorkbooks();
    for (const token of [undefined, "excel-agent", "other-workplace-harness", "sandbox-token"]) {
      for (const route of ["sandbox/seed", "sandbox/reset", "sandbox/snapshot", "activity"]) {
        expect((await request(route, token, route.endsWith("seed") || route.endsWith("reset") ? "POST" : "GET")).status,
          `${route}: ${token}`).toBe(401);
      }
    }
    const after = store.snapshotWorkbooks();
    expect(after.workbooks).toEqual(before.workbooks);
    expect(after.changes).toEqual(before.changes);
    expect(store.activity(0)).toEqual([]);
  });

  it("keeps provider writes audited and allows harness capture/reset", async () => {
    const write = await request("workbooks/report/cells", "excel-agent", "PATCH", {
      revision: 1, changes: [{ sheetId: "sheet", rowId: "row", column: "amount", value: 2 }],
      reason: "Reconciled", evidence: "statement line 1",
    });
    expect(write.status).toBe(200);
    expect(store.activity(0)).toHaveLength(1);
    expect((await request("sandbox/snapshot", "excel-harness")).status).toBe(200);
    expect((await request("activity", "excel-harness")).status).toBe(200);
    expect((await request("sandbox/reset", "excel-harness", "POST")).status).toBe(200);
    expect(store.getWorkbook("report").sheets[0].rows[0].values.amount).toBe(1);
    expect((await request("workbooks", "excel-harness")).status).toBe(401);
    expect((await request("health")).status).toBe(200);
  });
});
