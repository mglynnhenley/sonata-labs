CREATE TABLE IF NOT EXISTS workbooks (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 revision INTEGER NOT NULL,
 original_json TEXT NOT NULL,
 working_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 workbook_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 actor TEXT NOT NULL,
 at TEXT NOT NULL,
 sheet_id TEXT NOT NULL,
 row_id TEXT NOT NULL,
 column_key TEXT NOT NULL,
 before_json TEXT NOT NULL,
 after_json TEXT NOT NULL,
 reason TEXT NOT NULL,
 evidence TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_workbook ON changes(workbook_id,id);
