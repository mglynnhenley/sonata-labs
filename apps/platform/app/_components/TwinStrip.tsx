"use client";

import { useState } from "react";
import { Badge, Button, Card, Chip, IconArrowRight, useToast } from "@sonata/ui";
import type { TwinName } from "@sonata/core";
import type { TwinStatus } from "@/lib/twins";

// The three clones, with a switch on each. Starting a twin is the one piece of
// infrastructure a first-time user cannot avoid, so it happens here — in the
// dashboard, in one click — and never in a terminal.

const BLURBS: Record<TwinName, string> = {
  gmail: "Threads, labels and drafts",
  slack: "Channels, DMs and reactions",
  calendar: "Events, invites and free/busy",
};

type Action = "start" | "stop" | "auth-token" | "auth-oauth";

export interface TwinStripProps {
  twins: TwinStatus[];
  /** Called after a start or stop, so the poller picks the change up at once. */
  onChanged?: () => void;
}

export function TwinStrip({ twins, onChanged }: TwinStripProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<TwinName | null>(null);

  async function act(twin: TwinName, action: Action) {
    setBusy(twin);
    try {
      const res = await fetch(`/api/twins/${twin}/${action}`, { method: "POST" });
      const body = (await res.json()) as { error?: string; log?: string };
      if (!res.ok) throw new Error(body.error ?? `${res.status}`);
      if (action === "start") {
        toast({
          title: `Starting the ${twin} clone`,
          description: "It takes a few seconds to compile the first time.",
          tone: "info",
        });
      }
      onChanged?.();
    } catch (err) {
      toast({
        title: `Could not ${action} the ${twin} clone`,
        description: (err as Error).message,
        tone: "error",
        duration: 0,
      });
    } finally {
      setBusy(null);
    }
  }

  if (twins.length === 0) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="sn-skeleton h-[132px] rounded-sn-2xl" aria-hidden="true" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {twins.map((twin) => {
        const starting = !twin.ok && twin.managed;
        return (
          <Card key={twin.twin} padding="md" className="flex flex-col">
            <div className="flex items-start justify-between gap-3">
              <Chip service={twin.twin} />
              {twin.ok ? (
                <Badge status="passed">Up</Badge>
              ) : starting ? (
                <Badge status="running">Starting</Badge>
              ) : (
                <Badge status="neutral">Off</Badge>
              )}
            </div>

            <p className="mt-3 text-sn-base text-sn-muted">{BLURBS[twin.twin]}</p>
            <p className="mt-1 text-sn-sm text-sn-subtle">
              <span data-numeric>localhost:{twin.port}</span>
              {twin.ok ? ` · ${twin.detail}` : starting ? " · compiling" : " · not running"}
            </p>

            <div className="mt-4 flex items-center gap-2">
              {twin.ok ? (
                <>
                  <a
                    href={twin.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-7 items-center gap-1 rounded-sn-md px-2 text-sn-sm font-medium text-sn-primary-ink transition-colors duration-150 ease-sn hover:bg-sn-primary-soft"
                  >
                    Open
                    <IconArrowRight size="xs" />
                  </a>
                  {twin.managed ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === twin.twin}
                      onClick={() => void act(twin.twin, "stop")}
                    >
                      Stop
                    </Button>
                  ) : (
                    // Not ours to stop — someone started it from a terminal.
                    <span className="text-sn-sm text-sn-subtle">started outside Sonata</span>
                  )}
                  {twin.auth && (
                    // The demo switch: flip the clone's API between the static
                    // token and its real OAuth server, live. Only twins that
                    // report a mode on /api/health get one.
                    <button
                      title={
                        twin.auth === "token"
                          ? "The static token works on the provider API. Click to require OAuth."
                          : "The provider API requires OAuth tokens. Click to accept the static token."
                      }
                      disabled={busy === twin.twin}
                      onClick={() =>
                        void act(twin.twin, twin.auth === "token" ? "auth-oauth" : "auth-token")
                      }
                      className="ml-auto inline-flex h-7 items-center rounded-sn-md px-2 text-[12px] font-medium text-sn-muted transition-colors duration-150 ease-sn hover:bg-sn-bg-subtle"
                    >
                      auth: <span data-numeric className="ml-1">{twin.auth}</span>
                    </button>
                  )}
                </>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === twin.twin || starting}
                  onClick={() => void act(twin.twin, "start")}
                >
                  Start {twin.label}
                </Button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
