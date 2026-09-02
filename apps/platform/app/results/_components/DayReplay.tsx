"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type {
  AttioBeatBody,
  AttioWriteValue,
  BeatBody,
  GoogleAdsBeatBody,
  GoogleDocsBeatBody,
  LinkedInBeatBody,
  TwinName,
} from "@sonata/core";
import {
  Card,
  Chip,
  CodeBlock,
  SERVICE_LABELS,
  IconAlert,
  IconArrowDown,
  IconArrowUp,
  IconBolt,
  IconCalendar,
  IconDoc,
  IconFeed,
  IconInfo,
  IconMail,
  IconTrend,
  IconUsers,
  IconMessage,
  IconSearch,
  IconSpark,
  Timeline,
  cn,
} from "@sonata/ui";
import { scrollBehavior } from "../../_components/scrollBehavior";
import type { Moment } from "../_lib/moments";
import { formatSimTime } from "../_lib/summary";

// The hero: one vertical story on the simulated clock, with the world's beats,
// the agent's steps and the people answering it interleaved in the order they
// happened. Selecting a moment opens it in the pane beside the story rather than
// pushing the story around — the shape of the day has to stay stable while you
// read one moment of it.
//
// Rows are hand-rolled instead of `TimelineItem` because this list is a
// single-select listbox, not a set of independent disclosures. They keep the
// component's `data-timeline-toggle` hook and rail markup, so `Timeline`'s own
// arrow-key handling still walks them and the last row's rail still stops.

const FAIL = "border-sn-failed-line bg-sn-failed-soft text-sn-failed-ink";
const QUIET = "border-sn-line-strong bg-sn-surface text-sn-subtle";
const WRITE = "border-sn-primary bg-sn-primary text-sn-on-primary";
const GOLD = "border-sn-gold bg-sn-gold-soft text-sn-gold-ink";

const TWIN_MARKER: Record<TwinName, string> = {
  gmail: "border-sn-gmail-line bg-sn-gmail-soft text-sn-gmail-ink",
  slack: "border-sn-slack-line bg-sn-slack-soft text-sn-slack-ink",
  calendar: "border-sn-calendar-line bg-sn-calendar-soft text-sn-calendar-ink",
  attio: "border-sn-attio-line bg-sn-attio-soft text-sn-attio-ink",
  "google-docs": "border-sn-google-docs-line bg-sn-google-docs-soft text-sn-google-docs-ink",
  "google-ads": "border-sn-google-ads-line bg-sn-google-ads-soft text-sn-google-ads-ink",
  linkedin: "border-sn-linkedin-line bg-sn-linkedin-soft text-sn-linkedin-ink",
};

const TWIN_ICON: Record<TwinName, typeof IconMail> = {
  gmail: IconMail,
  slack: IconMessage,
  calendar: IconCalendar,
  attio: IconUsers,
  "google-docs": IconDoc,
  "google-ads": IconTrend,
  linkedin: IconFeed,
};

const SOURCE_LABEL: Record<Moment["source"], string> = {
  world: "The day",
  agent: "The agent",
  director: "Someone answered",
  engine: "The engine",
};

function markerClass(moment: Moment): string {
  if (moment.error) return FAIL;
  if (moment.source === "agent") {
    if (moment.step?.kind === "escalation") return FAIL;
    return moment.isMutation ? WRITE : QUIET;
  }
  if (moment.twin) return TWIN_MARKER[moment.twin];
  return moment.source === "world" ? GOLD : QUIET;
}

function MarkerIcon({ moment }: { moment: Moment }) {
  if (moment.error || moment.step?.kind === "escalation") return <IconAlert size="xs" />;
  if (moment.source === "agent") {
    return moment.isMutation ? <IconBolt size="xs" /> : <IconSearch size="xs" />;
  }
  if (moment.twin) {
    const Icon = TWIN_ICON[moment.twin];
    return <Icon size="xs" />;
  }
  if (moment.source === "director") return <IconSpark size="xs" />;
  return <IconInfo size="xs" />;
}

