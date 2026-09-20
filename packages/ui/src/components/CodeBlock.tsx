"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../cn";
import { IconCheck, IconCopy } from "./icons";

export type CodeBlockProps = {
  code: string;
  /** Shown in the header chip: "json", "bash", "typescript". */
  language?: string;
  /** Overrides the language chip: a file name or a tool-call name. */
  filename?: string;
  wrap?: boolean;
  showLineNumbers?: boolean;
  /** CSS max-height for the scroll area, e.g. "320px". */
  maxHeight?: string;
  copyable?: boolean;
  className?: string;
};

/** Clipboard API first; execCommand keeps copy working on file:// and http. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  return ok;
}

export function CodeBlock({
  code,
  language,
  filename,
  wrap = false,
  showLineNumbers = false,
  maxHeight,
  copyable = true,
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = useCallback(async () => {
    const ok = await copyText(code);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [code]);

  const label = filename ?? language;
  const lines = showLineNumbers ? code.split("\n") : null;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-sn-xl border border-sn-line bg-sn-bg-subtle",
        // The label and gutter below are muted, not subtle: this block's own
        // surface is #f1efe9, and the subtle grey only clears 4.34:1 against
        // it. Muted measures 5.57:1 on the same background.
        className,
      )}
    >
      {label || copyable ? (
        <div className="flex h-9 items-center justify-between border-b border-sn-line px-3">
          <span className="font-mono text-sn-xs tracking-[0.04em] text-sn-muted uppercase">
            {label}
          </span>
          {copyable ? (
            <button
              type="button"
              onClick={onCopy}
              className="-mr-1 inline-flex h-6 items-center gap-1.5 rounded-sn-sm px-1.5 text-sn-sm text-sn-muted transition-colors duration-150 ease-sn hover:bg-sn-surface hover:text-sn-ink"
            >
              {copied ? <IconCheck size="sm" className="text-sn-success" /> : <IconCopy size="sm" />}
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="sn-scroll overflow-auto" style={maxHeight ? { maxHeight } : undefined}>
        <pre
          className={cn(
            "p-3 font-mono text-sn-sm leading-[19px] text-sn-ink",
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
        >
          {lines ? (
            <code>
              {lines.map((line, i) => (
                <span key={i} className="grid grid-cols-[2.25rem_1fr]">
                  <span className="select-none text-right text-sn-muted" aria-hidden="true">
                    {i + 1}
                    {"  "}
                  </span>
                  <span>{line || " "}</span>
                </span>
              ))}
            </code>
          ) : (
            <code>{code}</code>
          )}
        </pre>
      </div>

      {/* Copy feedback for screen readers, which cannot see the icon flip. */}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
