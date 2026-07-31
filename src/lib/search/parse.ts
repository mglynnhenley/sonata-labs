// Slack search query → AST. Tokenizes quoted phrases and modifier:value
// operators, supports leading `-` negation. Unknown modifiers are left for the
// compiler to degrade to free text — the parser never throws.

export type Term =
  | { kind: "modifier"; field: string; value: string; negated: boolean }
  | { kind: "text"; value: string; phrase: boolean; negated: boolean };

const KNOWN_MODIFIERS = new Set([
  "in", // in:#channel, in:@user (dm)
  "from", // from:@user
  "has", // has:reaction | file | pin | link
  "before",
  "after",
  "on",
  "during", // during:2026-07 | during:2026
]);

export function parseQuery(q: string): Term[] {
  const terms: Term[] = [];
  for (const tok of tokenize(q)) {
    let text = tok;
    let negated = false;
    if (text.startsWith("-") && text.length > 1) {
      negated = true;
      text = text.slice(1);
    }

    const colon = modifierColonIndex(text);
    if (colon > 0) {
      const field = text.slice(0, colon).toLowerCase();
      if (KNOWN_MODIFIERS.has(field)) {
        const value = unquote(text.slice(colon + 1));
        terms.push({ kind: "modifier", field, value, negated });
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
// (e.g. from:"Priya Nair").
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

// Index of the operator colon (only when preceded by a bare word).
function modifierColonIndex(text: string): number {
  const idx = text.indexOf(":");
  if (idx <= 0) return -1;
  if (/["\s]/.test(text.slice(0, idx))) return -1;
  return idx;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}
