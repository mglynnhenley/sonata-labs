import type { ObjectSchema } from "./manifest";

// Checking the call before it reaches the twin.
//
// `tools/list` publishes `required: ["messageId"]`, and until this file existed
// nothing enforced it. The engine's arg helpers coerce rather than reject —
// `str(undefined)` is `""` — so a missing or misnamed argument became an empty
// path segment and the twin answered whatever that URL happens to mean:
//
//   get_message   with no messageId -> GET  /messages/         -> 200, a message
//                                                                 with every
//                                                                 field blank
//   modify_labels with no messageId -> POST /messages//modify  -> HTTP 405
//
// The first is the dangerous one. An agent asks to read a message and is told,
// with no error at all, that the message is empty — so it moves on, and the
// benchmark scores it for ignoring mail it was actively prevented from reading.
//
// That is a connector bug that would be charged to the agent, which is the one
// kind of bug this package must not have: the whole claim is that a score here
// measures the agent. Weaker agents get argument names wrong constantly, so this
// path is not an edge case, it is Tuesday.
//
// The check is deliberately shallow — required keys, primitive types, no
// coercion — because the engine's own helpers are the arbiter of everything
// past that point, and a second, stricter opinion here would reject calls the
// benchmark accepts.

/** What the argument names are, in the order the schema declares them. */
function known(schema: ObjectSchema): string[] {
  return Object.keys(schema.properties ?? {});
}

/** A JSON Schema `type` for a value, in the vocabulary the tool schemas use. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

/** True when `value` satisfies `expected`; integer counts as number, and vice versa. */
function typeMatches(expected: string, value: unknown): boolean {
  const actual = jsonTypeOf(value);
  if (expected === actual) return true;
  if (expected === "number") return actual === "integer";
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  return false;
}

/**
 * The declared type of one property, or null when the schema does not say.
 *
 * Union types (`type: ["string", "null"]`) are treated as unconstrained rather
 * than half-checked: the engine accepts them and this file must not be stricter.
 */
function declaredType(schema: ObjectSchema, key: string): string | null {
  const prop = (schema.properties ?? {})[key] as { type?: unknown } | undefined;
  return typeof prop?.type === "string" ? prop.type : null;
}

/**
 * Why this call cannot be made, or null if it can.
 *
 * The message names the offending argument AND lists the accepted ones, because
 * the overwhelmingly common cause is a near-miss — `id` for `messageId`, `query`
 * for `q` — and an agent handed the real names fixes it on the next turn instead
 * of retrying the same call until it gives up.
 */
export function validateArgs(
  toolName: string,
  schema: ObjectSchema,
  args: Record<string, unknown>,
): string | null {
  const names = known(schema);
  const accepted = names.length ? names.join(", ") : "(none)";

  for (const key of schema.required ?? []) {
    const value = args[key];
    // Present-but-empty counts as missing: an empty id produces exactly the
    // silent wrong answer this file exists to stop.
    const missing =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "") ||
      (Array.isArray(value) && value.length === 0);
    if (!missing) continue;
    const near = names.filter((n) => !(n in args));
    const hint =
      Object.keys(args).length && near.length
        ? ` You passed ${Object.keys(args).join(", ")}.`
        : "";
    return (
      `${toolName} requires "${key}" and it was ${value === undefined ? "not supplied" : "empty"}.` +
      `${hint} Accepted arguments: ${accepted}.`
    );
  }

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const expected = declaredType(schema, key);
    // An unknown key is not an error. MCP clients add their own, and the engine
    // ignores what it does not read — rejecting here would fail calls that work.
    if (!expected) continue;
    if (!typeMatches(expected, value)) {
      return (
        `${toolName} expects "${key}" to be a ${expected}, but got a ${jsonTypeOf(value)}. ` +
        `Accepted arguments: ${accepted}.`
      );
    }
  }

  return null;
}
