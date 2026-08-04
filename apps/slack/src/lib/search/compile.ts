import type { Database } from "better-sqlite3";
import { parseQuery, type Term } from "./parse";
import { getConversationByName, getConversation } from "../store/conversations";
import { getUserByName, getUser } from "../store/users";
import { formatTs } from "../slack/ts";
import type { MessageRow } from "../slack/types";

// AST → AND-combined SQL over messages alias `m`. Shared by search.messages
// and the UI. Unknown modifiers degrade to free text; the compiler never
// throws. Results are always restricted to conversations visible to `selfId`
// (public, or private where self is a member).
//
// Date modifiers use UTC midnights (the seed is UTC-anchored; documented in
// the README): before: is exclusive of the named day, after: starts the NEXT
// day, on:/during: span the named day / month / year — matching Slack.

function ftsQuote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

const FTS_CLAUSE = `EXISTS (SELECT 1 FROM messages_fts f
  WHERE f.channel_id = m.channel_id AND f.ts = m.ts AND messages_fts MATCH ?)`;

// UTC day start for YYYY-MM-DD / YYYY/MM/DD; whole months (YYYY-MM) and years
// (YYYY) for during:. Returns [startMs, endMs) or null if unparseable.
function parseDateRange(v: string): { start: number; end: number } | null {
  let m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return { start, end: start + 86_400_000 };
  }
  m = v.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) {
    return {
      start: Date.UTC(Number(m[1]), Number(m[2]) - 1, 1),
      end: Date.UTC(Number(m[1]), Number(m[2]), 1),
    };
  }
  m = v.match(/^(\d{4})$/);
  if (m) {
    return { start: Date.UTC(Number(m[1]), 0, 1), end: Date.UTC(Number(m[1]) + 1, 0, 1) };
  }
  return null;
}

function tsBoundary(ms: number): string {
  return formatTs(Math.floor(ms / 1000), 0);
}

/** Resolve `#name`, `name`, or a raw C…/G…/D… id to a conversation id. */
function resolveChannel(db: Database, value: string): string | null {
  const bare = value.replace(/^#/, "");
  if (/^[CDG][A-Z0-9]{6,}$/.test(bare) && getConversation(db, bare)) return bare;
  const byName = getConversationByName(db, bare);
  return byName?.id ?? null;
}

/** Resolve `@name`, `name`, or a raw U… id to a user id. */
function resolveUser(db: Database, value: string): string | null {
  const bare = value.replace(/^@/, "");
  if (/^[UWB][A-Z0-9]{6,}$/.test(bare) && getUser(db, bare)) return bare;
  const byName = getUserByName(db, bare);
  return byName?.id ?? null;
}

export interface CompiledQuery {
  where: string;
  params: unknown[];
}

export function compileQuery(db: Database, query: string, selfId: string): CompiledQuery {
  const terms = parseQuery(query);
  const clauses: string[] = [];
  const params: unknown[] = [];

  const push = (sql: string, negated: boolean, ...p: unknown[]) => {
    clauses.push(negated ? `NOT (${sql})` : sql);
    params.push(...p);
  };
  const pushText = (t: Term & { kind: "text" }) => push(FTS_CLAUSE, t.negated, ftsQuote(t.value));

  for (const t of terms) {
    if (t.kind === "text") {
      pushText(t);
      continue;
    }
    const { field, value, negated } = t;
    switch (field) {
      case "in": {
        const id = resolveChannel(db, value);
        // in: can also target a DM partner (in:@user).
        if (!id && value.startsWith("@")) {
          const uid = resolveUser(db, value);
          if (uid) {
            push(
              `EXISTS (SELECT 1 FROM conversations c
                 JOIN conversation_members cm ON cm.conversation_id = c.id
               WHERE c.id = m.channel_id AND c.is_im = 1 AND cm.user_id = ?)`,
              negated,
              uid,
            );
            break;
          }
        }
        if (id) push("m.channel_id = ?", negated, id);
        else push("0 = 1", negated); // unresolvable channel matches nothing
        break;
      }
      case "from": {
        const uid = resolveUser(db, value);
        if (uid) push("m.user = ?", negated, uid);
        else push("0 = 1", negated);
        break;
      }
      case "has": {
        const v = value.toLowerCase();
        if (v === "reaction" || v === "reactions") {
          push(
            "EXISTS (SELECT 1 FROM reactions r WHERE r.channel_id = m.channel_id AND r.message_ts = m.ts)",
            negated,
          );
        } else if (v === "file" || v === "files") {
          push("m.has_files = 1", negated);
        } else if (v === "pin") {
          push(
            "EXISTS (SELECT 1 FROM pins p WHERE p.channel_id = m.channel_id AND p.message_ts = m.ts)",
            negated,
          );
        } else if (v === "link") {
          push("m.text LIKE '%http%'", negated);
        } else {
          pushText({ kind: "text", value: `${field}:${value}`, phrase: false, negated });
        }
        break;
      }
      case "before": {
        const r = parseDateRange(value);
        if (r) push("m.ts < ?", negated, tsBoundary(r.start));
        else pushText({ kind: "text", value, phrase: false, negated });
        break;
      }
      case "after": {
        const r = parseDateRange(value);
        if (r) push("m.ts >= ?", negated, tsBoundary(r.end));
        else pushText({ kind: "text", value, phrase: false, negated });
        break;
      }
      case "on":
      case "during": {
        const r = parseDateRange(value);
        if (r) push("(m.ts >= ? AND m.ts < ?)", negated, tsBoundary(r.start), tsBoundary(r.end));
        else pushText({ kind: "text", value, phrase: false, negated });
        break;
      }
      default:
        pushText({ kind: "text", value: `${field}:${value}`, phrase: false, negated });
    }
  }

  // Visibility: only conversations self can see.
  clauses.push(
    `EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.channel_id
       AND (c.is_private = 0 OR EXISTS (SELECT 1 FROM conversation_members cm
             WHERE cm.conversation_id = c.id AND cm.user_id = ?)))`,
  );
  params.push(selfId);

  return { where: clauses.length ? clauses.join(" AND ") : "1=1", params };
}

export interface SearchResult {
  total: number;
  matches: MessageRow[];
}

/** Run a compiled query with classic page/count paging, newest-first. */
export function searchMessages(
  db: Database,
  query: string,
  selfId: string,
  opts: { count: number; page: number },
): SearchResult {
  const { where, params } = compileQuery(db, query, selfId);
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${where}`).get(...params) as {
      n: number;
    }
  ).n;
  const matches = db
    .prepare(`SELECT m.* FROM messages m WHERE ${where} ORDER BY m.ts DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.count, (opts.page - 1) * opts.count) as MessageRow[];
  return { total, matches };
}
