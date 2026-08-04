import type { Database } from "better-sqlite3";
import type { FileRow, SlackFile } from "../slack/types";

export interface InsertFileInput {
  id: string;
  user?: string | null;
  name?: string | null;
  title?: string | null;
  mimetype?: string | null;
  filetype?: string | null;
  size?: number;
  created?: number;
  urlPrivate?: string | null;
  permalink?: string | null;
  data?: Buffer | null; // NULL when over the sync cap (metadata only)
  rawJson: string;
  isSandboxCreated?: boolean;
}

export function insertFile(db: Database, f: InsertFileInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO files
       (id, user, name, title, mimetype, filetype, size, created, url_private, permalink, data, raw_json, is_sandbox_created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.id,
    f.user ?? null,
    f.name ?? null,
    f.title ?? null,
    f.mimetype ?? null,
    f.filetype ?? null,
    f.size ?? 0,
    f.created ?? 0,
    f.urlPrivate ?? null,
    f.permalink ?? null,
    f.data ?? null,
    f.rawJson,
    f.isSandboxCreated ? 1 : 0,
  );
}

export function getFile(db: Database, id: string): FileRow | undefined {
  return db.prepare("SELECT * FROM files WHERE id = ?").get(id) as FileRow | undefined;
}

export function listFiles(
  db: Database,
  opts: { channelId?: string | null; userId?: string | null; limit: number; offset: number },
): { rows: FileRow[]; total: number } {
  const clauses: string[] = ["1=1"];
  const params: unknown[] = [];
  if (opts.channelId) {
    clauses.push(
      "id IN (SELECT file_id FROM message_files WHERE channel_id = ?)",
    );
    params.push(opts.channelId);
  }
  if (opts.userId) {
    clauses.push("user = ?");
    params.push(opts.userId);
  }
  const where = clauses.join(" AND ");
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${where}`).get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(`SELECT * FROM files WHERE ${where} ORDER BY created DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit, opts.offset) as FileRow[];
  return { rows, total };
}

export function linkFileToMessage(
  db: Database,
  channelId: string,
  messageTs: string,
  fileId: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO message_files (channel_id, message_ts, file_id) VALUES (?, ?, ?)",
  ).run(channelId, messageTs, fileId);
}

export function getFilesForMessage(db: Database, channelId: string, messageTs: string): FileRow[] {
  return db
    .prepare(
      `SELECT f.* FROM files f
       JOIN message_files mf ON mf.file_id = f.id
       WHERE mf.channel_id = ? AND mf.message_ts = ?
       ORDER BY f.created`,
    )
    .all(channelId, messageTs) as FileRow[];
}

/** Shape a row into a files.info resource: raw_json + live columns. */
export function shapeFile(db: Database, row: FileRow): SlackFile {
  const base = JSON.parse(row.raw_json) as SlackFile;
  const channels = db
    .prepare("SELECT DISTINCT channel_id FROM message_files WHERE file_id = ?")
    .all(row.id) as Array<{ channel_id: string }>;
  return {
    ...base,
    id: row.id,
    name: row.name ?? base.name,
    title: row.title ?? base.title,
    mimetype: row.mimetype ?? base.mimetype,
    filetype: row.filetype ?? base.filetype,
    user: row.user ?? base.user,
    size: row.size || base.size,
    created: row.created || base.created,
    url_private: row.url_private ?? base.url_private,
    permalink: row.permalink ?? base.permalink,
    channels: channels.map((c) => c.channel_id),
  };
}
