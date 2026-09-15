"use client";

import { buttonClasses, Card, Chip, IconArrowRight, PageHeader } from "@sonata/ui";
import { ROUTES } from "@/lib/routes";
import type { TwinStatus } from "@/lib/twins";
import { TwinStrip } from "./TwinStrip";
import { useGo } from "./useGo";

// Introduce the environment, scenario and assessment in the order they are used.
const STEPS = [
  {
    n: 1,
    title: "Choose an environment",
    body: "The company, its people and their history. Connected apps give the agent somewhere to read, communicate and act.",
    href: ROUTES.companies,
    cta: "Explore environments",
  },
  {
    n: 2,
    title: "Review the scenario",
    body: "Pick a situation to test, then review what the agent should achieve and what it must avoid. Sonata proposes the success criteria for you.",
    href: ROUTES.scenarios,
    cta: "Choose a scenario",
  },
  {
    n: 3,
    title: "Run and inspect the result",
    body: "Choose a model or connect your own agent. Measure completed work, mistakes and cost, then inspect the actions behind each result.",
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
        title="Benchmark models and agents on realistic workdays."
        subtitle="Test the work you want to delegate: competing requests, changing information and follow-ups. See what gets done, where it goes wrong and what the run costs."
        meta={
          <>
            <Chip>Simulated business apps</Chip>
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
              href="/scenarios/new"
              onClick={(e) => go(e, "/scenarios/new")}
              className={buttonClasses("ghost", "lg")}
            >
              Describe your own
            </a>
            <a
              href={ROUTES.scenarios}
              onClick={(e) => go(e, ROUTES.scenarios)}
              className={buttonClasses("primary", "lg")}
            >
              Choose an example scenario
              <IconArrowRight size="md" />
            </a>
          </>
        }
      />

      <section>
        <h2 className="font-display text-sn-3xl text-sn-ink">
          Your work, turned into a benchmark
        </h2>
        <p className="mt-2 max-w-[62ch] text-sn-md text-sn-muted">
          Start with an example or describe your own. You can review the expectations before running it.
        </p>

        <ol className="mt-6 grid gap-4 md:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.n}>
              <Card padding="lg" className="flex h-full flex-col">
                <span
                  aria-hidden="true"
                  data-numeric
                  className="font-display-upright grid h-9 min-w-9 place-items-center self-start rounded-full bg-sn-gold-soft px-2.5 text-sn-md text-sn-gold-ink"
                >
                  {step.n}
                </span>
                <h3 className="mt-4 text-sn-md font-medium text-sn-ink">{step.title}</h3>
                <p className="mt-2 flex-1 text-sn-base text-sn-muted">{step.body}</p>
                <a
                  href={step.href}
                  onClick={(e) => go(e, step.href)}
                  className="group mt-5 inline-flex items-center gap-1.5 rounded-sn-sm text-sn-base font-medium text-sn-primary-ink"
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
            <h2 className="font-display text-sn-3xl text-sn-ink">
              The three apps you&apos;ll be watching
            </h2>
            <p className="mt-2 max-w-[62ch] text-sn-md text-sn-muted">
              The agent works in simulated apps with the same people across them.
              Your run starts the apps it needs, or you can start them here to explore.
            </p>
          </div>
          <a
            href={ROUTES.settings}
            onClick={(e) => go(e, ROUTES.settings)}
            className="rounded-sn-sm text-sn-base font-medium text-sn-primary-ink"
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
