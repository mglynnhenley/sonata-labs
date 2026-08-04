"use client";

import { Button, Card, Chip, IconArrowRight, IconSpark, PageHeader } from "@sonata/ui";
import { ROUTES } from "@/lib/routes";
import type { TwinStatus } from "@/lib/twins";
import { TwinStrip } from "./TwinStrip";
import { useGo } from "./useGo";

// The first thing anyone sees. It has one job: get a stranger from here to
// watching an agent work inside a fake company in under five minutes. So it
// teaches the product in three sentences, offers exactly one primary action,
// and puts the only piece of setup — starting the clones — on the same screen.

const STEPS = [
  {
    n: 1,
    title: "Clone a business",
    body: "Describe it in one line — “a 12-person fintech, the week before an audit”. Sonata writes the people, their threads, their channels and their meetings, and puts the same cast in all three clones.",
    href: ROUTES.scenarios,
    cta: "See the scenarios",
  },
  {
    n: 2,
    title: "Run a day",
    body: "The clock moves in 15-minute ticks. A client escalates at 9:15, a meeting collides after lunch. Your agent lives inside the day — and when it writes to someone, that person writes back.",
    href: ROUTES.runs,
    cta: "See how a run works",
  },
  {
    n: 3,
    title: "Read the score",
    body: "Each scenario has criteria, and a judge reads the whole day and names how the agent failed. The number that matters is autonomy: how much of the job got done without a human stepping in.",
    href: ROUTES.results,
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
    <div className="animate-sn-rise flex flex-col gap-14">
      <PageHeader
        size="lg"
        eyebrow="Welcome to Sonata Labs"
        title="Clone your business, then test your agent inside it."
        subtitle="Sonata builds a fake company — an inbox, Slack channels and a calendar, with the same people in all three — and plays one workday inside it while your agent works. Everything runs on this machine. Nothing touches a real account."
        meta={
          <>
            <Chip tone="gold" icon={<IconSpark size={13} />}>
              Five minutes end to end
            </Chip>
            <Chip>Local only</Chip>
            <Chip>{ready === 3 ? "All three clones ready" : `${ready} of 3 clones ready`}</Chip>
          </>
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="lg"
              onClick={(e) => go(e, ROUTES.scenarios)}
            >
              Browse scenarios
            </Button>
            <Button
              variant="primary"
              size="lg"
              iconRight={<IconArrowRight size={15} />}
              onClick={(e) => go(e, ROUTES.guidedDemo)}
            >
              Start the guided demo
            </Button>
          </>
        }
      />

      <section>
        <h2 className="font-display text-[28px] text-sn-ink">How a day works</h2>
        <p className="mt-2 max-w-[62ch] text-[14px] leading-[22px] text-sn-muted">
          Three steps, and the guided demo does all of them for you the first time.
        </p>

        <ol className="mt-6 grid gap-4 md:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.n}>
              <Card padding="lg" className="flex h-full flex-col">
                <span
                  aria-hidden="true"
                  className="font-display-upright grid h-9 w-9 place-items-center rounded-full bg-sn-gold-soft text-[17px] text-sn-gold-ink"
                >
                  {step.n}
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
                    size={13}
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
            <h2 className="font-display text-[28px] text-sn-ink">The three clones</h2>
            <p className="mt-2 max-w-[62ch] text-[14px] leading-[22px] text-sn-muted">
              Each one speaks its real API closely enough that the official SDKs work against it.
              The guided demo starts whichever it needs, or you can start them here.
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
