import { NextResponse } from "next/server";

// The LinkedIn error envelope, in one file, used by every provider route.
//
// LinkedIn answers `{status, serviceErrorCode, code?, message}` — flat, with no
// nesting, unlike Google's `{error:{...}}`. Agents string-match on `message`, so
// most of the wording below is copied from LinkedIn's published error tables
// rather than invented. NOT all of it: `missingFieldError` appends a field name
// the real message does not carry, and `fieldTooLongError`, `versionDeprecated`,
// the two version-header messages in auth.ts and the post 404 sentence are the
// clone's own. AGENTS.md lists all of them, so nobody "corrects" the copied ones
// into matching the invented ones.
//
// Almost everything here THROWS rather than returning a response, because every
// provider route runs inside handleLinkedIn's try/catch and validation happens
// several frames down from the handler. The three exceptions are the auth and
// header gates, which run before that catch exists.

export interface LinkedInErrorBody {
  status: number;
  serviceErrorCode: number;
  code?: string;
  message: string;
}

export class LinkedInError extends Error {
  status: number;
  serviceErrorCode: number;
  code?: string;

  constructor(status: number, message: string, code?: string, serviceErrorCode = 0) {
    super(message);
    this.status = status;
    this.code = code;
    this.serviceErrorCode = serviceErrorCode;
  }
}

export function errorResponse(
  status: number,
  message: string,
  code?: string,
  serviceErrorCode = 0,
): NextResponse {
  const body: LinkedInErrorBody =
    code === undefined
      ? { status, serviceErrorCode, message }
      : { status, serviceErrorCode, code, message };
  return NextResponse.json(body, { status });
}

// --- the gates, which answer before handleLinkedIn's catch exists ------------

/** No bearer at all. LinkedIn's documented wording, spelling and all. */
export const emptyToken = () => errorResponse(401, "Empty oauth2_access_token", undefined, 401);

/** A bearer that is not ours — a different answer from emptyToken() on purpose,
 *  because an agent tells "I forgot the header" from "my token is wrong" here
 *  and retries the two differently. */
export const invalidToken = () =>
  errorResponse(401, "Invalid access token", "INVALID_ACCESS_TOKEN", 65600);

export const versionDeprecated = (version: string) =>
  errorResponse(426, `LinkedIn-Version ${version} is no longer supported.`, "VERSION_DEPRECATED");

// --- everything a route or a validator throws --------------------------------

export const notFoundError = (message: string) => new LinkedInError(404, message, "NOT_FOUND");

export const badRequestError = (message: string, code = "INVALID_VALUE_FOR_FIELD") =>
  new LinkedInError(400, message, code);

export const missingFieldError = (field: string) =>
  new LinkedInError(400, `A required field is missing: ${field}`, "MISSING_FIELD");

export const blankFieldError = (field: string) =>
  new LinkedInError(400, `${field} cannot be blank.`, "INVALID_VALUE_BLANK_FIELD");

export const invalidValueError = (field: string, value: string) =>
  new LinkedInError(400, `${field} cannot be set to ${value}.`, "INVALID_VALUE_FOR_FIELD");

export const invalidUrnTypeError = (field: string, value: string, urnType: string) =>
  new LinkedInError(400, `${field} value ${value} must be a ${urnType} URN.`, "INVALID_URN_TYPE");

export const invalidUrnIdError = () =>
  new LinkedInError(400, "The URN ID provided is invalid.", "INVALID_URN_ID");

export const fieldTooLongError = (field: string) =>
  new LinkedInError(400, `${field} length exceeds the allowed maximum.`, "FIELD_LENGTH_TOO_LONG");

export const accessDeniedError = (message: string) =>
  new LinkedInError(403, message, "ACCESS_DENIED", 100);

/**
 * LinkedIn's literal refusal when a request body carries a field the caller may
 * not set. Reproduced verbatim, down to the "Data Processing Exception", because
 * it is the one error message in this API an agent is most likely to recognise.
 */
export const unpermittedFieldsError = (paths: string[]) =>
  accessDeniedError(
    "Unpermitted fields present in REQUEST_BODY: Data Processing Exception while " +
      `processing fields [${paths.join(", ")}]`,
  );

/** Translate a thrown LinkedInError (or anything else) into a response. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof LinkedInError) {
    return errorResponse(err.status, err.message, err.code, err.serviceErrorCode);
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(500, message, "INTERNAL_SERVER_ERROR");
}
