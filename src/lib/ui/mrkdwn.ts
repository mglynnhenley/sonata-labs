// Slack mrkdwn → a token tree the React renderer walks.
//
// SECURITY: synced workspace content is hostile input. This tokenizer NEVER
// produces HTML — it emits plain data that React renders as text nodes, so
// there is no innerHTML/dangerouslySetInnerHTML anywhere in the UI. Anything it
// fails to understand degrades to literal text.

export type Token =
  | { t: "text"; v: string }
  | { t: "bold"; children: Token[] }
  | { t: "italic"; children: Token[] }
  | { t: "strike"; children: Token[] }
  | { t: "code"; v: string }
  | { t: "pre"; v: string }
  | { t: "link"; href: string; label: string }
  | { t: "user"; id: string; label: string }
  | { t: "channel"; id: string; label: string }
  | { t: "emoji"; name: string }
  | { t: "br" };

export interface MrkdwnContext {
  users?: Record<string, string>;
  channels?: Record<string, string>;
}

/** Only http(s) and mailto survive — blocks javascript:/data: URIs. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
  return null;
}

// Slack's angle-bracket entities: <@U123|label>, <#C123|label>, <http://x|label>
function parseEntity(body: string, ctx: MrkdwnContext): Token {
  const [target, ...labelParts] = body.split("|");
  const label = labelParts.join("|");

  if (target.startsWith("@")) {
    const id = target.slice(1).split("^")[0];
    return { t: "user", id, label: label || ctx.users?.[id] || id };
  }
  if (target.startsWith("#")) {
    const id = target.slice(1);
    return { t: "channel", id, label: label || ctx.channels?.[id] || id };
  }
  if (target.startsWith("!")) {
    // Special mentions: !here, !channel, !everyone
    const name = target.slice(1).split("^")[0];
    return { t: "user", id: name, label: label || `@${name}` };
  }
  const href = safeHref(target);
  if (href) return { t: "link", href, label: label || target };
  // Unrecognized/unsafe — render literally.
  return { t: "text", v: `<${body}>` };
}

const DELIMS: Array<{ ch: string; t: "bold" | "italic" | "strike" }> = [
  { ch: "*", t: "bold" },
  { ch: "_", t: "italic" },
  { ch: "~", t: "strike" },
];

/**
 * Inline pass over a span with no code/pre. Handles entities, emoji shortcodes,
 * bare URLs, and *bold* / _italic_ / ~strike~ (non-nesting of the same mark).
 */
function inline(src: string, ctx: MrkdwnContext, depth = 0): Token[] {
  const out: Token[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      continue;
    }

    if (ch === "<") {
      const close = src.indexOf(">", i + 1);
      if (close > i) {
        flush();
        out.push(parseEntity(src.slice(i + 1, close), ctx));
        i = close;
        continue;
      }
    }

    if (ch === ":") {
      const m = /^:([a-z0-9_+-]{1,50}):/i.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ t: "emoji", name: m[1] });
        i += m[0].length - 1;
        continue;
      }
    }

    // Bare URLs (Slack auto-links them).
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(src.slice(i))) {
      const m = /^https?:\/\/[^\s<>|]+/i.exec(src.slice(i))!;
      const href = safeHref(m[0]);
      if (href) {
        flush();
        out.push({ t: "link", href, label: m[0] });
        i += m[0].length - 1;
        continue;
      }
    }

    const delim = depth < 3 ? DELIMS.find((d) => d.ch === ch) : undefined;
    if (delim) {
      // Emphasis must open at a boundary and close before one, with content.
      const prevCh = i > 0 ? src[i - 1] : " ";
      if (/[\s(\[{"']/.test(prevCh) || i === 0) {
        const rest = src.slice(i + 1);
        const endIdx = rest.search(
          new RegExp(`\\${delim.ch}(?=$|[\\s.,!?;:)\\]}"'])`),
        );
        if (endIdx > 0) {
          const inner = rest.slice(0, endIdx);
          if (!inner.includes("\n")) {
            flush();
            out.push({ t: delim.t, children: inline(inner, ctx, depth + 1) });
            i += 1 + endIdx;
            continue;
          }
        }
      }
    }

    buf += ch;
  }
  flush();
  return out;
}

/** Parse mrkdwn into tokens. Splits ```pre``` and `code` before inline marks. */
export function parseMrkdwn(text: string, ctx: MrkdwnContext = {}): Token[] {
  const out: Token[] = [];
  let rest = text;

  while (rest.length) {
    const fence = rest.indexOf("```");
    const tick = rest.indexOf("`");

    // Fenced block comes first (and isn't the same char run as inline code).
    if (fence >= 0 && (tick < 0 || fence <= tick)) {
      const end = rest.indexOf("```", fence + 3);
      if (end > fence) {
        if (fence > 0) out.push(...inline(rest.slice(0, fence), ctx));
        out.push({ t: "pre", v: rest.slice(fence + 3, end).replace(/^\n/, "") });
        rest = rest.slice(end + 3);
        continue;
      }
    }

    if (tick >= 0) {
      const end = rest.indexOf("`", tick + 1);
      if (end > tick) {
        if (tick > 0) out.push(...inline(rest.slice(0, tick), ctx));
        out.push({ t: "code", v: rest.slice(tick + 1, end) });
        rest = rest.slice(end + 1);
        continue;
      }
    }

    out.push(...inline(rest, ctx));
    break;
  }
  return out;
}

/** Plain-text flattening (search previews, titles). */
export function mrkdwnToPlain(text: string, ctx: MrkdwnContext = {}): string {
  const walk = (tokens: Token[]): string =>
    tokens
      .map((tok) => {
        switch (tok.t) {
          case "text":
            return tok.v;
          case "bold":
          case "italic":
          case "strike":
            return walk(tok.children);
          case "code":
          case "pre":
            return tok.v;
          case "link":
            return tok.label;
          case "user":
            return `@${tok.label}`;
          case "channel":
            return `#${tok.label}`;
          case "emoji":
            return `:${tok.name}:`;
          case "br":
            return " ";
        }
      })
      .join("");
  return walk(parseMrkdwn(text, ctx));
}
