// base64url everywhere. Gmail uses unpadded base64url for `raw`, `body.data`,
// and attachment `data`. Node's Buffer 'base64url' produces unpadded output and
// decodes both padded and unpadded / standard-or-url input, which matches
// Gmail's tolerance. Using standard base64 here breaks agents silently.

export function b64urlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

export function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export function b64urlDecodeToString(input: string): string {
  return b64urlDecode(input).toString("utf8");
}
