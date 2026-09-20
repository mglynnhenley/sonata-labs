import { timingSafeEqual } from "node:crypto";

type CredentialEnvironment = Readonly<Record<string, string | undefined>>;

/** Workplaces set a separate control secret; shared developer apps keep their existing token. */
export function controlToken(env: CredentialEnvironment = process.env): string {
  return env.SANDBOX_CONTROL_TOKEN || env.SANDBOX_TOKEN || "sandbox-token";
}

/** Control authentication is shared; each clone retains its own provider error envelope. */
export function authorizedControlRequest(req: Request, env: CredentialEnvironment = process.env): boolean {
  const query = new URL(req.url).searchParams;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = req.headers.get("x-sandbox-token") || bearer || query.get("access_token") || query.get("token");
  if (!supplied) return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(controlToken(env));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
