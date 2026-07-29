import type { Database } from "better-sqlite3";
import { parseQuery, type Term } from "./parse";
import { resolveLabelByName } from "../store/labels";
import { SYSTEM_LABELS } from "../gmail/types";
import type { SearchClause } from "../store/messages";

// AST → AND-combined SQL over messages alias `m`. Shared by the API `q=` param
// and the UI. Unknown operators degrade to free text; the compiler never throws.

const LABEL_ALIASES: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  drafts: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
  starred: "STARRED",
  important: "IMPORTANT",
  unread: "UNREAD",
  personal: "CATEGORY_PERSONAL",
  social: "CATEGORY_SOCIAL",
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  forums: "CATEGORY_FORUMS",
};

function resolveLabelId(db: Database, name: string): string | null {
  const row = resolveLabelByName(db, name);
  if (row) return row.id;
  const lower = name.toLowerCase();
  if (LABEL_ALIASES[lower]) return LABEL_ALIASES[lower];
  const upper = name.toUpperCase();
  if ((SYSTEM_LABELS as readonly string[]).includes(upper)) return upper;
  return null;
}

function likeParam(v: string): string {
  return `%${v}%`;
}

function existsLabel(labelId: string): string {
  return `EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)`;
}

function ftsClause(): string {
  return `EXISTS (SELECT 1 FROM messages_fts WHERE messages_fts.message_id = m.id AND messages_fts MATCH ?)`;
}

// Quote a term for FTS5 so operators/punctuation can't break the query.
function ftsQuote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

// Parse a date value: epoch seconds, or YYYY/MM/DD | YYYY-MM-DD at local
// midnight. Returns epoch ms, or null if unparseable.
function parseDateValue(v: string): number | null {
  if (/^\d{9,}$/.test(v)) return Number(v) * 1000; // epoch seconds
  const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d)).getTime();
  }
  return null;
}

const UNIT_MS: Record<string, number> = {
  d: 86_400_000,
  w: 7 * 86_400_000,
  m: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

function parseRelative(v: string): number | null {
  const m = v.match(/^(\d+)\s*([dwmy])$/i);
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
}

export interface CompileOptions {
  now?: number;
}

export function compileQuery(
  db: Database,
  query: string,
  opts: CompileOptions = {},
): SearchClause | null {
  const terms = parseQuery(query);
  if (terms.length === 0) return null;
  const now = opts.now ?? Date.now();

  const clauses: string[] = [];
  const params: unknown[] = [];
  let disableTrashExclusion = false;

  const push = (sql: string, negated: boolean, ...p: unknown[]) => {
    clauses.push(negated ? `NOT (${sql})` : sql);
    params.push(...p);
  };

  for (const t of terms) {
    if (t.kind === "text") {
      push(ftsClause(), t.negated, ftsQuote(t.value));
      continue;
    }

    const { field, value, negated } = t;
    switch (field) {
      case "from":
        push("m.from_addr LIKE ?", negated, likeParam(value));
        break;
      case "to":
        push("m.to_addrs LIKE ?", negated, likeParam(value));
        break;
      case "cc":
        push("m.cc_addrs LIKE ?", negated, likeParam(value));
        break;
      case "bcc":
        push("m.bcc_addrs LIKE ?", negated, likeParam(value));
        break;
      case "subject":
        push("m.subject LIKE ?", negated, likeParam(value));
        break;
      case "filename":
        push(
          "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.filename LIKE ?)",
          negated,
          likeParam(value),
        );
        break;
      case "has":
        if (value.toLowerCase() === "attachment") {
          push("m.has_attachment = 1", negated);
        } else {
          push(ftsClause(), negated, ftsQuote(value));
        }
        break;
      case "is": {
        const map: Record<string, string> = {
          unread: "UNREAD",
          starred: "STARRED",
          important: "IMPORTANT",
        };
        const lv = value.toLowerCase();
        if (lv === "read") {
          push(existsLabel("UNREAD"), !negated, "UNREAD");
        } else if (map[lv]) {
          push(existsLabel(map[lv]), negated, map[lv]);
        } else {
          push(ftsClause(), negated, ftsQuote(value));
        }
        break;
      }
      case "in":
      case "label":
      case "category": {
        const lv = value.toLowerCase();
        if (field === "in" && (lv === "anywhere" || lv === "trash" || lv === "spam")) {
          disableTrashExclusion = true;
          if (lv === "anywhere") break; // no extra clause
        }
        const id =
          field === "category"
            ? resolveLabelId(db, `category_${value}`) ?? resolveLabelId(db, value)
            : resolveLabelId(db, value);
        if (id) {
          push(existsLabel(id), negated, id);
        } else {
          // Unknown label → matches nothing (Gmail returns empty).
          push("0 = 1", negated);
        }
        break;
      }
      case "after":
      case "newer": {
        const d = parseDateValue(value);
        if (d != null) push("m.internal_date >= ?", negated, d);
        else push(ftsClause(), negated, ftsQuote(value));
        break;
      }
      case "before":
      case "older": {
        const d = parseDateValue(value);
        if (d != null) push("m.internal_date < ?", negated, d);
        else push(ftsClause(), negated, ftsQuote(value));
        break;
      }
      case "newer_than": {
        const delta = parseRelative(value);
        if (delta != null) push("m.internal_date >= ?", negated, now - delta);
        else push(ftsClause(), negated, ftsQuote(value));
        break;
      }
      case "older_than": {
        const delta = parseRelative(value);
        if (delta != null) push("m.internal_date < ?", negated, now - delta);
        else push(ftsClause(), negated, ftsQuote(value));
        break;
      }
      default:
        // Unknown operator → free text.
        push(ftsClause(), negated, ftsQuote(value));
    }
  }

  if (clauses.length === 0 && !disableTrashExclusion) return null;

  return {
    sql: clauses.length ? clauses.join(" AND ") : "1=1",
    params,
    disableTrashExclusion,
  };
}
