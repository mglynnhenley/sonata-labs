import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// Persistence for the artifacts the dashboard creates: worlds, scenario drafts,
// episodes and runs. All four are JSON documents by nature — a WorldSeed, an
// EpisodeSpec and an EpisodeRun are defined in @sonata/core and are read whole
// or not at all — so they live in one document table rather than four relational
// ones that would only ever be SELECT *'d.
//
// The table name is deliberately its own: apps/platform/src/lib/db.ts owns the
// relational side (twin supervision, settings) in the same file, and a document
// table cannot collide with it. This module is the single seam to move if these
// documents later want columns.

export const DATA_DIR = path.resolve(process.cwd(), "data");
export const PLATFORM_DB_PATH = process.env.SONATA_PLATFORM_DB ?? path.join(DATA_DIR, "platform.db");

const DDL = `
CREATE TABLE IF NOT EXISTS sonata_docs (
  kind       TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  json       TEXT    NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_sonata_docs_kind_created ON sonata_docs (kind, created_at DESC);
`;

/** Document families. `draft` is swept; the other three are permanent. */
export type DocKind = "world" | "draft" | "episode" | "run";

type Db = Database.Database;

const g = globalThis as unknown as { __sonataPlatformDocs?: Db };

function open(): Db {
  const dir = path.dirname(PLATFORM_DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(PLATFORM_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(DDL);
  return db;
}

function docsDb(): Db {
  if (!g.__sonataPlatformDocs) g.__sonataPlatformDocs = open();
  return g.__sonataPlatformDocs;
}

interface Row {
  json: string;
  created_at: number;
}

export function putDoc<T extends object>(kind: DocKind, id: string, value: T): T {
  const now = Date.now();
  docsDb()
    .prepare(
      `INSERT INTO sonata_docs (kind, id, created_at, updated_at, json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    )
    .run(kind, id, now, now, JSON.stringify(value));
  return value;
}

export function getDoc<T>(kind: DocKind, id: string): T | undefined {
  const row = docsDb()
    .prepare<[DocKind, string], Row>("SELECT json, created_at FROM sonata_docs WHERE kind = ? AND id = ?")
    .get(kind, id);
  return row ? (JSON.parse(row.json) as T) : undefined;
}

/** Newest first — every list in the dashboard is reverse-chronological. */
export function listDocs<T>(kind: DocKind, limit = 200): T[] {
  const rows = docsDb()
    .prepare<[DocKind, number], Row>(
      "SELECT json, created_at FROM sonata_docs WHERE kind = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(kind, limit);
  return rows.map((row) => JSON.parse(row.json) as T);
}

export function deleteDoc(kind: DocKind, id: string): boolean {
  return docsDb().prepare("DELETE FROM sonata_docs WHERE kind = ? AND id = ?").run(kind, id).changes > 0;
}

export function countDocs(kind: DocKind): number {
  const row = docsDb()
    .prepare<[DocKind], { n: number }>("SELECT COUNT(*) AS n FROM sonata_docs WHERE kind = ?")
    .get(kind);
  return row?.n ?? 0;
}

/**
 * Drop drafts nobody committed. A preview costs a model call, so drafts are kept
 * long enough to walk away from the modal and come back — but not forever.
 */
export function sweepDrafts(maxAgeMs = 24 * 60 * 60 * 1000): number {
  return docsDb()
    .prepare("DELETE FROM sonata_docs WHERE kind = 'draft' AND updated_at < ?")
    .run(Date.now() - maxAgeMs).changes;
}

/** Short, sortable, readable ids: `run_lq3f8k_7a2c`. */
export function newId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${stamp}_${rand}`;
}
