"use client";

import { Mrkdwn } from "./Mrkdwn";
import type { Directories } from "./types";

// Block Kit rendering. Agents post `blocks`, and showing only the fallback
// `text` hides what they actually built. This covers the blocks agents use in
// practice — section, divider, header, context, actions, image, rich_text —
// and degrades visibly (not silently) for anything else.
//
// Every text path goes through <Mrkdwn>, so nothing here can inject HTML.

interface TextObject {
  type?: "plain_text" | "mrkdwn";
  text?: string;
  emoji?: boolean;
}

interface Block {
  type: string;
  text?: TextObject;
  fields?: TextObject[];
  elements?: Array<Record<string, unknown>>;
  accessory?: Record<string, unknown>;
  image_url?: string;
  alt_text?: string;
  title?: TextObject;
  block_id?: string;
}

function Txt({ obj, directories }: { obj?: TextObject; directories?: Directories }) {
  if (!obj?.text) return null;
  // plain_text is literal by definition; only mrkdwn gets formatted.
  if (obj.type === "plain_text") return <>{obj.text}</>;
  return <Mrkdwn text={obj.text} directories={directories} />;
}

function Buttonish({ el }: { el: Record<string, unknown> }) {
  const label = (el.text as TextObject | undefined)?.text ?? String(el.type ?? "element");
  const style = el.style as string | undefined;
  return (
    <span
      className={[
        "inline-flex items-center rounded-[4px] border px-3 py-[5px] text-[13px] font-bold",
        style === "primary"
          ? "border-transparent bg-[#007a5a] text-white"
          : style === "danger"
            ? "border-transparent bg-[#e01e5a] text-white"
            : "border-[#c9c9c9] bg-white text-[#1d1c1d]",
      ].join(" ")}
    >
      {label}
    </span>
  );
}

function ContextElement({
  el,
  directories,
}: {
  el: Record<string, unknown>;
  directories?: Directories;
}) {
  if (el.type === "image") {
    return (
      <span
        title={String(el.alt_text ?? "")}
        className="inline-grid size-[16px] shrink-0 place-items-center rounded-[3px] bg-[#e8e8e8] text-[9px]"
      >
        🖼
      </span>
    );
  }
  return (
    <span>
      <Txt obj={el as TextObject} directories={directories} />
    </span>
  );
}

export function Blocks({
  blocks,
  directories,
}: {
  blocks: unknown[];
  directories?: Directories;
}) {
  return (
    <div className="mt-[2px] space-y-2">
      {(blocks as Block[]).map((b, i) => {
        const key = b.block_id ?? `${b.type}-${i}`;
        switch (b.type) {
          case "section":
            return (
              <div key={key} className="flex items-start gap-3">
                <div className="min-w-0 flex-1 text-[15px] leading-[1.46] text-[#1d1c1d]">
                  <Txt obj={b.text} directories={directories} />
                  {b.fields && b.fields.length > 0 && (
                    <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
                      {b.fields.map((f, fi) => (
                        <div key={fi} className="text-[14px] leading-[1.4]">
                          <Txt obj={f} directories={directories} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {b.accessory && (
                  <div className="shrink-0">
                    <Buttonish el={b.accessory} />
                  </div>
                )}
              </div>
            );

          case "divider":
            return <hr key={key} className="border-t border-[#e8e8e8]" />;

          case "header":
            return (
              <h3 key={key} className="text-[17px] font-black leading-tight text-[#1d1c1d]">
                <Txt obj={b.text} directories={directories} />
              </h3>
            );

          case "context":
            return (
              <div
                key={key}
                className="flex flex-wrap items-center gap-2 text-[12px] leading-[1.4] text-[#616061]"
              >
                {(b.elements ?? []).map((el, ei) => (
                  <ContextElement key={ei} el={el} directories={directories} />
                ))}
              </div>
            );

          case "actions":
            return (
              <div key={key} className="flex flex-wrap gap-2">
                {(b.elements ?? []).map((el, ei) => (
                  <Buttonish key={ei} el={el} />
                ))}
              </div>
            );

          case "image":
            return (
              <figure key={key} className="max-w-[420px]">
                {b.title && (
                  <figcaption className="mb-1 text-[13px] font-bold text-[#1d1c1d]">
                    <Txt obj={b.title} directories={directories} />
                  </figcaption>
                )}
                <div className="flex items-center gap-2 rounded-[6px] border border-[#e8e8e8] p-2 text-[12px] text-[#616061]">
                  <span className="grid size-[32px] shrink-0 place-items-center rounded-[4px] bg-[#f6f6f6]">
                    🖼
                  </span>
                  <span className="min-w-0 truncate">{b.alt_text || b.image_url}</span>
                </div>
              </figure>
            );

          case "rich_text":
            // rich_text nests its own element tree; render the plain text we
            // can extract rather than pretending to support the full grammar.
            return (
              <div key={key} className="text-[15px] leading-[1.46] text-[#1d1c1d]">
                {richTextToPlain(b.elements ?? [])}
              </div>
            );

          default:
            // Visible, not silent: an agent should be able to SEE that it sent
            // a block the replica doesn't render.
            return (
              <div
                key={key}
                className="rounded-[4px] border border-dashed border-[#c9c9c9] px-2 py-1 text-[12px] text-[#616061]"
              >
                unrendered block: <code className="font-mono">{b.type}</code>
              </div>
            );
        }
      })}
    </div>
  );
}

function richTextToPlain(elements: Array<Record<string, unknown>>): string {
  const out: string[] = [];
  const walk = (els: Array<Record<string, unknown>>) => {
    for (const el of els) {
      if (typeof el.text === "string") out.push(el.text);
      if (Array.isArray(el.elements)) walk(el.elements as Array<Record<string, unknown>>);
    }
  };
  walk(elements);
  return out.join("");
}
