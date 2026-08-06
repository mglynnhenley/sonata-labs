import pg from "pg";

// The one connection to Postgres. This is the product's own state — worlds,
// scenarios, runs, sessions, settings — and nothing else. The nine twin
// databases stay on SQLite on purpose: a twin reset is one `copyFileSync` of a
// snapshot file, which is why every run starts from an identical world and why
// two runs are comparable at all. Postgres has no cheap equivalent, so the
// clones keep their files and this keeps the record.
//
// `pg` and hand-written SQL rather than an ORM: the schema is eight tables that
// were already hand-written SQL, and a query builder would buy nothing but a
// codegen step to keep in sync.

// Node's int8 (BIGINT) arrives as a string by default, because a 64-bit integer
// does not always fit a double. Every BIGINT in this schema is either a count or
// an epoch in milliseconds — an epoch stays under 2^53 until the year 287396 —
// so parsing them as numbers is safe and is what every caller's `number` type
// already assumes. Without this, `startedAt` would come back as "1754400000000"
// and every date on the dashboard would render as an invalid one.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

const MISSING = [
  "DATABASE_URL is not set.",
  "",
  "Sonata keeps its own state (worlds, scenarios, runs, sessions, settings) in",
  "Postgres. Point DATABASE_URL at any Postgres and run `npm run db:migrate -w",
  "apps/platform`.",
  "",
  "  local docker:  postgres://sonata:sonata@127.0.0.1:55432/sonata",
  "  Supabase:      the connection string under Project Settings → Database",
  "",
  "Put it in .env at the repo root, beside OPENROUTER_API_KEY.",
].join("\n");

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error(MISSING);
  return url;
}

// Supabase serves a certificate its own pooler signs, and the default Node trust
// store does not carry it. Verifying it would need the project's CA bundle
// shipped alongside the app; not verifying it on a connection that is still
// encrypted is the trade every Supabase client makes. Local Postgres speaks no
// TLS at all, so it is opt-in by hostname rather than always on.
function ssl(url: string): pg.PoolConfig["ssl"] {
  if (/\bsslmode=disable\b/.test(url)) return false;
  return /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined;
}

// Next's dev server re-evaluates modules on every edit; without the singleton
// each reload would open a second pool and leak every socket in the first.
const g = globalThis as unknown as { __sonataPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!g.__sonataPool) {
    const url = databaseUrl();
    const config: pg.PoolConfig = {
      connectionString: url,
      // Small on purpose. Supabase's free tier allows 60 connections across
      // everything, and this app's load is a dashboard poll every two seconds —
      // a pool sized for throughput it does not have would just exhaust the
      // project's budget from one dev machine.
      max: 10,
      idleTimeoutMillis: 30_000,
    };
    const tls = ssl(url);
    if (tls !== undefined) config.ssl = tls;
    const created = new pg.Pool(config);
    // An idle client dropped by the server (Supabase closes them, and so does a
    // laptop waking up) emits 'error' on the pool. Unhandled, that is an
    // uncaught exception that takes the dev server down; the pool has already
    // discarded the client by the time this runs, so noting it is the whole job.
    created.on("error", (err) => {
      console.warn("[sonata] idle postgres client dropped:", err.message);
    });
    g.__sonataPool = created;
  }
  return g.__sonataPool;
}

/** One statement, one round trip. */
export async function query<R extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<pg.QueryResult<R>> {
  return pool().query<R>(text, values as unknown[]);
}

/** The single row a lookup by primary key expects, or null. */
export async function queryOne<R extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<R | null> {
  const result = await query<R>(text, values);
  return result.rows[0] ?? null;
}

export async function queryAll<R extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<R[]> {
  return (await query<R>(text, values)).rows;
}

/** Rows a write touched — `changes` under the old driver. */
export async function execute(text: string, values: readonly unknown[] = []): Promise<number> {
  return (await query(text, values)).rowCount ?? 0;
}

/**
 * A transaction on one checked-out client.
 *
 * The pool hands a different connection to every query, so BEGIN and COMMIT sent
 * through `query` would land on two unrelated sockets and the transaction would
 * silently not be one.
 */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Drops the pool. For CLIs, which otherwise hang on an open socket. */
export async function closePool(): Promise<void> {
  const open = g.__sonataPool;
  if (!open) return;
  g.__sonataPool = undefined;
  await open.end();
}
