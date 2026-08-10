import { createHash } from "node:crypto";

// PKCE (RFC 7636), S256 only. Required on every authorize request — including the
// confidential UI client — because it is the OAuth 2.1 default and removes any
// public-vs-confidential special-casing. `plain` is deliberately unsupported.

/** base64url(SHA-256(verifier)) — the S256 transform. */
export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Constant-time-ish compare of the S256 hash of `verifier` against `challenge`. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = s256Challenge(verifier);
  // Lengths are fixed (43 chars) so a plain compare leaks nothing useful here,
  // but timing-safe keeps the "doing OAuth right" claim honest.
  if (computed.length !== challenge.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ challenge.charCodeAt(i);
  return diff === 0;
}

/** RFC 7636 §4.1: verifier is 43–128 chars of the unreserved set. */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}
