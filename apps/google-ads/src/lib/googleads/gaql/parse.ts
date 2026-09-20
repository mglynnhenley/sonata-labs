import { queryError } from "../errors";
import { isResourceKind, lookupField, RESOURCE_KINDS } from "../resources";

// GAQL string → AST. This is the product: a report clone that answered fixed
// JSON for a handful of known query strings would teach an agent nothing, and
// the first query it wrote itself would come back silently wrong.
//
// The grammar here is deliberately narrower than Google's, and every refusal
// says so by name with a real error code. An honest "the sandbox does not
// support REGEXP_MATCH" is worth far more to an agent than a permissive parser
// that quietly misreads the condition — the whole point of a restricted grammar
// is that the restriction is legible.
//
// This file validates that a field NAME exists. Whether it can be reached from
// the FROM resource, and whether the value it is compared against makes sense,
// are execute.ts's job, because both need the FROM resource resolved.

export interface Condition {
  field: string;
  /** Normalised and upper-cased: `=`, `!=`, `>`, `IN`, `NOT IN`, `DURING`, … */
  op: string;
  /** Every operand as text; the executor types them against the field. */
  values: string[];
}

export interface GaqlQuery {
  select: string[];
  from: string;
  where: Condition[];
  orderBy: Array<{ field: string; desc: boolean }>;
  limit?: number;
}

// --- tokenizer ---------------------------------------------------------------

type TokenType = "ident" | "number" | "string" | "punct" | "op";

