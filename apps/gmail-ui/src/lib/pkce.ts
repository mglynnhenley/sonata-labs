import { createHash, randomBytes } from "node:crypto";

// PKCE (S256) generation for the UI's authorization requests. Duplicated per the
// twins' no-shared-package convention rather than importing from the API.

export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
