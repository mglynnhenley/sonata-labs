// Slack Web API argument parsing. The SDK sends application/x-www-form-urlencoded
// for simple calls and switches to JSON when args contain rich values (blocks,
// attachments); tools also pass args as query params on GET. Merge all three
// into one bag (body wins over query) and coerce lazily via the typed getters —
// form-encoded values arrive as strings ("true", "42").

export type Args = Record<string, unknown>;

export async function parseArgs(req: Request): Promise<Args> {
  const out: Args = {};
  const url = new URL(req.url);
  for (const [k, v] of url.searchParams) out[k] = v;

  if (req.method === "POST") {
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("application/json")) {
      try {
        const body = (await req.json()) as unknown;
        if (body && typeof body === "object") Object.assign(out, body);
      } catch {
        // empty/malformed body — fall through with query args only
      }
    } else if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      for (const [k, v] of form) out[k] = v; // File values kept as-is (uploads)
    } else {
      // Default (form-urlencoded, or missing content type): parse as urlencoded.
      const text = await req.text();
      if (text) for (const [k, v] of new URLSearchParams(text)) out[k] = v;
    }
  }
  return out;
}

export function str(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : String(v);
}

export function num(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return undefined;
}

/** Clamp a limit arg to Slack's semantics: default when absent, hard cap. */
export function clampLimit(args: Args, dflt: number, cap: number): number {
  const n = num(args, "limit");
  if (n === undefined || n <= 0) return dflt;
  return Math.min(Math.floor(n), cap);
}
