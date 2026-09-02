"use client";

import { useState } from "react";
import { Button, Card, Chip, IconArrowRight, IconLayers, IconPlay, SERVICE_LABELS } from "@sonata/ui";
import type { TemplateSummary } from "../../api/_lib/types";

export type TemplateAction = "use" | "copy" | "environment";

export type TemplateCardProps = {
  template: TemplateSummary;
  /** Which action is in flight, so only that button spins. */
  busy: TemplateAction | null;
  onAction: (template: TemplateSummary, action: TemplateAction) => void;
};

/**
 * A ready-made day. The three actions are three different intents and none of
 * them is a menu item: run it now, keep it as a starting point, or just build
 * the fake company and go poke at it in Gmail.
 */
export function TemplateCard({ template, busy, onAction }: TemplateCardProps) {
  const hours = Math.round((template.ticks * template.simMinutesPerTick) / 60);

  return (
    <Card padding="lg" radius="2xl" interactive className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <h3 className="font-display text-[23px] text-sn-ink">{template.title}</h3>
        <p className="mt-2 line-clamp-2 text-[13.5px] leading-[21px] text-sn-muted">
          {template.description}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {template.services.map((service) => (
            <Chip key={service.twin} service={service.twin} size="sm">
              {SERVICE_LABELS[service.twin]}
              {service.count === undefined ? "" : ` · ${service.count} ${service.unit}`}
            </Chip>
          ))}
          <Chip size="sm" icon={<IconLayers size={11} />}>
            {hours}h day
          </Chip>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={busy === "use"}
          disabled={busy !== null && busy !== "use"}
          iconRight={<IconArrowRight size={13} />}
          onClick={() => onAction(template, "use")}
        >
          Run this day
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={busy === "copy"}
          disabled={busy !== null && busy !== "copy"}
          onClick={() => onAction(template, "copy")}
        >
          Save &amp; edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === "environment"}
          disabled={busy !== null && busy !== "environment"}
          icon={<IconPlay size={12} />}
          onClick={() => onAction(template, "environment")}
        >
          Build the company
        </Button>
      </div>
    </Card>
  );
}
