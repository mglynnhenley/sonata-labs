import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { parseArgs, type Args } from "./args";
import { checkToken } from "./auth";
import { err, rateLimited, toErrorResponse } from "./envelope";
import { evaluateChaos } from "./chaos";
import { getDb } from "../db";
import { getSelf, type SelfIdentity } from "../store/meta";
import { logAction, type ActionEntry } from "../audit";
import { setTeamId } from "../events/bus";

// Shared plumbing for /api/<method> handlers: args parsing, token auth, and
// envelope-shaped error translation. Keeps every method handler uniform.

export interface SlackCtx {
  db: Database;
  args: Args;
  self: SelfIdentity;
  method: string; // the Web API method name, e.g. 'chat.postMessage'
  httpMethod: string;
}

export type MethodHandler = (ctx: SlackCtx) => NextResponse | Promise<NextResponse>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handleSlack(
  req: Request,
  method: string,
  fn: MethodHandler,
): Promise<NextResponse> {
  try {
    const args = await parseArgs(req);
    const authErr = checkToken(req, args);
    if (authErr) return err(authErr);

    // Fault injection sits after auth (a bad token should always report as a
    // bad token) but before any handler work, so an injected failure means the
    // mutation genuinely did not happen.
    const verdict = evaluateChaos(method);
    if (verdict.delayMs > 0) await sleep(verdict.delayMs);
    if (verdict.error) {
      const { code, rateLimited: rl, retryAfterSec } = verdict.error;
      const res = rl ? rateLimited(retryAfterSec ?? 30) : err(code);
      res.headers.set("x-sandbox-injected-fault", code);
      return res;
    }

    const db = getDb();
    const self = getSelf(db);
    // Keep the event bus's team_id in step with the loaded workspace (it can
    // change across seed/sync/reset).
    setTeamId(self.teamId);
    return await fn({ db, args, self, method, httpMethod: req.method });
  } catch (e) {
    return toErrorResponse(e);
  }
}

/**
 * Run a mutation atomically: fn performs the workspace change, then the audit
 * row is written in the SAME transaction (audit.db is ATTACHed). The audit
 * entry is built from fn's result so summaries can reference it.
 */
export function runMutation<T>(
  db: Database,
  fn: () => T,
  buildEntry: (result: T) => ActionEntry,
): T {
  const tx = db.transaction(() => {
    const result = fn();
    logAction(db, buildEntry(result));
    return result;
  });
  return tx();
}
