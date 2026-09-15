import { describe, expect, it } from "vitest";
import type { ExcelSnapshot } from "@sonata/core";
import { createExcelAdapter, diffExcel, renderExcelDiff } from "../src/adapters/excel";
import { createTwinHttp } from "../src/http";
import { excelTools } from "../src/tools/excel";
import { fetchFake } from "./fixtures";

const before: ExcelSnapshot = {
  twin: "excel", capturedAt: 0, changes: [],
  workbooks: [{ id: "w1", title: "FATCA CRS", revision: 1, sheets: [{ id: "proposed", name: "Proposed", columns: [{ key: "status", label: "Status", type: "text" }], rows: [{ id: "r1", values: { status: "Pending" } }] }] }],
};

describe("Excel evidence", () => {
  it("preserves full original and proposed workbook values and complete change reasons", () => {
    const after = structuredClone(before);
    const evidence = "source evidence ".repeat(1000) + "FINAL EVIDENCE";
    after.workbooks[0].revision = 2;
    after.workbooks[0].sheets[0].rows[0].values.status = "Confirmed";
    after.changes.push({ id: 1, workbookId: "w1", revision: 2, actor: "agent", at: "2026-09-11T09:00:00Z", sheetId: "proposed", rowId: "r1", column: "status", before: "Pending", after: "Confirmed", reason: "Received certificate", evidence });
    const diff = diffExcel(before, after);
    expect(diff.workbooks[0].before).toEqual(before.workbooks[0]);
    expect(diff.workbooks[0].after).toEqual(after.workbooks[0]);
    expect(renderExcelDiff(diff)).toContain("FINAL EVIDENCE");
    expect(diffExcel(after, after)).toMatchObject({ workbooks: [], changes: [], unchangedCount: 1 });
  });

  it("refuses incomplete snapshot evidence", async () => {
    const fake = fetchFake({ "/api/sandbox/snapshot": { workbooks: [] } });
    await expect(createExcelAdapter({ fetchImpl: fake.fetch }).snapshot()).rejects.toThrow("evidence is incomplete");
  });
});

describe("Excel tools", () => {
  it("reads the immutable original explicitly and sends atomic revisions, reasons and evidence on writes", async () => {
    const fake = fetchFake({ "/api/workbooks": { workbook: before.workbooks[0], computed: {} } });
    const tools = excelTools(createTwinHttp("excel", { baseUrl: "http://excel.test", token: "test-token", fetchImpl: fake.fetch }));
    await tools.find((t) => t.name === "read_workbook")!.run({ workbookId: "w 1", original: true });
    expect(fake.calls[0].url).toBe("http://excel.test/api/workbooks/w%201?original=1");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer test-token");
    const changes = [{ sheetId: "proposed", rowId: "r1", column: "status", value: "Confirmed" }];
    await tools.find((t) => t.name === "update_cells")!.run({ workbookId: "w1", revision: 1, changes, reason: "certificate", evidence: "message-3" });
    expect(fake.calls[1]).toMatchObject({ method: "PATCH", body: { revision: 1, changes, reason: "certificate", evidence: "message-3" } });
    await tools.find((t) => t.name === "add_row")!.run({ workbookId: "w1", revision: 2, sheetId: "proposed", values: { status: "Pending" }, reason: "new client", evidence: "message-4" });
    expect(fake.calls[2]).toMatchObject({ method: "POST", body: { revision: 2, sheetId: "proposed", values: { status: "Pending" }, reason: "new client", evidence: "message-4" } });
  });

  it("surfaces revision conflicts without retrying a stale edit", async () => {
    let calls = 0;
    const http = createTwinHttp("excel", { baseUrl: "http://excel.test", fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: "revision conflict" }), { status: 409 }); } });
    await expect(excelTools(http).find((t) => t.name === "update_cells")!.run({ workbookId: "w1", revision: 1, changes: [], reason: "test", evidence: "test" })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
