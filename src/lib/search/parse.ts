// Gmail query → AST. Tokenizes quoted phrases and field:value operators,
// supports leading `-` negation. Unknown operators are left for the compiler to
// degrade to free text — the parser never throws.

export type Term =
  | { kind: "field"; field: string; value: string; negated: boolean }
  | { kind: "text"; value: string; phrase: boolean; negated: boolean };

const KNOWN_FIELDS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "label",
  "in",
  "is",
  "has",
  "filename",
  "category",
  "before",
  "after",
  "older",
  "newer",
  "older_than",
  "newer_than",
]);

export function parseQuery(q: string): Term[] {
  const terms: Term[] = [];
  const tokens = tokenize(q);
  for (const tok of tokens) {
    let text = tok;
    let negated = false;
    if (text.startsWith("-") && text.length > 1) {
      negated = true;
      text = text.slice(1);
    }

    const colon = fieldColonIndex(text);
    if (colon > 0) {
      const field = text.slice(0, colon).toLowerCase();
      let value = text.slice(colon + 1);
      if (KNOWN_FIELDS.has(field)) {
        value = unquote(value);
        terms.push({ kind: "field", field, value, negated });
        continue;
      }
    }

    const phrase = text.startsWith('"') && text.endsWith('"') && text.length >= 2;
    const value = unquote(text);
    if (value) terms.push({ kind: "text", value, phrase, negated });
  }
  return terms;
}

// Split on whitespace but keep quoted spans together, including after a colon
// (e.g. subject:"quarterly report").
function tokenize(q: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      cur += ch;
    } else if (/\s/.test(ch) && !inQuotes) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Index of the operator colon (only the first colon that is not inside quotes
// and is preceded by a bare word).
function fieldColonIndex(text: string): number {
  const idx = text.indexOf(":");
  if (idx <= 0) return -1;
  // Everything before the colon must be a bare word (no quotes/spaces).
  const head = text.slice(0, idx);
  if (/["\s]/.test(head)) return -1;
  return idx;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}
