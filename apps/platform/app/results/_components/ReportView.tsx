"use client";

import { Fragment, type ReactNode, useState } from "react";
import { Button, buttonClasses, Card, IconArrowRight, IconCheck, IconCopy } from "@sonata/ui";

// Renders the Markdown from `buildRunReport` as a styled document, with a copy
// button and a download link. The report is one Markdown string — the file you
// download and the page you read are the same bytes — so this is a small,
// closed renderer for exactly the constructs that builder emits: h1/h2, tables,
// bullet lists, paragraphs, and inline **bold** / _italic_ / `code`.
//
// It renders to React nodes, never to an HTML string: the report quotes model
// output and seeded mail, which are not trusted, and React escapes text for
// free. Nothing here reaches `dangerouslySetInnerHTML`.

// ---------------------------------------------------------------------------
// Inline: **bold**, _italic_, `code`. Longest-delimiter-first so `**` is not
// read as two `*`. A dangling delimiter is left as text rather than swallowed.
// ---------------------------------------------------------------------------

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;

function renderInline(text: string): ReactNode[] {
  const parts = text.split(INLINE);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-sn-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={i}
          className="rounded bg-sn-bg-subtle px-1 py-0.5 font-mono text-[0.85em] text-sn-ink"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("_") && part.endsWith("_")) {
      return (
        <em key={i} className="text-sn-muted">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

// ---------------------------------------------------------------------------
// Blocks. A line-at-a-time walk: headings and list/table runs are recognised by
// their first characters, everything else accretes into a paragraph.
// ---------------------------------------------------------------------------

function cells(row: string): string[] {
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

function renderMarkdown(md: string): ReactNode[] {
  const lines = md.split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={key++} className="text-[13.5px] leading-relaxed text-sn-muted">
        {renderInline(paragraph.join(" "))}
      </p>,
    );
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith("# ")) {
      flushParagraph();
      blocks.push(
        <h1 key={key++} className="text-[22px] font-semibold tracking-tight text-sn-ink">
          {renderInline(trimmed.slice(2))}
        </h1>,
      );
      continue;
    }

    if (trimmed.startsWith("## ")) {
      flushParagraph();
      blocks.push(
        <h2
          key={key++}
          className="mt-2 border-t border-sn-line pt-5 text-[15px] font-semibold text-sn-ink"
        >
          {renderInline(trimmed.slice(3))}
        </h2>,
      );
      continue;
    }

    // A table: a pipe row whose next line is the `|---|` rule. The rule row is
    // consumed and skipped; everything after, until a non-pipe line, is a body row.
    if (trimmed.startsWith("|") && lines[i + 1]?.trim().startsWith("|---")) {
      flushParagraph();
      const header = cells(trimmed);
      i += 2; // past the header and the rule
      const body: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        body.push(cells(lines[i].trim()));
        i++;
      }
      i--; // the for-loop will step forward again
      // The verdict table is a headless key/value grid — a blank header reads as
      // one, so it gets no thead.
      const headed = header.some((c) => c !== "");
      blocks.push(
        <table key={key++} className="w-full border-collapse text-[13.5px]">
          {headed ? (
            <thead>
              <tr>
                {header.map((c, j) => (
                  <th
                    key={j}
                    className="border-b border-sn-line py-1.5 pr-4 text-left font-semibold text-sn-ink"
                  >
                    {renderInline(c)}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="border-b border-sn-line/60">
                {row.map((c, j) => (
                  <td
                    key={j}
                    className={j === 0 ? "py-1.5 pr-4 text-sn-muted" : "py-1.5 pr-4 font-medium text-sn-ink"}
                  >
                    {renderInline(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // A bullet run: consecutive `- ` lines become one list.
    if (trimmed.startsWith("- ")) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      i--;
      blocks.push(
        <ul key={key++} className="flex flex-col gap-1.5">
          {items.map((item, j) => (
            <li key={j} className="flex gap-2 text-[13.5px] leading-relaxed text-sn-muted">
              <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-sn-line-strong" />
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    paragraph.push(trimmed);
  }
  flushParagraph();

  return blocks;
}

export function ReportView({
  runId,
  markdown,
}: {
  runId: string;
  markdown: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked (insecure origin, denied permission). The
      // download is always there, so a failed copy is not worth an alert.
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={copied ? <IconCheck size="sm" /> : <IconCopy size="sm" />}
          onClick={copy}
        >
          {copied ? "Copied" : "Copy Markdown"}
        </Button>
        {/* A link cannot be a button; `buttonClasses` lets it wear the clothes. */}
        <a
          href={`/api/results/${encodeURIComponent(runId)}/report`}
          download
          className={buttonClasses("secondary", "sm")}
        >
          Download .md
          <IconArrowRight size="sm" />
        </a>
      </div>

      <Card padding="lg" className="flex flex-col gap-3.5">
        {renderMarkdown(markdown)}
      </Card>
    </div>
  );
}