export function DayReplay({
  moments,
  selected,
  onSelect,
  onJumpSeq,
  offsetMinutes,
  people,
  /** Bumped by every jump from a score, a criterion or a finding. */
  focusToken,
}: {
  moments: Moment[];
  selected: number;
  onSelect: (index: number) => void;
  onJumpSeq: (seq: number) => void;
  offsetMinutes: number;
  people: People;
  focusToken: number;
}) {
  const listRef = useRef<HTMLOListElement | null>(null);
  const lastFocus = useRef(focusToken);

  // Only a jump moves focus. Clicking a row must not yank it to the middle of
  // the viewport under the cursor that just clicked it.
  useEffect(() => {
    if (focusToken === lastFocus.current) return;
    lastFocus.current = focusToken;
    const row = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-moment-index="${selected}"]`,
    );
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, [focusToken, selected]);

  const current = moments[selected];

  return (
    <Card padding="none" radius="2xl" className="scroll-mt-6 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-sn-line px-5 py-3.5">
        <div>
          <h3 className="text-sn-md font-medium text-sn-ink">The day, replayed</h3>
          <p className="mt-0.5 text-sn-sm text-sn-muted">
            Everything that happened, in order. Arrow keys step through it.
          </p>
        </div>
        {moments.length > 0 ? (
          <div className="flex items-center gap-1 text-sn-sm text-sn-muted">
            <button
              type="button"
              onClick={() => onSelect(Math.max(0, selected - 1))}
              disabled={selected === 0}
              aria-label="Previous moment"
              className="grid h-7 w-7 place-items-center rounded-sn-md text-sn-muted transition-colors duration-150 ease-sn hover:bg-sn-bg-subtle hover:text-sn-ink disabled:opacity-40"
            >
              <IconArrowUp size="sm" />
            </button>
            <span data-numeric className="tabular-nums">
              {selected + 1} / {moments.length}
            </span>
            <button
              type="button"
              onClick={() => onSelect(Math.min(moments.length - 1, selected + 1))}
              disabled={selected >= moments.length - 1}
              aria-label="Next moment"
              className="grid h-7 w-7 place-items-center rounded-sn-md text-sn-muted transition-colors duration-150 ease-sn hover:bg-sn-bg-subtle hover:text-sn-ink disabled:opacity-40"
            >
              <IconArrowDown size="sm" />
            </button>
          </div>
        ) : null}
      </div>

      {moments.length === 0 ? (
        <p className="px-5 py-8 text-center text-sn-base text-sn-muted">
          No ticks were recorded. The run stopped before the day started.
        </p>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
          <div className="sn-scroll max-h-[640px] overflow-y-auto border-b border-sn-line px-5 py-4 lg:border-r lg:border-b-0">
            <Timeline ref={listRef} aria-label="The day, moment by moment">
              {moments.map((moment, index) => {
                const first = index === 0 || moments[index - 1]?.tick !== moment.tick;
                return (
                  <MomentRow
                    key={`${moment.tick}-${moment.index}`}
                    moment={moment}
                    active={index === selected}
                    showTime={first}
                    offsetMinutes={offsetMinutes}
                    onSelect={() => onSelect(index)}
                  />
                );
              })}
            </Timeline>
          </div>

          <aside className="sn-scroll max-h-[640px] overflow-y-auto bg-sn-bg-subtle/40 p-5">
            {current ? (
              <MomentDetail
                moment={current}
                offsetMinutes={offsetMinutes}
                people={people}
                onJumpSeq={onJumpSeq}
              />
            ) : null}
          </aside>
        </div>
      )}
    </Card>
  );
}

function MomentRow({
  moment,
  active,
  showTime,
  offsetMinutes,
  onSelect,
}: {
  moment: Moment;
  active: boolean;
  showTime: boolean;
  offsetMinutes: number;
  onSelect: () => void;
}) {
  return (
    <li className="group flex gap-3">
      <div className="w-12 shrink-0 pt-[3px] text-right">
        {showTime ? (
          <>
            <span data-numeric className="block text-sn-sm font-medium text-sn-muted">
              {formatSimTime(moment.simTimeISO, offsetMinutes)}
            </span>
            <span className="block text-sn-xs text-sn-subtle">t{moment.tick}</span>
          </>
        ) : null}
      </div>

      <div data-rail className="relative flex-1 border-l border-sn-line pb-3 pl-5">
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-0.5 -left-[11px] grid h-[22px] w-[22px] place-items-center rounded-full border",
            markerClass(moment),
            active && "ring-3 ring-sn-primary-soft",
          )}
        >
          <MarkerIcon moment={moment} />
        </span>

        <button
          type="button"
          data-timeline-toggle
          data-moment-index={moment.index}
          aria-current={active}
          onClick={onSelect}
          onFocus={onSelect}
          className={cn(
            "-mx-2 flex w-full rounded-sn-md px-2 py-1 text-left",
            "transition-colors duration-150 ease-sn hover:bg-sn-surface-hover",
            active && "bg-sn-primary-soft/60",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span
                className={cn(
                  "truncate text-sn-base font-medium text-sn-ink",
                  moment.source === "agent" && moment.step?.kind === "tool" && "font-mono text-sn-sm",
                )}
              >
                {moment.title}
              </span>
              {moment.isMutation ? (
                <span className="shrink-0 text-sn-xs tracking-[0.06em] text-sn-primary-ink uppercase">
                  write
                </span>
              ) : null}
            </span>
            {moment.detail ? (
              <span className="mt-0.5 line-clamp-2 block text-sn-sm text-sn-muted">
                {moment.detail}
              </span>
            ) : null}
          </span>
        </button>
      </div>
    </li>
  );
}

type People = Record<string, string>;

function payloadLines(body: BeatBody, people: People): Array<{ label: string; value: string }> {
  // People are named by `Person.id` in payloads. An unknown ref is someone
  // outside the company — a raw address — so it is shown exactly as written.
  const who = (ref: string) => people[ref] ?? ref;

  if (body.twin === "gmail") {
    const p = body.payload;
    return [
      { label: "From", value: who(p.from) },
      { label: "To", value: p.to.map(who).join(", ") },
      { label: "Subject", value: p.subject },
      { label: "Body", value: p.body },
    ];
  }
  if (body.twin === "slack") {
    if (body.kind === "message") {
      const p = body.payload;
      return [
        { label: "Channel", value: `#${p.channel}` },
        { label: "From", value: who(p.from) },
        { label: "Message", value: p.text },
      ];
    }
    const p = body.payload;
    return [
      { label: "From", value: who(p.from) },
      { label: "Reacted", value: `:${p.emoji}: on ${p.messageRef}` },
    ];
  }
  if (body.twin === "calendar") {
    if (body.kind === "invite") {
      const p = body.payload;
      return [
        { label: "Meeting", value: p.title },
        { label: "When", value: `${p.startISO} → ${p.endISO}` },
        { label: "With", value: p.attendees.map(who).join(", ") },
      ];
    }
    if (body.kind === "move") {
      const p = body.payload;
      return [
        { label: "Moved", value: p.eventRef },
        { label: "To", value: `${p.startISO} → ${p.endISO}` },
        ...(p.reason ? [{ label: "Because", value: p.reason }] : []),
      ];
    }
    if (body.kind === "cancel") {
      const p = body.payload;
      return [
        { label: "Cancelled", value: p.eventRef },
        ...(p.reason ? [{ label: "Because", value: p.reason }] : []),
      ];
    }
    const p = body.payload;
    return [
      { label: "RSVP", value: `${who(p.who)} → ${p.response}` },
      { label: "Event", value: p.eventRef },
      ...(p.comment ? [{ label: "Said", value: p.comment }] : []),
    ];
  }
  if (body.twin === "attio") return crmLines(body, who);
  if (body.twin === "google-docs") return documentLines(body, who);
  if (body.twin === "google-ads") return campaignLines(body);
  return feedLines(body, who);
}

