import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

let store: typeof import("../src/lib/store");
let routes: typeof import("../app/api/[...path]/route");
const directory = mkdtempSync(path.join(tmpdir(), "excel-ui-origin-"));
beforeAll(async () => {
  vi.stubEnv("EXCEL_DATA_DIR", directory);
  vi.stubEnv("SANDBOX_PUBLIC_URL", "http://localhost:45678");
  store = await import("../src/lib/store");
  routes = await import("../app/api/[...path]/route");
  store.seedWorkbooks([{ id: "report", title: "Report", revision: 1, sheets: [
    { id: "sheet", name: "Report", columns: [{ key: "amount", label: "Amount", type: "number" }],
      rows: [{ id: "row", values: { amount: 1 } }] },
  ] }]);
});
afterAll(() => { store?.closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it("allows a proxied browser edit and refuses another workplace without changing data or audit", async () => {
  const request = (origin: string, revision: number, value: number) => routes.PATCH(new Request(
    "http://excel:3000/api/ui/workbooks/report/cells", {
      method: "PATCH", headers: { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ revision, changes: [{ sheetId: "sheet", rowId: "row", column: "amount", value }],
        reason: "Reconciled", evidence: "statement line 1" }),
    },
  ), { params: Promise.resolve({ path: ["ui", "workbooks", "report", "cells"] }) });
  expect((await request("http://localhost:45678", 1, 2)).status).toBe(200);
  expect(store.getWorkbook("report").sheets[0].rows[0].values.amount).toBe(2);
  expect(store.history()).toMatchObject([{ actor: "human", before: 1, after: 2 }]);
  expect((await request("http://localhost:45679", 2, 3)).status).toBe(403);
  expect(store.getWorkbook("report").sheets[0].rows[0].values.amount).toBe(2);
  expect(store.history()).toHaveLength(1);
  expect(store.activity(0)).toEqual([]);
});
