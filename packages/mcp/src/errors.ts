import { TwinHttpError } from "@sonata/engine/http";
import { START_COMMAND, type ServedTwin } from "./config";

// What the agent reads when a twin will not answer.
//
// A connector's failure messages are its real documentation: the user is inside
// their own agent, not inside our logs, and the only thing that reaches them is
// the text of a tool result. So every failure names the twin, the URL it tried,
// and the one command that fixes it — and never a stack trace, which tells an
// agent nothing it can act on and burns a thousand tokens saying so.

/**
 * The cause chain, flattened.
 *
 * Node buries ECONNREFUSED two levels below "fetch failed", and when a host
 * resolves to both ::1 and 127.0.0.1 it buries it inside an AggregateError whose
 * own message is empty — which is exactly the case that matters here, because
 * "localhost" is what every default URL says.
 */
function rootCause(err: unknown): string {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const nested = current.cause;
    const aggregated =
      current instanceof AggregateError
        ? (current.errors as unknown[]).find((e): e is Error => e instanceof Error)
        : undefined;
    if (nested !== undefined) current = nested;
    else if (aggregated) current = aggregated;
    else break;
  }
  if (current instanceof Error) return current.message;
  return current === undefined ? "" : String(current);
}

function isUnreachable(err: unknown): boolean {
  const text = `${err instanceof Error ? err.message : String(err)} ${rootCause(err)}`;
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|socket hang up/i.test(text);
}

function isTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError";
}

/**
 * A one-paragraph explanation of why a twin call failed, addressed to the agent.
 *
 * The four cases are the four things that actually go wrong: nothing is running,
 * something is running but slow, the token is wrong, or the twin answered with an
 * error of its own (which is the twin's own words, and worth passing through).
 */
export function twinFailure(twin: ServedTwin, baseUrl: string, err: unknown): string {
  const start = `Start it from the repo root with: ${START_COMMAND[twin]}`;

  if (err instanceof TwinHttpError) {
    if (err.status === 401 || err.status === 403) {
      return (
        `The Sonata ${twin} twin at ${baseUrl} rejected the token (HTTP ${err.status}). ` +
        `Set SONATA_TOKEN to the same value the twin runs with (SANDBOX_TOKEN, default ` +
        `"sandbox-token") and reconnect.`
      );
    }
    if (err.status === 404) {
      return (
        `The Sonata ${twin} twin at ${baseUrl} has no such route (HTTP 404). This usually means ` +
        `the id in the call does not exist — list first, then act on an id from the list.`
      );
    }
    return `The Sonata ${twin} twin at ${baseUrl} answered HTTP ${err.status}: ${err.body.slice(0, 300)}`;
  }

  if (isTimeout(err)) {
    return (
      `The Sonata ${twin} twin at ${baseUrl} did not answer in time. It may still be compiling ` +
      `its first request — wait a few seconds and try again. If it is not running: ${start}`
    );
  }

  if (isUnreachable(err)) {
    const cause = rootCause(err);
    return (
      `The Sonata ${twin} twin is not running at ${baseUrl}. ${start} ` +
      `Or point this connector elsewhere with SONATA_${twin.toUpperCase()}_URL.` +
      (cause ? ` (${cause})` : "")
    );
  }

  return `The Sonata ${twin} twin call failed: ${err instanceof Error ? err.message : String(err)}`;
}