interface Token {
  type: TokenType;
  /** The text as written — case preserved, quotes stripped from strings. */
  text: string;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_BODY = /[A-Za-z0-9_.]/;
const DIGIT = /[0-9]/;

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ type: "punct", text: ch });
      i++;
      continue;
    }
    // Single OR double quotes: agents copy both out of the docs, and Google
    // accepts both.
    if (ch === "'" || ch === '"') {
      const end = query.indexOf(ch, i + 1);
      if (end === -1) {
        throw queryError(
          "STRING_NOT_TERMINATED",
          `Unterminated string literal starting at position ${i}.`,
          query.slice(i),
        );
      }
      tokens.push({ type: "string", text: query.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (DIGIT.test(ch) || (ch === "-" && DIGIT.test(query[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < query.length && /[0-9.]/.test(query[j])) j++;
      tokens.push({ type: "number", text: query.slice(i, j) });
      i = j;
      continue;
    }
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < query.length && IDENT_BODY.test(query[j])) j++;
      tokens.push({ type: "ident", text: query.slice(i, j) });
      i = j;
      continue;
    }
    const two = query.slice(i, i + 2);
    if (two === "!=" || two === ">=" || two === "<=") {
      tokens.push({ type: "op", text: two });
      i += 2;
      continue;
    }
    if (ch === "=" || ch === ">" || ch === "<") {
      tokens.push({ type: "op", text: ch });
      i++;
      continue;
    }
    throw queryError("BAD_SYMBOL", `Unexpected character '${ch}' in the query.`, ch);
  }
  return tokens;
}

// --- grammar -----------------------------------------------------------------

/** Operators the executor knows how to compile. Everything else is refused by name. */
const SUPPORTED_OPERATORS = "=, !=, >, >=, <, <=, IN, NOT IN, LIKE, NOT LIKE, DURING, BETWEEN";

/** Refused by name rather than mis-parsed — each is real GAQL this clone omits. */
const UNSUPPORTED_OPERATORS = new Set([
  "CONTAINS",
  "REGEXP_MATCH",
  "IS",
]);

const KEYWORDS = new Set(["SELECT", "FROM", "WHERE", "ORDER", "BY", "LIMIT", "AND", "OR", "ASC", "DESC", "NOT", "IN", "LIKE", "DURING", "BETWEEN", "PARAMETERS"]);

class Cursor {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  /** Keywords are case-insensitive; field names are not, and never pass here. */
  atKeyword(word: string): boolean {
    const t = this.peek();
    return !!t && t.type === "ident" && t.text.toUpperCase() === word;
  }

  takeKeyword(word: string): boolean {
    if (!this.atKeyword(word)) return false;
    this.pos++;
    return true;
  }

  done(): boolean {
    return this.pos >= this.tokens.length;
  }
}

function endOfQuery(): never {
  throw queryError("UNEXPECTED_END_OF_QUERY", "Unexpected end of query.");
}

/** A field the catalogue has never heard of — Google's exact wording. */
function requireKnownField(name: string): string {
  if (!lookupField(name)) {
    throw queryError("UNRECOGNIZED_FIELD", `Unrecognized field in the query: '${name}'.`, name);
  }
  return name;
}

function fieldToken(cursor: Cursor): string {
  const token = cursor.next();
  if (!token) endOfQuery();
  if (token.type !== "ident" || KEYWORDS.has(token.text.toUpperCase())) {
    throw queryError("BAD_SYMBOL", `Expected a field name but found '${token.text}'.`, token.text);
  }
  return requireKnownField(token.text);
}

function parseSelect(cursor: Cursor): string[] {
  const fields = [fieldToken(cursor)];
  while (cursor.peek()?.text === ",") {
    cursor.next();
    fields.push(fieldToken(cursor));
  }
  return fields;
}

/** The operand list for IN / NOT IN: `(a, b, c)`, quoted or bare. */
function parseValueList(cursor: Cursor): string[] {
  const open = cursor.next();
  if (!open) endOfQuery();
  if (open.text !== "(") {
    throw queryError("BAD_SYMBOL", `Expected '(' after IN but found '${open.text}'.`, open.text);
  }
  const values: string[] = [];
  for (;;) {
    const token = cursor.next();
    if (!token) endOfQuery();
    if (token.text === ")") break;
    if (token.type === "punct" && token.text === ",") continue;
    values.push(token.text);
  }
  if (!values.length) {
    throw queryError("BAD_VALUE", "The IN operator needs at least one value.");
  }
  return values;
}

function operandToken(cursor: Cursor, op: string): string {
  const token = cursor.next();
  if (!token) endOfQuery();
  if (token.type === "punct") {
    throw queryError("BAD_SYMBOL", `Expected a value after ${op} but found '${token.text}'.`, token.text);
  }
  return token.text;
}

function parseCondition(cursor: Cursor): Condition {
  const field = fieldToken(cursor);
  const opToken = cursor.next();
  if (!opToken) endOfQuery();
  const word = opToken.text.toUpperCase();

  if (opToken.type === "op") {
    return { field, op: opToken.text, values: [operandToken(cursor, opToken.text)] };
  }

  if (UNSUPPORTED_OPERATORS.has(word)) {
    // Spell the operator the way the caller wrote it — `CONTAINS ANY` and
    // `IS NOT NULL` are two words, and refusing "CONTAINS" alone reads like the
    // sandbox misunderstood the query rather than declined it.
    const rest = cursor.peek();
    const spelled = rest && rest.type === "ident" ? `${word} ${rest.text.toUpperCase()}` : word;
    throw queryError(
      "BAD_OPERATOR",
      `Operator '${spelled}' is not supported by this sandbox; supported operators are ${SUPPORTED_OPERATORS}.`,
      spelled,
    );
  }

  if (word === "NOT") {
    const follow = cursor.next();
    if (!follow) endOfQuery();
    const followWord = follow.text.toUpperCase();
    if (followWord === "IN") return { field, op: "NOT IN", values: parseValueList(cursor) };
    if (followWord === "LIKE") return { field, op: "NOT LIKE", values: [operandToken(cursor, "NOT LIKE")] };
    throw queryError(
      "BAD_OPERATOR",
      `Operator 'NOT ${followWord}' is not supported by this sandbox; supported operators are ${SUPPORTED_OPERATORS}.`,
      `NOT ${followWord}`,
    );
  }

  if (word === "IN") return { field, op: "IN", values: parseValueList(cursor) };
  if (word === "LIKE") return { field, op: "LIKE", values: [operandToken(cursor, "LIKE")] };
  if (word === "DURING") return { field, op: "DURING", values: [operandToken(cursor, "DURING")] };
  if (word === "BETWEEN") {
    const low = operandToken(cursor, "BETWEEN");
    if (!cursor.takeKeyword("AND")) {
      throw queryError("BAD_SYMBOL", "BETWEEN needs two values joined by AND.");
    }
    return { field, op: "BETWEEN", values: [low, operandToken(cursor, "BETWEEN")] };
  }

  throw queryError(
    "BAD_OPERATOR",
    `Operator '${word}' is not supported by this sandbox; supported operators are ${SUPPORTED_OPERATORS}.`,
    word,
  );
}

function parseWhere(cursor: Cursor): Condition[] {
  const conditions = [parseCondition(cursor)];
  for (;;) {
    if (cursor.takeKeyword("AND")) {
      conditions.push(parseCondition(cursor));
      continue;
    }
    // GAQL genuinely has no OR — this is Google's restriction, not the sandbox's.
    if (cursor.atKeyword("OR")) {
      throw queryError(
        "BAD_SYMBOL",
        "Unexpected token 'OR'; GAQL conditions are joined with AND only.",
        "OR",
      );
    }
    return conditions;
  }
}

function parseOrderBy(cursor: Cursor): Array<{ field: string; desc: boolean }> {
  if (!cursor.takeKeyword("BY")) {
    throw queryError("BAD_SYMBOL", "Expected 'BY' after 'ORDER'.", "ORDER");
  }
  const keys: Array<{ field: string; desc: boolean }> = [];
  for (;;) {
    const field = fieldToken(cursor);
    let desc = false;
    if (cursor.takeKeyword("DESC")) desc = true;
    else cursor.takeKeyword("ASC");
    keys.push({ field, desc });
    if (cursor.peek()?.text !== ",") return keys;
    cursor.next();
  }
}

function parseLimit(cursor: Cursor): number {
  const token = cursor.next();
  const n = token ? Number(token.text) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw queryError("LIMIT_VALUE_TOO_LOW", "LIMIT must be at least 1.", token?.text);
  }
  return n;
}