/** A CRM attribute bag, one row per attribute — the way the record reads it back. */
function valueRows(
  values: Record<string, AttioWriteValue>,
): Array<{ label: string; value: string }> {
  return Object.entries(values).map(([slug, v]) => ({
    label: slug,
    value: Array.isArray(v) ? v.join(", ") : String(v),
  }));
}

function crmLines(
  body: AttioBeatBody,
  who: (ref: string) => string,
): Array<{ label: string; value: string }> {
  if (body.kind === "record") {
    return [{ label: "Added to", value: body.payload.object }, ...valueRows(body.payload.values)];
  }
  if (body.kind === "update") {
    return [{ label: "Record", value: body.payload.recordRef }, ...valueRows(body.payload.values)];
  }
  if (body.kind === "note") {
    return [
      { label: "On", value: body.payload.parentRecordRef },
      { label: "Note", value: body.payload.title },
      { label: "Says", value: body.payload.content },
    ];
  }
  const p = body.payload;
  return [
    { label: "Task", value: p.content },
    // A task nobody holds is a real state and a finding in itself, so the row is
    // written either way rather than dropped when there is no assignee.
    { label: "For", value: p.assignee ? who(p.assignee) : "nobody" },
    ...(p.deadlineISO ? [{ label: "Due", value: p.deadlineISO }] : []),
  ];
}

function documentLines(
  body: GoogleDocsBeatBody,
  who: (ref: string) => string,
): Array<{ label: string; value: string }> {
  if (body.kind === "document") {
    const p = body.payload;
    return [
      { label: "Document", value: p.title },
      { label: "Owner", value: p.owner ? who(p.owner) : "the workspace owner" },
      { label: "Text", value: p.paragraphs.map((x) => x.text).join("\n") },
    ];
  }
  if (body.kind === "append") {
    return [
      { label: "Document", value: body.payload.documentRef },
      { label: "Added", value: body.payload.paragraphs.map((x) => x.text).join("\n") },
    ];
  }
  return [
    { label: "Document", value: body.payload.documentRef },
    { label: "Found", value: body.payload.find },
    { label: "Replaced with", value: body.payload.replaceWith },
  ];
}

