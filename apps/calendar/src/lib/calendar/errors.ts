import { NextResponse } from "next/server";

// Google-shaped error envelope. gaxios (used by the googleapis SDK) reads
// `response.data.error.message`, so every route must return this exact shape or
// agents get useless "[object Object]" errors. One helper, used everywhere.

export interface CalendarErrorItem {
  message: string;
  domain: string;
  reason: string;
  location?: string;
  locationType?: string;
}

export interface CalendarErrorBody {
  error: {
    code: number;
    message: string;
    errors: CalendarErrorItem[];
    status?: string;
  };
}

export class CalendarError extends Error {
  code: number;
  reason: string;
  status?: string;

  constructor(code: number, message: string, reason = "failedPrecondition", status?: string) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.status = status ?? defaultStatus(code);
  }
}

function defaultStatus(code: number): string {
  switch (code) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "ALREADY_EXISTS";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 501:
      return "UNIMPLEMENTED";
    default:
      return "FAILED_PRECONDITION";
  }
}

export function errorBody(
  code: number,
  message: string,
  reason = "failedPrecondition",
  status?: string,
): CalendarErrorBody {
  return {
    error: {
      code,
      message,
      errors: [{ message, domain: "global", reason }],
      status: status ?? defaultStatus(code),
    },
  };
}

export function errorResponse(
  code: number,
  message: string,
  reason?: string,
  status?: string,
): NextResponse {
  return NextResponse.json(errorBody(code, message, reason, status), { status: code });
}

// Common shorthands. Messages match Google's wording so agents that string-match
// on them behave the same against the sandbox.
export const notFound = (msg = "Not Found") => errorResponse(404, msg, "notFound", "NOT_FOUND");
export const badRequest = (msg: string, reason = "badRequest") =>
  errorResponse(400, msg, reason, "INVALID_ARGUMENT");
export const unauthorized = (msg = "Invalid Credentials") =>
  errorResponse(401, msg, "authError", "UNAUTHENTICATED");
export const notImplemented = (msg = "Not implemented in sandbox.") =>
  errorResponse(501, msg, "notImplemented", "UNIMPLEMENTED");

// Throwable variants (for use inside mutation transactions / store code).
export const notFoundError = (msg = "Not Found") =>
  new CalendarError(404, msg, "notFound", "NOT_FOUND");
export const badRequestError = (msg: string, reason = "badRequest") =>
  new CalendarError(400, msg, reason, "INVALID_ARGUMENT");

/** Translate a thrown CalendarError (or any error) into a response. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof CalendarError) {
    return errorResponse(err.code, err.message, err.reason, err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(500, message, "backendError", "INTERNAL");
}
