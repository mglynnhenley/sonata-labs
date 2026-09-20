"use client";

import { Button, Card, Chip, IconArrowRight, IconLayers, SERVICE_LABELS } from "@sonata/ui";
import type { TemplateSummary } from "../../api/_lib/types";

export type TemplateAction = "use" | "environment";

export type ScenarioTemplate = TemplateSummary & {
  environmentName: string;
  expectations: string[];
};

export type TemplateCardProps = {
  template: ScenarioTemplate;
  /** Which action is in flight, so only that button spins. */
  busy: TemplateAction | null;
  onAction: (template: TemplateSummary, action: TemplateAction) => void;
};

export function TemplateCard({ template, busy, onAction }: TemplateCardProps) {
  const hours = Math.round((template.ticks * template.simMinutesPerTick) / 60);

  return (
    <Card padding="lg" radius="2xl" interactive className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="text-sn-sm text-sn-subtle">Environment · {template.environmentName}</p>
        <h3 className="mt-1 text-sn-md font-bold text-sn-ink">{template.title}</h3>
        <p className="mt-2 line-clamp-3 text-sn-base text-sn-muted">
          {template.description}
        </p>

        <div className="mt-4">
          <p className="text-sn-sm font-medium text-sn-ink">Expected behavior</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sn-sm text-sn-muted">
            {template.expectations.map((expectation, index) => <li key={index}>{expectation}</li>)}
          </ul>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {template.services.map((service) => (
            <Chip key={service.twin} service={service.twin} tone="neutral" size="sm">
              {SERVICE_LABELS[service.twin]}
            </Chip>
          ))}
          <Chip size="sm" icon={<IconLayers size="xs" />}>
            {hours} simulated hours
          </Chip>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          loading={busy === "use"}
          disabled={busy !== null && busy !== "use"}
          iconRight={<IconArrowRight size="sm" />}
          onClick={() => onAction(template, "use")}
        >
          Save &amp; review
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === "environment"}
          disabled={busy !== null && busy !== "environment"}
          onClick={() => onAction(template, "environment")}
        >
          Save environment only
        </Button>
      </div>
    </Card>
  );
}