function campaignLines(body: GoogleAdsBeatBody): Array<{ label: string; value: string }> {
  if (body.kind === "spend") {
    const p = body.payload;
    return [
      { label: "Ad group", value: p.adGroup },
      ...(p.date ? [{ label: "Day", value: p.date }] : []),
      { label: "Traffic", value: `${p.impressions} impressions, ${p.clicks} clicks` },
      { label: "Cost", value: `${(p.costMicros / 1_000_000).toFixed(2)}` },
    ];
  }
  // Either half is legitimate: a name for a campaign the world was seeded with,
  // a ref for the second half of a pair.
  const campaign = body.payload.campaign ?? body.payload.campaignRef ?? "unnamed";
  return body.kind === "status"
    ? [
        { label: "Campaign", value: campaign },
        { label: "Status", value: body.payload.status },
      ]
    : [
        { label: "Campaign", value: campaign },
        { label: "Daily budget", value: `${(body.payload.amountMicros / 1_000_000).toFixed(2)}` },
      ];
}

function feedLines(
  body: LinkedInBeatBody,
  who: (ref: string) => string,
): Array<{ label: string; value: string }> {
  // No `from` is the company page acting, which is an actor and not a gap.
  const actor = body.payload.from ? who(body.payload.from) : "the company page";
  if (body.kind === "post") {
    return [
      { label: "Posted by", value: actor },
      { label: "Post", value: body.payload.commentary },
      ...(body.payload.visibility ? [{ label: "Visible to", value: body.payload.visibility }] : []),
    ];
  }
  if (body.kind === "comment") {
    const p = body.payload;
    return [
      { label: p.parentRef ? "Replying to" : "On", value: p.parentRef ?? p.postRef ?? "the feed" },
      { label: "From", value: actor },
      { label: "Comment", value: p.text },
    ];
  }
  return [
    { label: "From", value: actor },
    { label: "Reacted", value: `${body.payload.reactionType ?? "LIKE"} on ${body.payload.entityRef}` },
  ];
}

