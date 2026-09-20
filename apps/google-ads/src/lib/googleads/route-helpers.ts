import { NextResponse } from "next/server";
import type { Database } from "better-sqlite3";
import { checkAuth } from "./auth";
import { authError, errorResponse, methodNotFound, requestError, toErrorResponse } from "./errors";
import { newRequestId } from "./ids";
import { getDb } from "../db";
import { getCustomer, getOnlyCustomer, type CustomerRow } from "../store/customers";
import { logAction, type ActionEntry } from "../audit";

// The wrapper every provider route uses. Nothing in a route file touches getDb()
// or checkAuth() directly, so auth, customer resolution and the error envelope
// cannot drift apart between one endpoint and the next.
//
// The API version is threaded through rather than pinned because
// googleads.googleapis.com serves many versions at once, and pinning one would
// 404 an agent whose docs name a different one. Threading it also means the
// `@type` in an error names the version the caller actually asked for.

export interface GoogleAdsCtx {
  db: Database;
  customer: CustomerRow;
  apiVersion: string;
  requestId: string;
  endpoint: string;
}

export interface HandleOptions {
  apiVersion: string;
  /** Present on the routes that carry a customer id in the path. */
  customerId?: string;
  /** searchStream: successes and failures alike are top-level arrays. */
  stream?: boolean;
}

export async function handleGoogleAds(
  req: Request,
  opts: HandleOptions,
  fn: (ctx: GoogleAdsCtx) => Promise<NextResponse> | NextResponse,
): Promise<NextResponse> {
  const requestId = newRequestId();
  // A path segment that is not a version never reached the Ads service at all,
  // so it gets the gateway's bare 404 and no GoogleAdsFailure.
  if (!/^v\d+$/.test(opts.apiVersion)) return methodNotFound();

  const ctx = { apiVersion: opts.apiVersion, requestId, stream: opts.stream };

  const denied = checkAuth(req);
  if (denied) return errorResponse([denied.toItem()], { ...ctx, httpStatus: denied.httpStatus });

  try {
    const db = getDb();
    const customer = resolveCustomer(db, opts.customerId);
    return await fn({
      db,
      customer,
      apiVersion: opts.apiVersion,
      requestId,
      endpoint: new URL(req.url).pathname,
    });
  } catch (err) {
    return toErrorResponse(err, ctx);
  }
}

/**
 * Both failures here are 401s and not 404s, which surprises everyone: Google
 * puts CLIENT_CUSTOMER_ID_INVALID and CUSTOMER_NOT_FOUND in AuthenticationError,
 * because the customer id is part of who you are calling as. Dashes are NOT
 * stripped — pasting `480-293-8157` out of the Google Ads UI into the path is a
 * real footgun, and hiding it would teach an agent that it works.
 */
function resolveCustomer(db: Database, raw: string | undefined): CustomerRow {
  if (raw === undefined) {
    // The one route with no customer id in its path is the one that exists to
    // hand the caller that id, so it wants the sandbox's single account.
    const only = getOnlyCustomer(db);
    if (!only) {
      throw requestError(
        "RESOURCE_NOT_FOUND",
        "This sandbox holds no advertiser account yet — run `npm run seed` or POST /api/sandbox/seed.",
      );
    }
    return only;
  }
  if (!/^\d+$/.test(raw)) {
    throw authError("CLIENT_CUSTOMER_ID_INVALID", "Client customer ID is not a number.");
  }
  const row = getCustomer(db, raw);
  if (!row) {
    throw authError("CUSTOMER_NOT_FOUND", "No account found for the customer ID provided.");
  }
  return row;
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/**
 * Run a mutation atomically: fn performs the change, then its audit rows are
 * written in the SAME transaction (audit.db is ATTACHed). buildEntry may return
 * several entries so one mutate batch writes one row per operation — and a
 * batch that rolls back leaves none of them.
 */
export function runMutation<T>(
  db: Database,
  fn: () => T,
  buildEntry: (result: T) => ActionEntry | ActionEntry[],
): T {
  const tx = db.transaction(() => {
    const result = fn();
    const entries = buildEntry(result);
    for (const entry of Array.isArray(entries) ? entries : [entries]) logAction(db, entry);
    return result;
  });
  return tx();
}
