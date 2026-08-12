"use client";

import { useMemo, useState } from "react";
import { Badge, Button, Card, IconCheck, PageHeader, Spinner, useToast } from "@sonata/ui";
import { dayRange } from "@/lib/format";
import {
  MODEL_CATALOG,
  MODEL_ROLES,
  ROLE_HINTS,
  ROLE_LABELS,
  findModel,
  usd,
  type ModelOption,
  type ModelRole,
} from "@/lib/models";
import type { SettingsPatch, SettingsView } from "@/lib/settings";
import type { TwinStatus } from "@/lib/twins";
import { TwinStrip } from "./TwinStrip";
import { usePoll } from "./usePoll";

// Settings. Everything saves as you change it — there is no Save button for the
// page, because a settings page with a Save button is a settings page you can
// leave in a state you did not mean. The API key is the one exception: it is
// write-only, so it needs its own deliberate act.

const CONTROL =
  "h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-2.5 text-[13px] text-sn-ink " +
  "shadow-sn-xs transition-colors duration-150 ease-sn hover:border-sn-line-strong";

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-3 border-t border-sn-line py-5 first:border-t-0 first:pt-0 md:grid-cols-[minmax(0,1fr)_300px] md:gap-8">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-sn-ink">{label}</p>
        <p className="mt-1 max-w-[52ch] text-[13px] leading-[20px] text-sn-muted">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function priceLine(model: ModelOption | undefined, id: string): string {
  if (!model) return `${id} · not in the curated list`;
  const ctx = `${Math.round(model.contextTokens / 1000)}K context`;
  return `${usd(model.inputUsd)} in / ${usd(model.outputUsd)} out per million tokens · ${ctx}`;
}

/** "2026-08-04T09:00:00-04:00" → "09:00". */
function timeOf(iso: string): string {
  return /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? "09:00";
}

/** Put a new wall-clock time into the same date and the same UTC offset. */
function withTime(iso: string, hhmm: string): string {
  return iso.replace(/T\d{2}:\d{2}/, `T${hhmm}`);
}

/** "UTC-04:00" — the offset the day is written in, shown but not edited here. */
function zoneOf(iso: string): string {
  const m = /(Z|[+-]\d{2}:?\d{2})$/.exec(iso);
  if (!m) return "no offset";
  return m[1] === "Z" ? "UTC" : `UTC${m[1]}`;
}

export interface SettingsFormProps {
  initialSettings: SettingsView;
  initialTwins: TwinStatus[];
}

