"use client";

import { Fragment } from "react";
import { parseMrkdwn, type Token } from "@/lib/ui/mrkdwn";
import type { Directories } from "./types";
import { EMOJI } from "./emoji";

// Renders Slack mrkdwn as React nodes. Every leaf is a text node or an element
// with plain props — no dangerouslySetInnerHTML anywhere, so hostile synced
// content can't inject markup.

function renderTokens(tokens: Token[], keyPrefix = ""): React.ReactNode {
  return tokens.map((tok, i) => {
    const key = `${keyPrefix}${i}`;
    switch (tok.t) {
      case "text":
        return <Fragment key={key}>{tok.v}</Fragment>;
      case "bold":
        return (
          <strong key={key} className="font-bold">
            {renderTokens(tok.children, key + ".")}
          </strong>
        );
      case "italic":
        return (
          <em key={key} className="italic">
            {renderTokens(tok.children, key + ".")}
          </em>
        );
      case "strike":
        return (
          <s key={key} className="line-through">
            {renderTokens(tok.children, key + ".")}
          </s>
        );
      case "code":
        return (
          <code
            key={key}
            className="rounded-[3px] border border-[#e8e8e8] bg-[#f6f6f6] px-[3px] py-px font-mono text-[12px] text-[#e01e5a]"
          >
            {tok.v}
          </code>
        );
      case "pre":
        return (
          <pre
            key={key}
            className="my-1 overflow-x-auto rounded-[4px] border border-[#e8e8e8] bg-[#f6f6f6] p-2 font-mono text-[12px] leading-[1.5] text-[#1d1c1d]"
          >
            {tok.v}
          </pre>
        );
      case "link":
        return (
          <a
            key={key}
            href={tok.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-[#1264a3] hover:underline"
          >
            {tok.label}
          </a>
        );
      case "user":
        return (
          <span
            key={key}
            className="cursor-pointer rounded-[3px] bg-[#e8f5fa] px-[2px] font-medium text-[#1264a3] hover:bg-[#d1ecf7]"
          >
            @{tok.label}
          </span>
        );
      case "channel":
        return (
          <span
            key={key}
            className="cursor-pointer rounded-[3px] bg-[#e8f5fa] px-[2px] font-medium text-[#1264a3] hover:bg-[#d1ecf7]"
          >
            #{tok.label}
          </span>
        );
      case "emoji": {
        const glyph = EMOJI[tok.name];
        return glyph ? (
          <span key={key} title={`:${tok.name}:`} className="text-[16px] leading-none">
            {glyph}
          </span>
        ) : (
          <Fragment key={key}>{`:${tok.name}:`}</Fragment>
        );
      }
      case "br":
        return <br key={key} />;
    }
  });
}

export function Mrkdwn({ text, directories }: { text: string; directories?: Directories }) {
  const tokens = parseMrkdwn(text, {
    users: directories?.users,
    channels: directories?.channels,
  });
  return <>{renderTokens(tokens)}</>;
}
