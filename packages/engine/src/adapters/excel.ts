import {
  resolveTwinApiUrl,
  type ExcelSnapshot,
  type ExcelDiff,
  type TwinAdapter,
} from "@sonata/core";
import { createTwinHttp, type TwinHttpOptions } from "../http";
import { projectTwinTrace } from "../project";
import { auditViaActivity, healthViaApi, resetViaApi } from "./shared";

export interface ExcelAdapterOptions extends Omit<TwinHttpOptions, "baseUrl"> {
  baseUrl?: string;
}

export function createExcelAdapter(opts: ExcelAdapterOptions = {}): TwinAdapter {
  const baseUrl = resolveTwinApiUrl("excel", process.env, { override: opts.baseUrl });
  const http = createTwinHttp("excel", { ...opts, baseUrl });
  return {
    name: "excel",
    baseUrl,
    health: () => healthViaApi(http, "excel"),
    async snapshot() {
      const state = await http.get<Omit<ExcelSnapshot, "twin">>("/api/sandbox/snapshot");
      if (!Array.isArray(state.workbooks) || !Array.isArray(state.changes)) {
        throw new Error("Excel snapshot omitted workbooks or change history; evidence is incomplete");
      }
      return { ...state, twin: "excel", capturedAt: state.capturedAt ?? Date.now() };
    },
    diff: (before, after) => diffExcel(before as ExcelSnapshot, after as ExcelSnapshot),
    renderDiff: (diff) => renderExcelDiff(diff as ExcelDiff),
    async inject(body) {
      throw new Error(`Excel does not support scripted beats (${body.twin}:${body.kind}); seed workbooks and deliver instructions through Gmail or Slack`);
    },
    async seed(spec) {
      await http.post("/api/sandbox/seed", {
        twin: "excel",
        seed: { workbooks: [], world: spec.world, nowISO: spec.clock.startISO, promoteToSnapshot: true },
      });
    },
    reset: () => resetViaApi(http, "episode reset"),
    auditSince: (sinceId) => auditViaActivity(http, "excel", sinceId, { sinceId }),
    projectTrace: (trace) => projectTwinTrace(trace, "excel"),
  };
}

/** Whole changed workbook versions preserve original values, formulas and new rows. */
export function diffExcel(before: ExcelSnapshot, after: ExcelSnapshot): ExcelDiff {
  const previous = new Map(before.workbooks.map((book) => [book.id, book]));
  const current = new Map(after.workbooks.map((book) => [book.id, book]));
  const workbooks: ExcelDiff["workbooks"] = [];
  let unchangedCount = 0;
  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const a = previous.get(id);
    const b = current.get(id);
    if (JSON.stringify(a) === JSON.stringify(b)) unchangedCount++;
    else workbooks.push({ id, ...(a ? { before: a } : {}), ...(b ? { after: b } : {}) });
  }
  const known = new Set(before.changes.map((change) => `${change.workbookId}:${change.id}`));
  return {
    twin: "excel",
    workbooks,
    changes: after.changes.filter((change) => !known.has(`${change.workbookId}:${change.id}`)),
    unchangedCount,
  };
}

export function renderExcelDiff(diff: ExcelDiff): string {
  return [
    "Complete Excel workbook changes (before = original; after = proposed/current).",
    JSON.stringify({ workbooks: diff.workbooks, changes: diff.changes }),
    `${diff.unchangedCount} workbook(s) untouched`,
  ].join("\n");
}
