import { NextResponse } from "next/server";

// The Google-shaped error envelope. This is the exact wire shape
// googleads.googleapis.com returns, and a client reads
// `error.details[0].errors[0].errorCode` to decide what to do next — anything
// else and an agent sees "[object Object]" and gives up. One module owns it, and
// no route hand-builds a failure.

export interface GoogleAdsErrorItem {
  /** A one-key map, e.g. `{queryError: "UNRECOGNIZED_FIELD"}` — that is Google's oneof. */
  errorCode: Record<string, string>;
  message: string;
  trigger?: { stringValue?: string; int64Value?: string };
  location?: { fieldPathElements: Array<{ fieldName: string; index?: number }> };
}

export interface GoogleAdsFailureBody {
  error: {
    code: number;
    message: string;
    status: string;
    details: Array<{
      "@type": string;
      errors: GoogleAdsErrorItem[];
      requestId: string;
    }>;
  };
}

export class GoogleAdsError extends Error {
  httpStatus: number;
  errorCode: Record<string, string>;
  trigger?: string;
  fieldPath?: Array<{ fieldName: string; index?: number }>;

  constructor(
    httpStatus: number,
    errorCode: Record<string, string>,
    message: string,
    opts: { trigger?: string; fieldPath?: Array<{ fieldName: string; index?: number }> } = {},
  ) {
    super(message);
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.trigger = opts.trigger;
    this.fieldPath = opts.fieldPath;
  }

  /** The `errors[]` entry this error becomes inside a GoogleAdsFailure. */
  toItem(): GoogleAdsErrorItem {
    const item: GoogleAdsErrorItem = { errorCode: this.errorCode, message: this.message };
    if (this.trigger !== undefined) item.trigger = { stringValue: this.trigger };
    if (this.fieldPath) item.location = { fieldPathElements: this.fieldPath };
    return item;
  }
}

export function canonicalStatus(code: number): string {
  switch (code) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 501:
      return "UNIMPLEMENTED";
    default:
      return "INTERNAL";
  }
}

/**
 * Google's generic top-level wording. The specific message lives in
 * `details[0].errors[0].message` — that is exactly how the real API splits them,
 * and a client that reads only the top-level string learns nothing useful.
 */
export function genericMessage(code: number): string {
  switch (code) {
    case 400:
      return "Request contains an invalid argument.";
    case 401:
      return (
        "Request had invalid authentication credentials. Expected OAuth 2 access token, " +
        "login cookie or other valid authentication credential."
      );
    case 403:
      return "The caller does not have permission.";
    case 404:
      return "Requested entity was not found.";
    case 501:
      return "Operation is not implemented, or supported, or enabled.";
    default:
      return "Internal error encountered.";
  }
}

export interface ErrorContext {
  httpStatus: number;
  apiVersion: string;
  requestId: string;
  /** searchStream is a streaming method, so its failures are array-wrapped too. */
  stream?: boolean;
}

export function failureBody(
  items: GoogleAdsErrorItem[],
  ctx: Omit<ErrorContext, "stream">,
): GoogleAdsFailureBody {
  return {
    error: {
      code: ctx.httpStatus,
      message: genericMessage(ctx.httpStatus),
      status: canonicalStatus(ctx.httpStatus),
      details: [
        {
          "@type": `type.googleapis.com/google.ads.googleads.${ctx.apiVersion}.errors.GoogleAdsFailure`,
          errors: items,
          requestId: ctx.requestId,
        },
      ],
    },
  };
}

/**
 * The response a failure becomes. When `stream` is set the whole body is wrapped
 * in a top-level ARRAY, because searchStream streams its chunks and its errors
 * arrive the same way — a clone that returns a bare object here is the classic
 * bug, and a client parsing `body[0].error` gets undefined.
 */
export function errorResponse(items: GoogleAdsErrorItem[], ctx: ErrorContext): NextResponse {
  const body = failureBody(items, ctx);
  return NextResponse.json(ctx.stream ? [body] : body, { status: ctx.httpStatus });
}

/**
 * A path the Ads service never serves. It gets no GoogleAdsFailure detail
 * because the request never reached the Ads service at all — Google's API
 * gateway answers it.
 */
export function methodNotFound(): NextResponse {
  return NextResponse.json(
    { error: { code: 404, message: "Method not found.", status: "NOT_FOUND" } },
    { status: 404 },
  );
}

/** Translate anything thrown inside a route into the wire envelope. */
export function toErrorResponse(err: unknown, ctx: Omit<ErrorContext, "httpStatus">): NextResponse {
  if (err instanceof GoogleAdsError) {
    return errorResponse([err.toItem()], { ...ctx, httpStatus: err.httpStatus });
  }
  return errorResponse(
    [
      {
        errorCode: { internalError: "INTERNAL_ERROR" },
        message: err instanceof Error ? err.message : String(err),
      },
    ],
    { ...ctx, httpStatus: 500 },
  );
}

// --- throwables, used across the codebase -----------------------------------

/** A GAQL string the parser or the executor refused. Always points at `query`. */
export function queryError(code: string, message: string, trigger?: string): GoogleAdsError {
  return new GoogleAdsError(400, { queryError: code }, message, {
    trigger,
    fieldPath: [{ fieldName: "query" }],
  });
}

export function requestError(code: string, message: string): GoogleAdsError {
  return new GoogleAdsError(400, { requestError: code }, message);
}

/**
 * A well-formed resource name for a row that is not there. It is an HTTP 400
 * INVALID_ARGUMENT and not a 404 — the real API treats a missing mutate target
 * as a validation failure of the request body, and only the API gateway's
 * "Method not found." is a genuine 404.
 */
export function mutateResourceNotFound(resourceName: string): GoogleAdsError {
  return new GoogleAdsError(400, { mutateError: "RESOURCE_NOT_FOUND" }, "Resource was not found.", {
    trigger: resourceName,
  });
}

export function authError(code: string, message: string): GoogleAdsError {
  return new GoogleAdsError(401, { authenticationError: code }, message);
}
