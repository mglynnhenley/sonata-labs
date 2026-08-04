"use client";

import { Card, IconArrowRight, IconLayers, IconPlay, IconSearch } from "@sonata/ui";
import { ROUTES } from "@/lib/routes";
import { useGo } from "./useGo";

// The three things there are to do here, always one click away. Kept on Home so
// a returning user never lands on a page whose only content is history.

const ACTIONS = [
  {
    href: ROUTES.scenarios,
    icon: <IconLayers size={16} />,
    title: "Clone another business",
    body: "Describe a company in one line and watch it become an inbox, channels and a calendar.",
  },
  {
    href: ROUTES.runs,
    icon: <IconPlay size={14} />,
    title: "Start the day",
    body: "Pick a scenario and a model, then watch the simulated workday play out live.",
  },
  {
    href: ROUTES.results,
    icon: <IconSearch size={16} />,
    title: "Compare models",
    body: "Task success, autonomy, failure modes and cost per run, side by side.",
  },
] as const;

export function QuickStart() {
  const go = useGo();

  return (
    <section>
      <h2 className="text-[14px] font-medium text-sn-ink">Quick start</h2>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        {ACTIONS.map((action) => (
          <a
            key={action.href}
            href={action.href}
            onClick={(e) => go(e, action.href)}
            className="group block rounded-sn-2xl"
          >
            <Card interactive padding="md" className="h-full">
              <div className="flex items-center gap-2.5">
                <span className="grid h-7 w-7 place-items-center rounded-sn-md bg-sn-primary-soft text-sn-primary-ink">
                  {action.icon}
                </span>
                <h3 className="flex-1 text-[14px] font-medium text-sn-ink">{action.title}</h3>
                <IconArrowRight
                  size={14}
                  className="text-sn-subtle transition-transform duration-150 ease-sn group-hover:translate-x-0.5 group-hover:text-sn-ink"
                />
              </div>
              <p className="mt-2.5 text-[13px] leading-[20px] text-sn-muted">{action.body}</p>
            </Card>
          </a>
        ))}
      </div>
    </section>
  );
}
