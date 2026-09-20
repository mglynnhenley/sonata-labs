/** The focused Excel-style replica's shared workbook contract. */
export interface ExcelWorkbook {
  id: string;
  title: string;
  revision: number;
  sheets: ExcelSheet[];
}

export interface ExcelSheet {
  id: string;
  name: string;
  readOnly?: boolean;
  columns: Array<{ key: string; label: string; type: "text" | "number" }>;
  rows: Array<{ id: string; values: Record<string, string | number> }>;
}

/** A complete, attributable cell or row mutation from the workbook history. */
export interface ExcelChange {
  id: number;
  workbookId: string;
  revision: number;
  actor: string;
  at: string;
  sheetId: string;
  rowId: string;
  column: string;
  before: string | number | null;
  after: string | number | null;
  reason: string;
  evidence: string;
}
