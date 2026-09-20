# Excel-style workbook replica

A local spreadsheet surface for Sonata's reporting-workflow pilot. The supplied institution workbook is the starting state; agents edit a working copy while the original and a sourced change history remain available.

Start with `npm run dev:excel` from the repository root. UI and API share port 3950. `npm run db:init -w apps/excel` creates empty databases safely. The platform's normal world seeder loads populated fixtures; it does not require a model call.

Supported: multiple workbooks/sheets, text and numeric cells, filtering and sorting the visible rows, cell edits, adding rows, original comparison, revision conflict detection, and values-only CSV export. Basic formulas support arithmetic, cell/range references (including other sheets), SUM, COUNT, AVERAGE, MIN and MAX. Unsupported formulas display errors; formulas are never executed as JavaScript.

This is a focused replica, not Microsoft Excel or a Microsoft Graph-compatible API. Native XLSX import/export, Excel's full formula engine, formatting and macros are not implemented. CSV is a values-only export: type metadata, formula expressions and history stay in the workbook; an external spreadsheet may infer its own CSV types. The pilot does not validate tax law, authority XML or submissions.

## Shared data path

- Provider tools: `/api/workbooks`, `/api/workbooks/:id`, `/history`, PATCH `/cells`, POST `/rows`, GET `/export?sheetId=…`.
- Browser: the same operations under `/api/ui/workbooks`, calling the same store. Cross-origin browser access is rejected. UI edits are attributed to `human`; tools are attributed to `agent`.
- Control plane: `/api/sandbox/seed`, `/reset`, `/snapshot`, and `/api/activity?sinceId=…`.
- Provider routes require `Authorization: Bearer <SANDBOX_TOKEN>` (local default `sandbox-token`). Control routes require `SANDBOX_CONTROL_TOKEN`, falling back to the provider token only for shared developer apps. Per-run workplaces set distinct credentials. The browser never receives either token.
- Edits require the last read revision, a reason and an evidence/source reference. A stale revision returns 409 with no writes. A bad cell rejects the whole batch.

SQLite `working.db` holds the original/working workbook and review history. Mutations and agent audit entries commit in one transaction using attached `audit.db`. Human edits and world seeding stay outside the agent audit. Reset copies `snapshot.db` over `working.db`; the separate agent audit survives. `EXCEL_DATA_DIR` isolates test databases.

Run `npm run test -w apps/excel` and `npm run typecheck -w apps/excel`. Browser checks should exercise the real routes: save/reload, immutable original, formula results, and review history. Use isolated data for test edits.
