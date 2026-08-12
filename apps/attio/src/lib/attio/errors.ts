import { NextResponse } from "next/server";

// Attio's error envelope. The four fields sit at the TOP LEVEL — not nested
// under `error` the way Google's does — and every Attio SDK reads `message` off
// them, so any other shape hands an agent an unreadable failure.
//
// Routes never build one of these by hand: they throw an AttioError and the
// wrapper in route-helpers translates it. The single returning helper below
// exists because two call sites answer before a handler runs (the 401 gate and
// the unmounted-path catch-all) and so have nothing to throw into.

export interface AttioErrorBody {
  status_code: number;
  type: string;
  code: string;
  message: string;
}

export class AttioError extends Error {
  statusCode: number;
  type: string;
  code: string;

  constructor(statusCode: number, message: string, code: string, type?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.type = type ?? defaultType(statusCode);
  }
}

// Attio's documented pairs: 404 is invalid_request_error/not_found, 429 is
// rate_limit_error/rate_limit_exceeded. This clone can only produce 400, 401,
// 404, 500 and 501, so the map covers exactly those.
function defaultType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status >= 500 && status !== 501) return "api_error";
  return "invalid_request_error";
}

export function errorResponse(status: number, message: string, code: string): NextResponse {
  const body: AttioErrorBody = {
    status_code: status,
    type: defaultType(status),
    code,
    message,
  };
  return NextResponse.json(body, { status });
}

/** 404. The caller supplies the whole sentence because Attio words it per resource. */
export const notFoundError = (message: string) => new AttioError(404, message, "not_found");

/** 400. `validation_type` is what the tasks and notes endpoints answer with. */
export const badRequestError = (message: string) =>
  new AttioError(400, message, "validation_type");

/**
 * 400 `filter_error` — the only code the records/query endpoint declares for a
 * rejected body. A client branching on `code` needs this and not validation_type.
 */
export const filterError = (message: string) => new AttioError(400, message, "filter_error");

/**
 * 400 `value_not_found` — Attio's code when a record write names a select option
 * that does not exist. Records create/update only; tasks and notes use the two
 * above.
 */
export const valueNotFoundError = (message: string) =>
  new AttioError(400, message, "value_not_found");

/**
 * 501. `not_implemented` is the SANDBOX's own code, not one of Attio's — the
 * vendor has no such member. It exists so a refused verb answers in Attio's
 * envelope rather than letting Next reply with a bodyless 405.
 */
export const notImplementedError = (message: string) =>
  new AttioError(501, message, "not_implemented");

export const unauthorizedResponse = (
  message = "Could not authenticate you with the credentials provided.",
) => errorResponse(401, message, "unauthorized");

/** Translate a thrown AttioError (or anything else) into a response. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AttioError) {
    return NextResponse.json(
      { status_code: err.statusCode, type: err.type, code: err.code, message: err.message },
      { status: err.statusCode },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(500, message, "internal_server_error");
}
