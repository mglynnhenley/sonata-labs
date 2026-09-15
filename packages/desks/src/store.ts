import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeskEvent, DeskStore } from './types';

/** A run-local ledger. Domain state and the agent/world distinction survive snapshots. */
export class SqliteDeskStore implements DeskStore {
  private db: Database.Database;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at TEXT NOT NULL,
        actor TEXT NOT NULL CHECK(actor IN ('agent','world')),kind TEXT NOT NULL,data TEXT NOT NULL);`);
  }
  get<T = Record<string, unknown>>(id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE id=?').get(id) as { data: string } | undefined;
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }
  put(id: string, data: unknown): void {
    this.db.prepare('INSERT INTO records(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(id, JSON.stringify(data));
  }
  list(prefix = ''): Array<{ id: string; data: Record<string, unknown> }> {
    return (this.db.prepare('SELECT id,data FROM records WHERE substr(id,1,?)=? ORDER BY id')
      .all(prefix.length, prefix) as Array<{ id: string; data: string }>).map(row => ({ id: String(row.id), data: JSON.parse(String(row.data)) }));
  }
  event(at: string, actor: 'agent' | 'world', kind: string, data: Record<string, unknown>): number {
    return Number(this.db.prepare('INSERT INTO events(at,actor,kind,data) VALUES(?,?,?,?)')
      .run(at, actor, kind, JSON.stringify(data)).lastInsertRowid);
  }
  events(): DeskEvent[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY id').all() as Array<{ id: number; at: string; actor: DeskEvent['actor']; kind: string; data: string }>).map(row => ({
      id: Number(row.id), at: String(row.at), actor: row.actor as DeskEvent['actor'],
      kind: String(row.kind), data: JSON.parse(String(row.data)),
    }));
  }
  transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = body(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  snapshot(target: string): void {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(this.path, target);
  }
  restore(snapshot: string): void {
    this.db.close();
    copyFileSync(snapshot, this.path);
    this.db = new Database(this.path);
  }
  close(): void { this.db.close(); }
}
