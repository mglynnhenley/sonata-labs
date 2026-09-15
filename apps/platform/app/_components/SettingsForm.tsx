"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  IconCheck,
  PageHeader,
  Spinner,
  TabPanel,
  Tabs,
  useToast,
  type TabItem,
} from "@sonata/ui";
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
import { ROUTES } from "@/lib/routes";
import type { SettingsPatch, SettingsView } from "@/lib/settings";
import type { TwinStatus } from "@/lib/twins";
import { track } from "@/lib/track";
import Link from "next/link";
import { TwinStrip } from "./TwinStrip";
import { usePoll } from "./usePoll";

// Settings. Everything saves as you change it — there is no Save button for the
// page, because a settings page with a Save button is a settings page you can
// leave in a state you did not mean. The API key is the one exception: it is
// write-only, so it needs its own deliberate act.
//
// Two tabs: what a day is run with, and how it is graded. One page, because they
// are one set of settings — and the split lives in the URL so "how is a day
// graded" is a link somebody can send.

const CONTROL =
  "h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-2.5 text-sn-base text-sn-ink " +
  "shadow-sn-xs transition-colors duration-150 ease-sn hover:border-sn-line-strong";

const TABS: readonly TabItem[] = [
  { id: "running", label: "Running" },
  { id: "judging", label: "Judging" },
];

type SettingsTab = "running" | "judging";

/** Anything else in `?tab=` is a stale or hand-typed link, not a third tab. */
function asTab(raw: string | null): SettingsTab {
  return raw === "judging" ? "judging" : "running";
}

/**
 * The roles the Running tab chooses. The judge is deliberately missing: its
 * select lives on Judging, beside the explanation of what it is and is not
 * allowed to decide. A second copy here would be a second place to answer one
 * question, and two places drift.
 */
const RUNNING_ROLES = MODEL_ROLES.filter((role) => role !== "judge");

/** The curated catalog, grouped for `optgroup`. */
type VendorGroups = readonly (readonly [string, ModelOption[]])[];

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
        <p className="text-sn-base font-medium text-sn-ink">{label}</p>
        <p className="mt-1 max-w-[52ch] text-sn-base text-sn-muted">{hint}</p>
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

/**
 * One role's model choice, shared by the harness roles on Running and the
 * grader on Judging. Two copies of this select would be two things to edit the
 * day a model joins the catalog, and two ways to look at one decision.
 */
