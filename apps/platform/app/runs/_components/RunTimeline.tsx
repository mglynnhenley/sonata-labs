"use client";

import {
  Chip,
  IconAlert,
  IconArrowRight,
  IconBolt,
  IconCalendar,
  IconMail,
  IconMessage,
  IconMinus,
  IconSearch,
  IconSpark,
  SERVICE_LABELS,
  Timeline,
  TimelineItem,
  type TimelineTone,
} from "@sonata/ui";
import type { ReactNode } from "react";
import type { TwinName } from "@sonata/core";
import { simClock } from "@/lib/format";
import type { StoryKind, StoryRow } from "../_lib/story";

// The run view's hero. One vertical story on the simulated clock: what fired,
// what the agent did, and what the world said back — each row expandable to the
// thing itself.

const TWIN_ICON: Record<TwinName, ReactNode> = {
  gmail: <IconMail size="xs" />,
  slack: <IconMessage size="xs" />,
  calendar: <IconCalendar size="xs" />,
};

function tone(row: StoryRow): TimelineTone {
  if (row.kind === "escalation") return "failed";
  if (row.kind === "director") return "gold";
  if (row.kind === "beat") return row.twin ?? "neutral";
  if (row.kind === "tool") return row.mutation ? "primary" : "neutral";
  return "neutral";
}

function icon(row: StoryRow): ReactNode {
  if (row.kind === "escalation") return <IconAlert size="xs" />;
  if (row.kind === "thought") return <IconSpark size="xs" />;
  if (row.kind === "note") return <IconMinus size="xs" />;
  if (row.kind === "tool") return row.mutation ? <IconBolt size="xs" /> : <IconSearch size="xs" />;
  return row.twin ? TWIN_ICON[row.twin] : <IconArrowRight size="xs" />;
}

/** What kind of thing this row is, in the user's language. */
const SOURCE_LABEL: Record<StoryKind, string> = {
  beat: "The world",
  director: "A reply",
  thought: "The agent",
  tool: "The agent",
  escalation: "Escalation",
  note: "Note",
};

export type RunTimelineProps = {
  rows: readonly StoryRow[];
  /** The moment the replay is parked on, by row key. */
  activeKey?: string;
  /** Rows added since the last poll get the slide-in; the rest must stay still. */
  freshFrom?: number;
};

export function RunTimeline({ rows, activeKey, freshFrom }: RunTimelineProps) {
  return (
    <Timeline aria-label="What happened during the simulated day">
      {rows.map((row, index) => {
        const quiet = row.kind === "note";
        return (
          <TimelineItem
            key={row.key}
            time={row.firstOfTick ? simClock(row.simTimeISO) : undefined}
            timeMeta={row.firstOfTick ? `Tick ${row.tick}` : undefined}
            tone={tone(row)}
            icon={icon(row)}
            active={activeKey === row.key}
            className={
              freshFrom !== undefined && index >= freshFrom ? "animate-sn-slide-in" : undefined
            }
            title={
              <span className={quiet ? "text-sn-subtle italic" : undefined}>{row.title}</span>
            }
            description={row.description}
            meta={
              <>
                {row.twin ? (
                  <Chip service={row.twin} size="sm">
                    {SERVICE_LABELS[row.twin]}
                  </Chip>
                ) : null}
                {row.kind === "escalation" ? (
                  <Chip size="sm" tone="gold">
                    Autonomy lost
                  </Chip>
                ) : null}
              </>
            }
          >
            {row.details.length > 0 || row.url ? (
              <div className="flex flex-col gap-3">
                {row.details.map((detail) => (
                  <div key={detail.label}>
                    <p className="text-sn-xs font-medium tracking-[0.08em] text-sn-subtle uppercase">
                      {detail.label}
                    </p>
                    <p
                      className={
                        detail.code
                          ? "mt-1 font-mono text-sn-sm whitespace-pre-wrap text-sn-ink"
                          : "mt-1 text-sn-base whitespace-pre-wrap text-sn-ink"
                      }
                    >
                      {detail.body}
                    </p>
                  </div>
                ))}

                <p className="flex items-center gap-3 text-sn-sm text-sn-subtle">
                  <span>{SOURCE_LABEL[row.kind]}</span>
                  {row.seq !== undefined ? <span>Step {row.seq}</span> : null}
                  {row.url ? (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-1 font-medium text-sn-primary-ink hover:underline"
                    >
                      Open in {row.twin ? SERVICE_LABELS[row.twin] : "the clone"}
                      <IconArrowRight size="xs" />
                    </a>
                  ) : null}
                </p>
              </div>
            ) : null}
          </TimelineItem>
        );
      })}
    </Timeline>
  );
}