export function SettingsForm({ initialSettings, initialTwins }: SettingsFormProps) {
  const { toast } = useToast();
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");

  const twinPoll = usePoll<{ twins: TwinStatus[] }>("/api/twins", 4000, { twins: initialTwins });

  const byVendor = useMemo(() => {
    const groups = new Map<string, ModelOption[]>();
    for (const model of MODEL_CATALOG) {
      const list = groups.get(model.vendor) ?? [];
      list.push(model);
      groups.set(model.vendor, list);
    }
    return [...groups.entries()];
  }, []);

  async function save(patch: SettingsPatch): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json()) as SettingsView & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `${res.status}`);
      setSettings(body);
      setSavedAt(Date.now());
      return true;
    } catch (err) {
      toast({
        title: "That change was not saved",
        description: (err as Error).message,
        tone: "error",
        duration: 0,
      });
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Built explicitly rather than as a computed-key literal, which TypeScript
  // widens to a string index signature.
  function saveModel(role: ModelRole, id: string): void {
    const models: Partial<Record<ModelRole, string>> = {};
    models[role] = id;
    void save({ models });
  }

  const clock = settings;

  return (
    <div className="sn-stack-section">
      <PageHeader
        eyebrow="Settings"
        title="How Sonata runs"
        subtitle="Which models play which part, the key they run on, the shape of a simulated day, and the three clones the day happens in."
        meta={
          <span
            aria-live="polite"
            className="inline-flex items-center gap-1.5 text-[12px] text-sn-subtle"
          >
            {saving ? (
              <>
                <Spinner size="sm" label="" />
                Saving…
              </>
            ) : savedAt ? (
              <>
                <IconCheck size="sm" className="text-sn-success" />
                All changes saved
              </>
            ) : (
              "Changes save as you make them"
            )}
          </span>
        }
      />

      <Card
        padding="lg"
        title="Models"
        subtitle="Three parts, three choices. The agent is the one under test; the other two are the harness."
      >
        <div className="flex flex-col">
          {MODEL_ROLES.map((role: ModelRole) => {
            const id = settings.models[role];
            const model = findModel(id);
            return (
              <Row key={role} label={ROLE_LABELS[role]} hint={ROLE_HINTS[role]}>
                <label className="sr-only" htmlFor={`model-${role}`}>
                  {ROLE_LABELS[role]} model
                </label>
                <select
                  id={`model-${role}`}
                  className={CONTROL}
                  value={id}
                  onChange={(e) => saveModel(role, e.target.value)}
                >
                  {!model ? <option value={id}>{id}</option> : null}
                  {byVendor.map(([vendor, models]) => (
                    <optgroup key={vendor} label={vendor}>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <p className="mt-2 text-[12px] leading-[18px] text-sn-subtle">
                  {priceLine(model, id)}
                </p>
                {model ? (
                  <p className="mt-1 text-[12px] leading-[18px] text-sn-muted">{model.note}</p>
                ) : null}
              </Row>
            );
          })}
        </div>
      </Card>

      <Card
        padding="lg"
        title="OpenRouter key"
        subtitle="Every model call goes through OpenRouter. The key is stored in this machine's platform.db and never leaves it."
        actions={
          settings.apiKey.source === "none" ? (
            <Badge status="warning">No key</Badge>
          ) : settings.apiKey.source === "env" ? (
            <Badge status="neutral">From the environment</Badge>
          ) : (
            <Badge status="passed">Stored</Badge>
          )
        }
      >
        <div className="flex flex-col">
          <Row
            label="API key"
            hint={
              settings.apiKey.source === "env"
                ? "Currently reading OPENROUTER_API_KEY from the environment. Save a key here to override it."
                : settings.apiKey.source === "stored"
                  ? "Saved. Paste a new one to replace it, or remove it to fall back to OPENROUTER_API_KEY."
                  : "Get one at openrouter.ai/keys. Without it, nothing can run."
            }
          >
            {settings.apiKey.masked ? (
              <p data-numeric className="mb-2 text-[12px] text-sn-subtle">
                {settings.apiKey.masked}
              </p>
            ) : null}
            <label className="sr-only" htmlFor="api-key">
              OpenRouter API key
            </label>
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-or-v1-…"
              className={CONTROL}
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={apiKeyDraft.trim().length === 0}
                onClick={async () => {
                  if (await save({ apiKey: apiKeyDraft.trim() })) {
                    setApiKeyDraft("");
                    toast({ title: "Key saved", tone: "success" });
                  }
                }}
              >
                Save the key
              </Button>
              {settings.apiKey.source === "stored" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void save({ apiKey: "" })}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </Row>
        </div>
      </Card>

      <Card
        padding="lg"
        title="The simulated day"
        subtitle="Defaults for a new scenario. A saved scenario keeps the clock it was written with."
        actions={
          <span data-numeric className="text-[13px] text-sn-muted">
            {dayRange(clock.startISO, clock.simMinutesPerTick, clock.ticks)}
          </span>
        }
      >
        <div className="flex flex-col">
          <Row
            label="The day starts at"
            hint={`Local time in the cloned company (${zoneOf(clock.startISO)}). Everything in a scenario is dated from here, so two runs of the same day stay comparable.`}
          >
            <label className="sr-only" htmlFor="day-start">
              Start of the simulated day
            </label>
            <input
              id="day-start"
              type="time"
              className={CONTROL}
              defaultValue={timeOf(clock.startISO)}
              onChange={(e) => {
                if (e.target.value) void save({ startISO: withTime(clock.startISO, e.target.value) });
              }}
            />
          </Row>

          <Row
            label="Minutes per tick"
            hint="How much simulated time passes between the agent's turns. 15 is a workday that reads naturally."
          >
            <label className="sr-only" htmlFor="tick-minutes">
              Simulated minutes per tick
            </label>
            <input
              id="tick-minutes"
              type="number"
              min={1}
              max={120}
              className={CONTROL}
              defaultValue={clock.simMinutesPerTick}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (n !== clock.simMinutesPerTick) void save({ simMinutesPerTick: n });
              }}
            />
          </Row>

          <Row
            label="Ticks in a day"
            hint="32 ticks of 15 minutes is nine to five. More ticks means a longer day and a bigger bill."
          >
            <label className="sr-only" htmlFor="tick-count">
              Ticks in a day
            </label>
            <input
              id="tick-count"
              type="number"
              min={1}
              max={200}
              className={CONTROL}
              defaultValue={clock.ticks}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (n !== clock.ticks) void save({ ticks: n });
              }}
            />
          </Row>
        </div>
      </Card>

      <section>
        <h2 className="text-[14px] font-medium text-sn-ink">The clones</h2>
        <p className="mt-1 max-w-[62ch] text-[13px] leading-[20px] text-sn-muted">
          Three local services on fixed ports. Starting one here runs the workspace&apos;s own dev
          script; the first compile takes a few seconds. Boot output goes to{" "}
          <code className="rounded-sn-sm bg-sn-bg-subtle px-1 py-0.5 text-[12px]">
            apps/platform/data/logs
          </code>
          .
        </p>
        <div className="mt-6">
          <TwinStrip twins={twinPoll.data.twins} onChanged={twinPoll.refresh} />
        </div>
      </section>
    </div>
  );
}
