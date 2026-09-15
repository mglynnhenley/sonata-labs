import type { TwinHttp } from "../http";
import { fn, str, type EngineTool, type ToolInput } from "./types";

const valueSchema = { anyOf: [{ type: "string" }, { type: "number" }] };
const workbookId = { type: "string", description: "Workbook id returned by list_workbooks." };
const mutationProperties = {
  workbookId,
  revision: { type: "integer", minimum: 1, description: "Current revision from read_workbook. A stale revision returns 409; reread before retrying." },
  reason: { type: "string", minLength: 1, description: "Why these proposed values are justified." },
  evidence: { type: "string", minLength: 1, description: "Source message/document and supporting evidence, or an explicit statement that evidence is missing." },
};

export function excelTools(http: TwinHttp): EngineTool[] {
  const path = (input: ToolInput) => `/api/workbooks/${encodeURIComponent(str(input.workbookId))}`;
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], isMutation: boolean, run: EngineTool["run"]): EngineTool => ({
    name, twin: "excel", isMutation,
    def: fn(name, description, { type: "object", properties, required, additionalProperties: false }),
    run,
  });
  return [
    tool("list_workbooks", "List workbooks in the focused Excel-style replica.", {}, [], false,
      () => http.get("/api/workbooks")),
    tool("read_workbook", "Read all sheets, raw cell values/formulas and computed values. original=true reads the immutable starting workbook; false reads the proposed/current workbook. Read before editing.",
      { workbookId, original: { type: "boolean", description: "True for the immutable original; default false for proposed/current values." } }, ["workbookId"], false,
      (input) => http.get(`${path(input)}${input.original === true ? "?original=1" : ""}`)),
    tool("read_history", "Read the complete workbook change history, including original and proposed values, actor, reason and source evidence.",
      { workbookId }, ["workbookId"], false,
      (input) => http.get(`${path(input)}/history`)),
    tool("update_cells", "Atomically update cells in the proposed/current workbook. Original sheets stay read-only. Every change records its original and proposed value, reason and evidence. Revision conflicts reject the whole batch. Returns the new revision and the applied changes, not the workbook; read_workbook shows current values.",
      { ...mutationProperties, changes: { type: "array", minItems: 1, items: { type: "object", properties: { sheetId: { type: "string" }, rowId: { type: "string" }, column: { type: "string" }, value: valueSchema }, required: ["sheetId", "rowId", "column", "value"], additionalProperties: false } } },
      ["workbookId", "revision", "changes", "reason", "evidence"], true,
      (input) => http.patch(`${path(input)}/cells`, { revision: input.revision, changes: input.changes, reason: input.reason, evidence: input.evidence })),
    tool("add_row", "Add a row to an editable proposed/current sheet with an audit reason and source evidence. Use column keys from read_workbook; original sheets stay read-only. Returns the new revision and the added values, not the workbook.",
      { ...mutationProperties, sheetId: { type: "string" }, values: { type: "object", additionalProperties: valueSchema } },
      ["workbookId", "revision", "sheetId", "values", "reason", "evidence"], true,
      (input) => http.post(`${path(input)}/rows`, { revision: input.revision, sheetId: input.sheetId, values: input.values, reason: input.reason, evidence: input.evidence })),
  ];
}
