import { NextResponse } from "next/server";

// The Docs v1 error envelope, in one file, used by every /v1 route.
//
// Docs v1 is a google.api-style service, not a legacy Discovery service. Its
// errors are `{error:{code,message,status}}` with NO `errors[]` array of
// {domain,reason} — copying the Calendar twin's envelope here would be a tell to
// any agent that has seen a real Docs 404. gaxios still reads
// `response.data.error.message`, so the SDK behaves identically either way; the
// difference is only visible to something reading the body, which is exactly who
// we are trying not to give a hint.

export interface DocsErrorBody {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

export class DocsError extends Error {
  code: number;
  status: string;

  constructor(code: number, message: string, status?: string) {
    super(message);
    this.code = code;
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

function errorBody(code: number, message: string, status?: string): DocsErrorBody {
  return { error: { code, message, status: status ?? defaultStatus(code) } };
}

export function errorResponse(code: number, message: string, status?: string): NextResponse {
  return NextResponse.json(errorBody(code, message, status), { status: code });
}

// Shorthands. The messages copy the vendor's exact wording, because agents
// string-match on them and a paraphrase changes their behaviour.
export const notFound = (msg = "Requested entity was not found.") =>
  errorResponse(404, msg, "NOT_FOUND");
export const badRequest = (msg: string, status = "INVALID_ARGUMENT") =>
  errorResponse(400, msg, status);
export const unauthorized = (
  msg = "Request had invalid authentication credentials. Expected OAuth 2 access token, " +
    "login cookie or other valid authentication credential. See " +
    "https://developers.google.com/identity/sign-in/web/devconsole-project.",
) => errorResponse(401, msg, "UNAUTHENTICATED");

// Throwable variants, for use inside mutation transactions and the pure edit
// code — which must fail without knowing anything about HTTP.
export const notFoundError = (msg = "Requested entity was not found.") =>
  new DocsError(404, msg, "NOT_FOUND");
export const badRequestError = (msg: string, status = "INVALID_ARGUMENT") =>
  new DocsError(400, msg, status);

/** Translate a thrown DocsError (or any error) into a response. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof DocsError) return errorResponse(err.code, err.message, err.status);
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(500, message, "INTERNAL");
}
