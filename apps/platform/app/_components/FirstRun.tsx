"use client";

import { buttonClasses, Card, Chip, IconArrowRight, IconSpark, PageHeader } from "@sonata/ui";
import { ROUTES } from "@/lib/routes";
import type { TwinStatus } from "@/lib/twins";
import { TwinStrip } from "./TwinStrip";
import { useGo } from "./useGo";

// The first thing anyone sees. It has one job: get a stranger from here to
// watching an agent work inside a fake company in under five minutes. So it
// teaches the product in three sentences, offers exactly one primary action,
// and puts the only piece of setup — starting the clones — on the same screen.

// Stamped with elapsed time: the promise is five minutes, so the steps prove it.
const STEPS = [
  {
    n: 1,
    stamp: "0:00",
    title: "A company appears.",
    body: "12 people, their threads, their channels, a week of meetings. The same cast in Gmail, Slack and the calendar.",
    href: ROUTES.scenarios,
    cta: "See the five scenarios",
  },
  {
    n: 2,
    stamp: "0:30",
    title: "The day starts at 9am.",
    body: "The clock moves in 15-minute steps. A client escalates at 9:15; a meeting collides after lunch. Your agent is told the time and what's new, and works. When it writes to someone, that person writes back — in their own voice.",
    href: ROUTES.runs,
    cta: "See how a run works",
  },
  {
    n: 3,
    stamp: "4:00",
    // The highest-value string in the product: it defines the coined word and
    // gives it a reference point.
    title: "You get one number.",
    body: "Autonomy: the share of the day's job that got done without a human stepping in. 100% means you could have gone to lunch. Every number on the page opens the moment that produced it.",
    href: ROUTES.compare,
    cta: "See what gets scored",
  },
] as const;

export interface FirstRunProps {
  twins: TwinStatus[];
  onTwinsChanged: () => void;
}

export function FirstRun({ twins, onTwinsChanged }: FirstRunProps) {
  const go = useGo();
  const ready = twins.filter((t) => t.ok).length;

  return (
    <div className="animate-sn-rise sn-stack-section">
      <PageHeader
        size="lg"
        eyebrow="Welcome to Sonata Labs"
        title="Clone a company. Find out what your agent can actually do inside it."
        subtitle="Sonata builds a fake company — an inbox, Slack channels and a calendar, with the same people in all three — then plays one workday inside it while your agent works. Emails arrive on a clock, coworkers write back in character, meetings move. At 5pm you get one number: how much of the job it handled without you. Everything runs on this machine. Nothing touches a real account."
        meta={
          <>
            <Chip tone="gold" icon={<IconSpark size="sm" />}>
              Five minutes end to end
            </Chip>
            <Chip>Local only</Chip>
            <Chip>
              {ready === 3 ? "Gmail, Slack and Calendar ready" : `${ready} of the three apps ready`}
            </Chip>
          </>
        }
        actions={
          // Real anchors, not buttons: the first screen anyone sees should let
          // its two exits be middle-clicked and copied like any other link.
          <>
            <a
              href={ROUTES.scenarios}
              onClick={(e) => go(e, ROUTES.scenarios)}
              className={buttonClasses("ghost", "lg")}
            >
              See the five scenarios
            </a>
            <a
              href={ROUTES.guidedDemo}
              onClick={(e) => go(e, ROUTES.guidedDemo)}
              className={buttonClasses("primary", "lg")}
            >
              Run the demo day
              <IconArrowRight size="md" />
            </a>
          </>
        }
      />

      <section>
        <h2 className="font-display text-[28px] text-sn-ink">
          What happens when you press the button
        </h2>
        <p className="mt-2 max-w-[62ch] text-[14px] leading-[22px] text-sn-muted">
          Three steps, and the demo day does all of them for you the first time.
        </p>

        <ol className="mt-6 grid gap-4 md:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.n}>
              <Card padding="lg" className="flex h-full flex-col">
                <span
                  aria-hidden="true"
                  data-numeric
                  className="font-display-upright grid h-9 min-w-9 place-items-center self-start rounded-full bg-sn-gold-soft px-2.5 text-[15px] text-sn-gold-ink"
                >
                  {step.stamp}
                </span>
                <h3 className="mt-4 text-[15px] font-medium text-sn-ink">{step.title}</h3>
                <p className="mt-2 flex-1 text-[13px] leading-[21px] text-sn-muted">{step.body}</p>
                <a
                  href={step.href}
                  onClick={(e) => go(e, step.href)}
                  className="group mt-5 inline-flex items-center gap-1.5 rounded-sn-sm text-[13px] font-medium text-sn-primary-ink"
                >
                  {step.cta}
                  <IconArrowRight
                    size="sm"
                    className="transition-transform duration-150 ease-sn group-hover:translate-x-0.5"
                  />
                </a>
              </Card>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-[28px] text-sn-ink">
              The three apps you&apos;ll be watching
            </h2>
            <p className="mt-2 max-w-[62ch] text-[14px] leading-[22px] text-sn-muted">
              Each one speaks its real API closely enough that the official SDKs work against it.
              The demo day starts whichever it needs, or you can start them here.
            </p>
          </div>
          <a
            href={ROUTES.settings}
            onClick={(e) => go(e, ROUTES.settings)}
            className="rounded-sn-sm text-[13px] font-medium text-sn-primary-ink"
          >
            Ports and models
          </a>
        </div>

        <div className="mt-6">
          <TwinStrip twins={twins} onChanged={onTwinsChanged} />
        </div>
      </section>
    </div>
  );
}
