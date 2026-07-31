"use client";

import { Mrkdwn } from "./Mrkdwn";
import type { Directories, SearchData } from "./types";

export function SearchResults({
  data,
  directories,
  onOpenChannel,
}: {
  data: SearchData | null;
  directories?: Directories;
  onOpenChannel: (id: string) => void;
}) {
  if (!data) {
    return (
      <div className="grid flex-1 place-items-center text-[14px] text-[#616061]">Searching…</div>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="border-b border-[#e8e8e8] px-5 py-[10px]">
        <h2 className="text-[18px] font-black leading-tight text-[#1d1c1d]">
          {data.total} {data.total === 1 ? "result" : "results"}
        </h2>
        <p className="text-[12px] text-[#616061]">
          for <code className="font-mono">{data.query}</code> — supports{" "}
          <code className="font-mono">in:</code> <code className="font-mono">from:</code>{" "}
          <code className="font-mono">has:</code> <code className="font-mono">before:</code>{" "}
          <code className="font-mono">during:</code>
        </p>
      </header>

      <div className="flex-1 overflow-y-auto">
        {data.matches.length === 0 ? (
          <p className="px-5 py-8 text-[14px] text-[#616061]">No matches.</p>
        ) : (
          <ul>
            {data.matches.map((m) => (
              <li key={`${m.channelId}-${m.ts}`} className="border-b border-[#f0f0f0] last:border-0">
                <button
                  onClick={() => onOpenChannel(m.channelId)}
                  className="block w-full px-5 py-3 text-left hover:bg-[#f8f8f8]"
                >
                  <div className="flex items-center gap-2 text-[13px] font-bold text-[#1264a3]">
                    {m.channelKind === "channel" ? `#${m.channelName}` : m.channelName}
                    {m.threadTs && (
                      <span className="rounded-[3px] bg-[#f0f0f0] px-[4px] text-[10px] font-semibold text-[#616061]">
                        thread
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-start gap-2">
                    <span
                      className="mt-[2px] grid size-[24px] shrink-0 place-items-center rounded-[4px] text-[10px] font-bold text-white"
                      style={{ background: m.author.color }}
                    >
                      {m.author.initials}
                    </span>
                    <span className="min-w-0">
                      <span className="mr-2 text-[14px] font-bold text-[#1d1c1d]">
                        {m.author.realName}
                      </span>
                      <span className="text-[12px] text-[#616061]">
                        {new Date(m.timeMs).toLocaleString("en-US", {
                          hour12: true,
                          timeZone: "UTC",
                        })}
                      </span>
                      <span className="mt-[2px] block whitespace-pre-wrap break-words text-[14px] leading-[1.46] text-[#1d1c1d]">
                        <Mrkdwn text={m.text} directories={directories} />
                      </span>
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