export function parseGaql(query: string): GaqlQuery {
  if (typeof query !== "string" || !query.trim()) endOfQuery();
  const cursor = new Cursor(tokenize(query));

  const first = cursor.peek();
  if (!first) endOfQuery();
  if (!cursor.takeKeyword("SELECT")) {
    throw queryError(
      "BAD_SYMBOL",
      `Unexpected token '${first.text}' at the start of the query; a query must begin with SELECT.`,
      first.text,
    );
  }

  const select = parseSelect(cursor);

  if (!cursor.takeKeyword("FROM")) {
    if (cursor.done()) endOfQuery();
    const token = cursor.peek();
    throw queryError("BAD_SYMBOL", `Expected 'FROM' but found '${token!.text}'.`, token!.text);
  }
  const fromToken = cursor.next();
  if (!fromToken) endOfQuery();
  // Checked here rather than in execute.ts because an unknown FROM makes every
  // later check meaningless — join legality is defined relative to it.
  if (!isResourceKind(fromToken.text)) {
    throw queryError(
      "BAD_RESOURCE_TYPE_IN_FROM_CLAUSE",
      `Unrecognized resource in the FROM clause: '${fromToken.text}'. ` +
        `This sandbox serves ${RESOURCE_KINDS.join(", ")}.`,
      fromToken.text,
    );
  }
  const from = fromToken.text;

  const where = cursor.takeKeyword("WHERE") ? parseWhere(cursor) : [];
  const orderBy = cursor.takeKeyword("ORDER") ? parseOrderBy(cursor) : [];
  const limit = cursor.takeKeyword("LIMIT") ? parseLimit(cursor) : undefined;

  if (!cursor.done()) {
    const token = cursor.peek()!;
    if (token.text.toUpperCase() === "PARAMETERS") {
      throw queryError(
        "BAD_SYMBOL",
        "Unexpected token 'PARAMETERS'; the sandbox supports SELECT, FROM, WHERE, ORDER BY and LIMIT.",
        "PARAMETERS",
      );
    }
    throw queryError("BAD_SYMBOL", `Unexpected token '${token.text}' at the end of the query.`, token.text);
  }

  return { select, from, where, orderBy, limit };
}
