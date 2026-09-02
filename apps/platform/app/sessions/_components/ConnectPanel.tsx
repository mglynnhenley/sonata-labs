"use client";

import { useState } from "react";
import { Card, Chip, IconCheck, IconCopy, SERVICE_LABELS, cn } from "@sonata/ui";
import type { TwinName } from "@sonata/core";

// WHERE THE AGENT PLUGS IN.
//
// The first of the product's three steps, and the only one with nothing to
// configure: the clones are ordinary services on ordinary ports, speaking the
// APIs their real counterparts speak. An agent connects the way it would connect
// to the real thing, and Sonata learns what it did from each clone's audit log —
// which is why this works with any agent and why nothing on this card is a
// credential.

export type ConnectPanelProps = {
  twins: readonly { twin: TwinName; url: string; ok: boolean; detail: string }[];
};

export function ConnectPanel({ twins }: ConnectPanelProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied((current) => (current === url ? null : current)), 1500);
    } catch {
      // A browser that refuses the clipboard is not an error worth a toast; the
      // URL is on screen and selectable.
    }
  };

  return (
    <Card padding="lg">
      <h2 className="font-display text-sn-2xl text-sn-ink">Connect your agent</h2>
      <p className="mt-1.5 max-w-[74ch] text-sn-base text-sn-muted">
        Point it at these three, exactly as it would at the real Gmail, Slack and Calendar. Sonata
        never calls your agent: the day plays on its own clock, and what the agent did is read back
        out of each clone&rsquo;s audit log — so anything that can use the tools can be measured,
        with nothing to install on your side.
      </p>

      <ul className="mt-5 grid gap-2 sm:grid-cols-3">
        {twins.map((twin) => (
          <li key={twin.twin}>
            <button
              type="button"
              onClick={() => void copy(twin.url)}
              className={cn(
                "w-full rounded-sn-md border border-sn-line bg-sn-surface px-3.5 py-3 text-left",
                "transition-colors duration-150 ease-sn hover:border-sn-line-strong",
              )}
            >
              <span className="flex items-center gap-2">
                <Chip service={twin.twin} size="sm">
                  {SERVICE_LABELS[twin.twin]}
                </Chip>
                <span
                  className={cn(
                    "ml-auto text-sn-xs",
                    twin.ok ? "text-sn-success-ink" : "text-sn-subtle",
                  )}
                  title={twin.detail}
                >
                  {twin.ok ? "up" : "not running"}
                </span>
              </span>
              <span className="mt-2 flex items-center gap-1.5">
                <span data-numeric className="font-mono text-sn-sm text-sn-ink">
                  {twin.url.replace(/^https?:\/\//, "")}
                </span>
                {copied === twin.url ? (
                  <IconCheck size="xs" className="text-sn-success" />
                ) : (
                  <IconCopy size="xs" className="text-sn-subtle" />
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-4 max-w-[74ch] text-sn-sm text-sn-subtle">
        A clone that is not running is started for you when the session begins. One thing the logs
        cannot see is your agent giving up and asking a human — if your harness can report that,
        POST it to <span className="font-mono">/api/sessions/&lt;id&gt;/escalate</span>, and the
        autonomy score will count it.
      </p>
    </Card>
  );
}