function ModelRow({
  role,
  id,
  byVendor,
  onPick,
}: {
  role: ModelRole;
  id: string;
  byVendor: VendorGroups;
  onPick: (role: ModelRole, id: string) => void;
}) {
  const model = findModel(id);
  return (
    <Row label={ROLE_LABELS[role]} hint={ROLE_HINTS[role]}>
      <label className="sr-only" htmlFor={`model-${role}`}>
        {ROLE_LABELS[role]} model
      </label>
      <select
        id={`model-${role}`}
        className={CONTROL}
        value={id}
        onChange={(e) => onPick(role, e.target.value)}
      >
        {/* An id set by hand or left over from an older catalog stays selectable,
            so opening this page cannot quietly re-point a role. */}
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
      <p className="mt-2 text-sn-sm text-sn-subtle">{priceLine(model, id)}</p>
      {model ? <p className="mt-1 text-sn-sm text-sn-muted">{model.note}</p> : null}
    </Row>
  );
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");

  const tab = asTab(searchParams.get("tab"));

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
      track("settings_saved", { fields: Object.keys(patch) });
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
        // The saving indicator sits here rather than in a panel: a tab switch
        // mid-PATCH must not be able to take the only confirmation off screen.
        meta={
          <span
            aria-live="polite"
            className="inline-flex items-center gap-1.5 text-sn-sm text-sn-subtle"
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

      <Tabs
        items={TABS}
        value={tab}
        // The tab lives in the URL so half a settings page is linkable and
        // survives a refresh — replace, not push: switching tabs is not
        // something the back button should have to undo.
        onValueChange={(id) =>
          router.replace(id === "judging" ? `${ROUTES.settings}?tab=judging` : ROUTES.settings)
        }
        idPrefix="settings"
        label="Settings sections"
      />

      <TabPanel id="running" active={tab === "running"} idPrefix="settings">
        {/* The stack goes inside the panel, never on it: a display utility on the
            panel element itself outranks the `hidden` attribute, and the closed
            tab would hold a section's worth of gap open under the tab bar. */}
        <div className="sn-stack-section">
          <Card
            padding="lg"
            title="Models"
            subtitle="Two parts of a running day. The agent is the one under test; the director is the harness playing everyone else. The model that grades the day is under Judging."
          >
            <div className="flex flex-col">
              {RUNNING_ROLES.map((role: ModelRole) => (
                <ModelRow
                  key={role}
                  role={role}
                  id={settings.models[role]}
                  byVendor={byVendor}
                  onPick={saveModel}
                />
              ))}
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
                  <p data-numeric className="mb-2 text-sn-sm text-sn-subtle">
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
              <span data-numeric className="text-sn-base text-sn-muted">
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

          {/* The last section on the page that still wore a bare h2. Every panel
              names itself now, so the page reads as a stack of titled cards. */}
          <Card
            padding="lg"
            title="The clones"
            subtitle={
              <>
                Three local services on fixed ports. Starting one here runs the workspace&apos;s own dev
                script; the first compile takes a few seconds. Boot output goes to{" "}
                <code className="rounded-sn-sm bg-sn-bg-subtle px-1 py-0.5 text-sn-sm">
                  apps/platform/data/logs
                </code>
                .
              </>
            }
          >
            <div className="pt-1">
              <TwinStrip twins={twinPoll.data.twins} onChanged={twinPoll.refresh} />
            </div>
          </Card>
        </div>
      </TabPanel>

      <TabPanel id="judging" active={tab === "judging"} idPrefix="settings">
        <div className="sn-stack-section">
          <Card
            padding="lg"
            title="How a day is graded"
            subtitle="Every run is scored twice over, by two halves that read the same day and answer different questions."
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Card
                padding="md"
                tone="sunken"
                radius="lg"
                title="First, the checklist"
                actions={
                  <Badge status="neutral" size="sm" dot={false}>
                    Sets the score
                  </Badge>
                }
              >
                <p className="text-sn-base text-sn-muted">
                  A fixed list of things that either happened or did not. Each one is decided in
                  code, against the audit log the clones kept while the day ran, so the same day
                  always gets the same answer — and so every row on a report can quote the
                  message, the post or the invite it was read from.
                </p>
              </Card>

              <Card
                padding="md"
                tone="sunken"
                radius="lg"
                title="Then, the judge"
                actions={
                  <Badge status="neutral" size="sm" dot={false}>
                    Never moves it
                  </Badge>
                }
              >
                <p className="text-sn-base text-sn-muted">
                  One model call, once the checklist is done. It reads the whole finished day back
                  and writes the diagnosis in prose: what went wrong, and which of the catalogued
                  failure modes turned up.
                </p>
              </Card>
            </div>

            <p className="mt-4 max-w-[70ch] text-sn-base text-sn-ink">
              The checklist decides the score and the verdict. The judge cannot move either of
              them: a harsh reading costs a run nothing, and a generous one earns it nothing.
            </p>
          </Card>

          <Card
            padding="lg"
            title="The grader"
            subtitle="One call at the end of a run, over the whole day at once."
          >
            <div className="flex flex-col">
              <ModelRow
                role="judge"
                id={settings.models.judge}
                byVendor={byVendor}
                onPick={saveModel}
              />
            </div>
          </Card>

          <Card padding="lg" title="Scenario rubrics" subtitle="Review the brief, expected outcomes, and report questions alongside the scenario they belong to.">
            <Link className="text-sn-base font-medium text-sn-accent hover:underline"
              href={searchParams.get("scenario") ? `/scenarios/${encodeURIComponent(searchParams.get("scenario")!)}` : "/scenarios"}>
              {searchParams.get("scenario") ? "Review this scenario →" : "Browse scenarios →"}
            </Link>
          </Card>
        </div>
      </TabPanel>
    </div>
  );
}