function MomentDetail({
  moment,
  offsetMinutes,
  people,
  onJumpSeq,
}: {
  moment: Moment;
  offsetMinutes: number;
  people: People;
  onJumpSeq: (seq: number) => void;
}) {
  const step = moment.step;
  const event = moment.event;
  const beat = moment.beat;
  // Captured: narrowing on a property does not survive into a callback.
  const becauseSeq = event?.becauseSeq;

  return (
    <div className="animate-sn-fade-in flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" icon={false}>
          {SOURCE_LABEL[moment.source]}
        </Chip>
        {moment.twin ? <Chip size="sm" service={moment.twin} /> : null}
        <span data-numeric className="text-sn-xs text-sn-subtle">
          {formatSimTime(moment.simTimeISO, offsetMinutes)} · tick {moment.tick}
          {moment.seq !== undefined ? ` · step ${moment.seq}` : ""}
        </span>
      </div>

      <h4 className="text-sn-md font-medium break-words text-sn-ink">
        {moment.title}
      </h4>

      {moment.error ? (
        <p className="rounded-sn-lg border border-sn-failed-line bg-sn-failed-soft p-2.5 text-sn-sm text-sn-failed-ink">
          {moment.error}
          {step?.kind === "tool" ? " — the call failed, so nothing changed." : ""}
        </p>
      ) : null}

      {step?.kind === "tool" ? (
        <>
          {/* When the agent wrote something, show the words. The whole report is
              an argument about what it did, and "called send_reply" is not an
              answer to that — the reply is. Raw arguments stay one click away. */}
          {composed(step.args) ? (
            <ComposedMessage message={composed(step.args)!} raw={step.args} name={step.name} />
          ) : (
            <CodeBlock
              language="json"
              filename={`${step.name}(…)`}
              code={JSON.stringify(step.args ?? null, null, 2)}
              wrap
              maxHeight="260px"
            />
          )}
          <Detail label="What came back">{step.resultSummary || "(nothing)"}</Detail>
        </>
      ) : null}

      {step?.kind === "thought" ? <Detail label="What it was thinking">{step.text}</Detail> : null}

      {step?.kind === "escalation" ? (
        <Detail label="What it handed back">
          {step.text}
          <span className="mt-2 block text-sn-sm text-sn-subtle">
            Every escalation is counted against autonomy — this is a moment a human had to step
            in.
          </span>
        </Detail>
      ) : null}

      {beat ? (
        <Detail label="Scripted beat">
          <span className="font-mono text-sn-sm">{beat.beatId}</span>
          {beat.ref ? <span className="text-sn-subtle"> · ref {beat.ref}</span> : null}
          <span className="text-sn-subtle"> · {beat.kind}</span>
        </Detail>
      ) : null}

      {event ? (
        <>
          <Detail label="Why this happened">{event.reason}</Detail>
          <div className="rounded-sn-lg border border-sn-line bg-sn-surface p-3">
            <dl className="space-y-2">
              {payloadLines(event, people).map((line) => (
                <div key={line.label}>
                  <dt className="text-sn-xs font-medium tracking-[0.06em] text-sn-subtle uppercase">
                    {line.label}
                  </dt>
                  <dd className="mt-0.5 text-sn-base whitespace-pre-wrap text-sn-ink">
                    {line.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          {becauseSeq !== undefined ? (
            <button
              type="button"
              onClick={() => onJumpSeq(becauseSeq)}
              className="self-start text-sn-sm font-medium text-sn-primary-ink hover:underline"
            >
              This answers step {becauseSeq} →
            </button>
          ) : null}
        </>
      ) : null}

      {moment.note ? <Detail label="Engine note">{moment.note}</Detail> : null}

      {moment.url ? (
        <a
          href={moment.url}
          target="_blank"
          rel="noreferrer"
          className="self-start text-sn-sm font-medium text-sn-primary-ink hover:underline"
        >
          {moment.twin ? `Open it in ${SERVICE_LABELS[moment.twin]}` : "Open it in the twin"} →
        </a>
      ) : null}
    </div>
  );
}

/**
 * What the agent actually wrote, pulled out of a tool call's arguments.
 *
 * Every writing tool across the three clones carries its prose in `body` or
 * `text`, and its addressing in some combination of to/cc/subject/channel. The
 * shape differs per tool; the question a reader has does not.
 */
interface Composed {
  to?: string;
  cc?: string;
  subject?: string;
  channel?: string;
  body: string;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v;
  if (Array.isArray(v)) {
    const joined = v.filter((x) => typeof x === "string").join(", ");
    return joined || undefined;
  }
  return undefined;
}

function composed(args: unknown): Composed | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const body = str(a.body) ?? str(a.text);
  if (!body) return null;
  return {
    body,
    ...(str(a.to) ? { to: str(a.to) } : {}),
    ...(str(a.cc) ? { cc: str(a.cc) } : {}),
    ...(str(a.subject) ? { subject: str(a.subject) } : {}),
    ...(str(a.channel) ? { channel: str(a.channel) } : {}),
  };
}

function ComposedMessage({
  message,
  raw,
  name,
}: {
  message: Composed;
  raw: unknown;
  name: string;
}) {
  const headers: Array<[string, string]> = [];
  if (message.channel) headers.push(["Channel", message.channel]);
  if (message.to) headers.push(["To", message.to]);
  if (message.cc) headers.push(["Cc", message.cc]);
  if (message.subject) headers.push(["Subject", message.subject]);

  return (
    <div className="overflow-hidden rounded-sn-lg border border-sn-line bg-sn-surface">
      {headers.length > 0 ? (
        <div className="border-b border-sn-line bg-sn-raised px-3 py-2">
          {headers.map(([label, value]) => (
            <div key={label} className="flex gap-2 text-sn-sm leading-[19px]">
              <span className="w-[52px] shrink-0 text-sn-subtle">{label}</span>
              <span className="min-w-0 break-words text-sn-ink">{value}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="max-h-[320px] overflow-auto px-3 py-2.5 text-sn-base whitespace-pre-wrap text-sn-ink">
        {message.body}
      </div>
      <details className="border-t border-sn-line">
        <summary className="cursor-pointer px-3 py-1.5 text-sn-xs text-sn-subtle select-none hover:text-sn-ink">
          Raw arguments
        </summary>
        <CodeBlock
          language="json"
          filename={`${name}(…)`}
          code={JSON.stringify(raw ?? null, null, 2)}
          wrap
          maxHeight="220px"
        />
      </details>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-sn-xs font-medium tracking-[0.06em] text-sn-subtle uppercase">
        {label}
      </div>
      <div className="mt-1 text-sn-base whitespace-pre-wrap text-sn-ink">
        {children}
      </div>
    </div>
  );
}
