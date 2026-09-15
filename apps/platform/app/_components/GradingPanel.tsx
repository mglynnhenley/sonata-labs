"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconAlert,
  IconCheck,
  IconClose,
  IconLayers,
  SERVICE_LABELS,
  Spinner,
  useToast,
} from "@sonata/ui";
import {
  CRITERION_KINDS,
  TWIN_NAMES,
  asCriterionKind,
  type Criterion,
  type CriterionKind,
  type EpisodeSpec,
} from "@sonata/core";
import { dayRange } from "@/lib/format";
import { apiGet, apiSend } from "../api/_lib/client";
import type { EpisodeRecord, EpisodeSummary } from "../api/_lib/types";

// The grading half of a saved scenario, editable: what the agent is told, how
// long its day runs, the rubric it is scored against, and what the judge is
// asked in prose. The other half — cast, channels, beats — is assembled in code
// out of ids and ISO instants that no text field can produce, so it is not here
// and /api/episodes/[episodeId] will not take it either.
//
// Failures are reported where the eye already is. A rejected checklist prints
// above the list, because the server's sentence names the row it means and a
// corner of the screen is the wrong place to name a row. A save that failed on a
// field the user has already looked away from takes a toast that does not time
// out. Success says nothing louder than the word "Saved".

// The same control string SettingsForm uses, character for character. Every
// input in this product is that height with that border, and a second spelling
// of it is how one app starts looking like two.
const CONTROL =
  "h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-2.5 text-sn-base text-sn-ink " +
  "shadow-sn-xs transition-colors duration-150 ease-sn hover:border-sn-line-strong";

// The brief box, as NewScenarioComposer writes it — same reason as CONTROL.
const TEXTAREA =
  "w-full resize-y [field-sizing:content] min-h-[4.5rem] rounded-sn-lg border border-sn-line bg-sn-surface px-4 py-3.5 " +
  "text-sn-md leading-[24px] text-sn-ink shadow-sn-xs placeholder:text-sn-subtle " +
  "transition-colors duration-150 ease-sn hover:border-sn-line-strong disabled:opacity-60";

/**
 * The one-line meaning of each kind, taken from the doc comment above
 * `CRITERION_KINDS` itself.
 *
 * A total `Record` and not a lookup with a fallback: a kind added to the
 * vocabulary and not explained here fails to compile, which is the only thing
 * that keeps this help text from quietly falling behind the checkers.
 */
const KIND_MEANING: Record<CriterionKind, string> = {
  replied: "a reply landed on the thread or message named by ref",
  sent: "a new email, DM or invitation reached target",
  posted: "something was posted in the channel named by expect",
  labelled: "the item named by ref carries the label in expect",
  archived: "the item named by ref left the inbox or queue",
  scheduled: "an event matching expect exists that did not before",
  moved: "the event named by ref changed time",
  cancelled: "the event named by ref is cancelled",
  untouched: "the item named by ref was deliberately left alone",
  mentions: "something the agent wrote contains expect, or names target",
  "no-escalation": "the agent never handed the job back to a human",
  judged: "nothing deterministic can settle it — the judge answers it",
};

type SaveField = "task" | "ticks" | "checklist" | "questions";
type SaveState = "idle" | "saving" | "saved";
type SaveMap = Record<SaveField, SaveState>;

const IDLE: SaveMap = { task: "idle", ticks: "idle", checklist: "idle", questions: "idle" };

const FAILURE_TITLE: Record<SaveField, string> = {
  task: "The brief was not saved",
  ticks: "The day length was not saved",
  checklist: "The checklist was not saved",
  questions: "The judge's questions were not saved",
};

/** Exactly the subset of the spec this panel is allowed to change. */
interface GradingPatch {
  task?: string;
  ticks?: number;
  checklist?: Criterion[];
  judgeQuestions?: string[];
}

/**
 * A checklist row on screen.
 *
 * UI keys refresh after a save so uncontrolled numeric fields adopt normalized
 * values. Criterion IDs remain stable for evidence references across runs.
 */
interface Row {
  key: string;
  criterion: Criterion;
}

/** "9 hours", "6.5 hours" — the day's length in the unit people actually think in. */
function hoursOf(ticks: number, simMinutesPerTick: number): string {
  const hours = (ticks * simMinutesPerTick) / 60;
  const value = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${value} hour${hours === 1 ? "" : "s"}`;
}

function surfaceOf(twin: Criterion["twin"]): string {
  return twin === "any" ? "across the whole day" : SERVICE_LABELS[twin];
}

function SaveNote({ state }: { state: SaveState }) {
  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-sn-sm text-sn-subtle"
    >
      {state === "saving" ? (
        <>
          <Spinner size="sm" label="" />
          Saving…
        </>
      ) : state === "saved" ? (
        <>
          <IconCheck size="sm" className="text-sn-success" />
          Saved
        </>
      ) : null}
    </span>
  );
}

/** The picker cannot say "Loading…" forever when the list is what failed. */
function placeholderFor(episodes: EpisodeSummary[] | null, failed: boolean): string {
  if (episodes) return "Choose a scenario…";
  return failed ? "The list could not be loaded" : "Loading saved scenarios…";
}

function Rejection({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-sn-lg border border-sn-failed-line bg-sn-failed-soft px-4 py-3">
      <IconAlert size="md" className="mt-0.5 shrink-0 text-sn-danger" />
      <p className="text-sn-base text-sn-failed-ink">{message}</p>
    </div>
  );
}

export function GradingPanel({
  fixedEpisodeId,
  initialEpisode,
}: {
  fixedEpisodeId?: string;
  initialEpisode?: EpisodeRecord;
} = {}) {
  const { toast } = useToast();
  const router = useRouter();
  const [continuing, setContinuing] = useState(false);
  const leaving = useRef(false);

  const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);
  const [episodeId, setEpisodeId] = useState<string>(fixedEpisodeId ?? "");
  const [record, setRecord] = useState<EpisodeRecord | null>(initialEpisode ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [taskDraft, setTaskDraft] = useState(initialEpisode?.spec.task ?? "");
  const [ticksDraft, setTicksDraft] = useState(initialEpisode ? String(initialEpisode.spec.clock.ticks) : "");
  const [rows, setRows] = useState<Row[]>(() => (initialEpisode?.spec.success.checklist ?? []).map((criterion, index) => ({ key: `initial-${index}`, criterion })));
  const [questions, setQuestions] = useState<string[]>(initialEpisode?.spec.success.judgeQuestions ?? []);
  const [checklistError, setChecklistError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveMap>(IDLE);

  const nextKey = useRef(0);

  const toRows = useCallback(
    (checklist: Criterion[]): Row[] =>
      checklist.map((criterion) => ({ key: `row-${nextKey.current++}`, criterion })),
    [],
  );

  // Everything on screen is re-read from the record the server just returned, so
  // what is shown is what is stored: the route trims prose, rounds ticks, drops
  // blank questions and throws away criterion fields the check does not read.
  const adopt = useCallback(
    (episode: EpisodeRecord) => {
      setRecord(episode);
      setTaskDraft(episode.spec.task);
      setTicksDraft(String(episode.spec.clock.ticks));
      setRows(toRows(episode.spec.success.checklist));
      setQuestions(episode.spec.success.judgeQuestions);
      setChecklistError(null);
    },
    [toRows],
  );

  // The choice lives in the URL so a rubric is a link somebody can send. Read in
  // an effect rather than during render — the server has no `location` and the
  // paint would not match — and off the DOM rather than through
  // `useSearchParams`, which would oblige every host of this panel to wrap it in
  // a Suspense boundary it did not ask for.
  useEffect(() => {
    if (fixedEpisodeId) { setEpisodeId(fixedEpisodeId); return; }
    const controller = new AbortController();
    void (async () => {
      try {
        const { episodes: list } = await apiGet<{ episodes: EpisodeSummary[] }>(
          "/api/episodes",
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setEpisodes(list);
        const wanted = new URLSearchParams(window.location.search).get("scenario");
        if (wanted && list.some((episode) => episode.id === wanted)) setEpisodeId(wanted);
      } catch (err) {
        if (!controller.signal.aborted) setLoadError((err as Error).message);
      }
    })();
    return () => controller.abort();
  }, [fixedEpisodeId]);

  useEffect(() => {
    if (initialEpisode?.id === episodeId) return;
    if (!episodeId) {
      setRecord(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const { episode } = await apiGet<{ episode: EpisodeRecord }>(
          `/api/episodes/${encodeURIComponent(episodeId)}`,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        adopt(episode);
        setLoadError(null);
        setSaveState(IDLE);
      } catch (err) {
        if (!controller.signal.aborted) setLoadError((err as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [episodeId, adopt, initialEpisode]);

  const dirty = record !== null && (
    taskDraft !== record.spec.task ||
    ticksDraft !== String(record.spec.clock.ticks) ||
    JSON.stringify(rows.map((row) => row.criterion)) !== JSON.stringify(record.spec.success.checklist) ||
    JSON.stringify(questions) !== JSON.stringify(record.spec.success.judgeQuestions)
  );
  const busy = continuing || Object.values(saveState).some((state) => state === "saving");

  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeLink = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.("a[href]");
      if (!anchor || leaving.current || anchor.getAttribute("href")?.startsWith("#")) return;
      if (!window.confirm("You have unsaved scenario changes. Leave without saving them?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", beforeLink, true);
    };
  }, [dirty, busy]);

  async function saveReview(goToRun = false) {
    if (!record || busy) return;
    setContinuing(true);
    // One validated PATCH saves the full review before navigation. A rejected
    // rubric leaves every draft on screen and never starts a run.
    if (dirty) {
      const ticks = Number(ticksDraft);
      if (!Number.isInteger(ticks) || ticks < 1 || ticks > 200) {
        setChecklistError("Choose a whole number of agent turns between 1 and 200.");
        setContinuing(false);
        return;
      }
      const saved = await save("checklist", {
        task: taskDraft,
        ticks,
        checklist: rows.map((row) => row.criterion),
        judgeQuestions: questions,
      });
      if (!saved) { setContinuing(false); return; }
      adopt(saved);
    }
    if (goToRun) {
      leaving.current = true;
      router.push(`/runs?scenario=${encodeURIComponent(episodeId)}`);
    } else {
      setContinuing(false);
    }
  }

  // Built by assignment rather than as a computed-key literal, which TypeScript
  // widens to a string index signature — the same dance as SettingsForm's
  // `saveModel`.
  function mark(field: SaveField, state: SaveState): void {
    setSaveState((current) => {
      const next: SaveMap = { ...current };
      next[field] = state;
      return next;
    });
  }

  async function save(field: SaveField, patch: GradingPatch): Promise<EpisodeRecord | null> {
    if (!episodeId) return null;
    mark(field, "saving");
    try {
      const { episode } = await apiSend<{ episode: EpisodeRecord; ticks: number }>(
        `/api/episodes/${encodeURIComponent(episodeId)}`,
        "PATCH",
        patch,
      );
      setRecord(episode);
      if (field === "checklist") setChecklistError(null);
      mark(field, "saved");
      return episode;
    } catch (err) {
      mark(field, "idle");
      const message = (err as Error).message;
      // A rejected checklist names the criterion it means — ref "escalation" is
      // not a beat in this day — so it belongs beside the rows, not in a corner.
      if (field === "checklist") setChecklistError(message);
      else toast({ title: FAILURE_TITLE[field], description: message, tone: "error", duration: 0 });
      return null;
    }
  }

  function choose(id: string): void {
    if (dirty && !window.confirm("You have unsaved scenario changes. Switch without saving them?")) return;
    setEpisodeId(id);
    setLoadError(null);
    // Replace, never push: a picker that stacks history entries turns Back into
    // a tour of everything you looked at. Next's router patches these two
    // methods, so the URL stays in step with the rest of the app's navigation.
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("scenario", id);
    else url.searchParams.delete("scenario");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  function editRows(update: (current: Row[]) => Row[]): void {
    setRows(update);
    mark("checklist", "idle");
  }

  function editQuestions(update: (current: string[]) => string[]): void {
    setQuestions(update);
    mark("questions", "idle");
  }

  function patchRow(key: string, patch: Partial<Criterion>): void {
    editRows((current) =>
      current.map((row) =>
        row.key === key ? { key: row.key, criterion: { ...row.criterion, ...patch } } : row,
      ),
    );
  }

  function addRow(): void {
    const key = `row-${nextKey.current++}`;
    editRows((current) => [
      ...current,
      {
        key,
        criterion: {
          id: `criterion-${crypto.randomUUID()}`,
          description: "",
          // `any/judged` is the pair that asks for nothing but a sentence, so a
          // new row is one description away from binding instead of arriving
          // already owing a beat ref it has no way to name.
          twin: "any",
          kind: "judged",
          weight: 1,
          severity: "should",
        },
      },
    ]);
  }

  const spec: EpisodeSpec | null = record?.spec ?? null;
  const summary = episodes?.find((episode) => episode.id === episodeId) ?? null;

  return (
    <div className="sn-stack-section">
      {!fixedEpisodeId ? <Card
        padding="lg"
        title="Which scenario are you grading?"
        subtitle="One saved day at a time. Everything below belongs to the day you pick here."
      >
        <div className="max-w-[420px]">
          <label className="sr-only" htmlFor="grading-scenario">
            Scenario
          </label>
          <select
            id="grading-scenario"
            className={CONTROL}
            value={episodeId}
            disabled={episodes === null}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">{placeholderFor(episodes, loadError !== null)}</option>
            {(episodes ?? []).map((episode) => (
              <option key={episode.id} value={episode.id}>
                {episode.title}
              </option>
            ))}
          </select>
        </div>
        {summary ? (
          <p data-numeric className="mt-2 text-sn-sm text-sn-subtle">
            {summary.counts.beats} beats · {summary.counts.criteria} criteria ·{" "}
            {summary.counts.ticks} ticks · {summary.worldName}
          </p>
        ) : null}
      </Card> : null}

      {loadError ? (
        <Rejection message={loadError} />
      ) : loading ? (
        <span className="inline-flex items-center gap-2.5 text-sn-base text-sn-muted">
          <Spinner size="sm" />
          Reading the scenario…
        </span>
      ) : !spec ? (
        <EmptyState
          icon={<IconLayers size="lg" />}
          title="Pick a day to grade"
          description="Grading is the half of a scenario you can edit by hand: the brief the agent gets, how long its day is, and what counts as having done the job."
          hints={[
            "The rubric is checked in code first, and put to the judge in prose only where no checker can reach",
            "A must that fails, fails the run. A should only costs score",
            "Nothing here touches a run that has already happened",
          ]}
        />
      ) : (
        <>
          {fixedEpisodeId ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-sn-lg border border-sn-line bg-sn-surface p-4">
              <div>
                <p className="text-sn-base font-medium text-sn-ink">Review what success looks like, then run</p>
                <p className="mt-1 text-sn-sm text-sn-muted" aria-live="polite">
                  {busy ? "Saving your review…" : dirty ? "You have unsaved changes. Continue saves them first." : "Your review is saved. Next, choose an agent and review the cost."}
                </p>
              </div>
              <Button variant="primary" loading={continuing} disabled={busy && !continuing}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void saveReview(true)}>
                {dirty ? "Save and continue to run" : "Continue to run"}
              </Button>
            </div>
          ) : null}
          <fieldset disabled={busy} className="sn-stack-section min-w-0 border-0 p-0">
          <details>
          <summary className="cursor-pointer text-sn-base font-medium text-sn-ink">Read or edit the agent’s instructions</summary>
          <div className="mt-3">
          <Card
            padding="lg"
            title="The agent’s brief"
            subtitle="The instructions the agent receives at the start. Describe its responsibilities and boundaries."
            actions={<SaveNote state={saveState.task} />}
          >
            <label className="sr-only" htmlFor="grading-task">
              The agent&apos;s brief
            </label>
            <textarea
              id="grading-task"
              rows={6}
              className={TEXTAREA}
              value={taskDraft}
              onChange={(e) => {
                setTaskDraft(e.target.value);
                mark("task", "idle");
              }}
              onBlur={async () => {
                if (fixedEpisodeId) return;
                // The !== guard is the whole point of saving on blur: a field
                // somebody tabbed through must not PATCH what it already holds.
                if (taskDraft.trim() === spec.task) return;
                const saved = await save("task", { task: taskDraft });
                if (saved) setTaskDraft(saved.spec.task);
              }}
            />
            <p className="mt-2 max-w-[70ch] text-sn-sm text-sn-subtle">
              This is the agent&apos;s entire job description, handed over once at the start of the
              day. Everything after that it has to find for itself.
            </p>
          </Card>
          </div>
          </details>

          <details>
          <summary className="cursor-pointer text-sn-base font-medium text-sn-muted">
            Scenario duration · {hoursOf(spec.clock.ticks, spec.clock.simMinutesPerTick)}
          </summary>
          <div className="mt-3">
          <TickLength
            spec={spec}
            draft={ticksDraft}
            state={saveState.ticks}
            onDraft={(value) => {
              setTicksDraft(value);
              mark("ticks", "idle");
            }}
            onCommit={async (ticks) => {
              if (fixedEpisodeId) { setTicksDraft(String(ticks)); return; }
              const saved = await save("ticks", { ticks });
              setTicksDraft(String(saved ? saved.spec.clock.ticks : ticks));
            }}
          />
          </div>
          </details>

          <Card
            padding="lg"
            title="What success looks like"
            subtitle="Required outcomes must pass. Other outcomes contribute to the score. Describe acceptable results, including actions the agent must avoid."
            actions={<SaveNote state={saveState.checklist} />}
          >
            {checklistError ? (
              <div className="mb-4">
                <Rejection message={checklistError} />
              </div>
            ) : null}

            {rows.length === 0 ? (
              <p className="text-sn-base text-sn-muted">
                Nothing here yet. A day with an empty checklist can only be scored on the
                judge&apos;s prose, which the API refuses to save.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-sn-line">
                {rows.map((row) => (
                  <CriterionRow
                    key={row.key}
                    row={row}
                    onPatch={patchRow}
                    onRemove={(key) =>
                      editRows((current) => current.filter((other) => other.key !== key))
                    }
                  />
                ))}
              </ul>
            )}

            <p className="mt-4 max-w-[76ch] text-sn-sm text-sn-subtle">
              Open “How this is checked” to inspect the evidence and scoring rules behind an outcome.
              Changing an outcome’s wording does not change its automatic evidence check.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-sn-line pt-4">
              <Button size="sm" variant="secondary" onClick={addRow}>
                Add an outcome
              </Button>
              {!fixedEpisodeId ? <Button
                size="sm"
                variant="secondary"
                loading={saveState.checklist === "saving"}
                onClick={async () => {
                  const saved = await save("checklist", {
                    checklist: rows.map((row) => row.criterion),
                  });
                  if (saved) setRows(toRows(saved.spec.success.checklist));
                }}
              >
                Save outcomes
              </Button> : null}
              <p className="text-sn-sm text-sn-subtle">
                Changes are validated when you save.
              </p>
            </div>
          </Card>

          <details>
          <summary className="cursor-pointer text-sn-base font-medium text-sn-ink">Questions for the report · {questions.length}</summary>
          <div className="mt-3">
          <Card
            padding="lg"
            title="Questions for the final report"
            subtitle="Optional questions about judgment, drift, and recovery. These add written analysis; they do not change the score."
            actions={<SaveNote state={saveState.questions} />}
          >
            {questions.length === 0 ? (
              <p className="text-sn-base text-sn-muted">
                Add a question if you want the report to examine a particular behavior.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-sn-line">
                {questions.map((question, index) => (
                  // Keyed by position: a question is only ever the text in its own
                  // box, and two blank rows would otherwise share a key.
                  <li key={index} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <textarea
                      rows={2}
                      className={TEXTAREA}
                      value={question}
                      aria-label={`Judge question ${index + 1}`}
                      placeholder="Did it understand what the day was actually about?"
                      onChange={(e) => {
                        const value = e.target.value;
                        editQuestions((current) =>
                          current.map((other, at) => (at === index ? value : other)),
                        );
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      aria-label={`Remove judge question ${index + 1}`}
                      onClick={() =>
                        editQuestions((current) => current.filter((_, at) => at !== index))
                      }
                    >
                      <IconClose size="sm" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-4 max-w-[76ch] text-sn-sm text-sn-subtle">
              These are asked in prose, on top of the checklist. They are for what no checker can
              settle.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-sn-line pt-4">
              <Button
                size="sm"
                variant="secondary"
                disabled={questions.length >= 8}
                onClick={() => editQuestions((current) => [...current, ""])}
              >
                Add a question
              </Button>
              {!fixedEpisodeId ? <Button
                size="sm"
                variant="secondary"
                loading={saveState.questions === "saving"}
                onClick={async () => {
                  const saved = await save("questions", { judgeQuestions: questions });
                  if (saved) setQuestions(saved.spec.success.judgeQuestions);
                }}
              >
                Save the questions
              </Button> : null}
              <p className="text-sn-sm text-sn-subtle">
                Up to eight questions. Empty questions are removed on save.
              </p>
            </div>
          </Card>
          </div>
          </details>

          </fieldset>
          {fixedEpisodeId ? (
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-sn-line pt-5">
              <Button variant="secondary" disabled={!dirty || busy} onClick={() => void saveReview()}>Save changes</Button>
              <Button variant="primary" loading={continuing} disabled={busy && !continuing} onClick={() => void saveReview(true)}>
                {dirty ? "Save and continue to run" : "Continue to run"}
              </Button>
            </div>
          ) : null}
          <p className="max-w-[76ch] text-sn-sm text-sn-subtle">
            Editing a scenario changes future runs only. Every run embeds the rubric it was played
            against, so past verdicts keep the rubric they were actually judged on — nothing here
            re-scores a day that has already happened.
          </p>
        </>
      )}
    </div>
  );
}

function TickLength({
  spec,
  draft,
  state,
  onDraft,
  onCommit,
}: {
  spec: EpisodeSpec;
  draft: string;
  state: SaveState;
  onDraft: (value: string) => void;
  onCommit: (ticks: number) => void;
}) {
  const parsed = Number(draft);
  const valid = Number.isInteger(parsed) && parsed > 0 && parsed <= 200;
  const ticks = valid ? parsed : spec.clock.ticks;

  // Tick indices run 0 .. ticks-1, so a beat scheduled at or past the new length
  // is a scripted moment the day never reaches. Shortening a day is the cheapest
  // way to silently delete half the story it was written to tell.
  const stranded = spec.beats.filter((beat) => beat.tick >= ticks).length;
  const lastBeat = spec.beats.reduce((high, beat) => Math.max(high, beat.tick), 0);

  return (
    <Card
      padding="lg"
      title="Scenario duration"
      subtitle="Choose how many turns the agent gets. The simulated duration is shown alongside."
      actions={<SaveNote state={state} />}
    >
      <div className="flex flex-wrap items-center gap-4">
        {/* CONTROL is `w-full` and `cn` is not tailwind-merge, so a narrow input
            is a narrow box around it rather than a second width class. */}
        <div className="w-28">
          <label className="sr-only" htmlFor="grading-ticks">
            Ticks in the day
          </label>
          <input
            id="grading-ticks"
            type="number"
            min={1}
            max={200}
            className={CONTROL}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onBlur={() => {
              if (!valid) {
                onDraft(String(spec.clock.ticks));
                return;
              }
              if (parsed !== spec.clock.ticks) onCommit(parsed);
            }}
          />
        </div>
        <p data-numeric className="text-sn-base text-sn-muted">
          {ticks} ticks — {hoursOf(ticks, spec.clock.simMinutesPerTick)},{" "}
          {dayRange(spec.clock.startISO, spec.clock.simMinutesPerTick, ticks)}
        </p>
      </div>

      {stranded > 0 ? (
        <div className="mt-4 flex flex-wrap items-start gap-2.5">
          <Badge status="warning" size="sm" className="mt-0.5">
            {stranded === 1 ? "1 beat never fires" : `${stranded} beats never fire`}
          </Badge>
          <p className="min-w-[20rem] flex-1 text-sn-sm text-sn-gold-ink">
            A {ticks}-tick day stops at tick {ticks - 1}, and this scenario has beats scheduled up
            to tick {lastBeat}. Those scripted moments would never reach the agent, and any
            criterion that names one comes back undecided.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function CriterionRow({
  row,
  onPatch,
  onRemove,
}: {
  row: Row;
  onPatch: (key: string, patch: Partial<Criterion>) => void;
  onRemove: (key: string) => void;
}) {
  const c = row.criterion;
  const flipped = c.severity === "must" ? "should" : "must";

  return (
    <li className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0 sm:flex-nowrap">
      {/* A toggle rather than a select: there are two values, and the badge is
          the word the user already learned on the scenario preview. */}
      <button
        type="button"
        className="mt-1 shrink-0 rounded-full transition-opacity duration-150 ease-sn hover:opacity-80"
        aria-label={`Severity, currently ${c.severity}. Press to make it a ${flipped}.`}
        onClick={() => onPatch(row.key, { severity: flipped })}
      >
        <Badge status={c.severity === "must" ? "warning" : "neutral"} size="sm">
          {c.kind === "judged" ? "Review" : c.severity === "must" ? "Required" : "Scored"}
        </Badge>
      </button>

      <div className="sn-stack-item order-3 w-full min-w-0 sm:order-none sm:w-auto sm:flex-1">
        <textarea
          rows={2}
          className={TEXTAREA}
          value={c.description}
          aria-label="Expected outcome"
          placeholder="The client got an answer before noon"
          onChange={(e) => onPatch(row.key, { description: e.target.value })}
        />

        <p className="text-sn-sm text-sn-muted">{c.kind === "judged" ? "Assessed in written analysis; not automatically verified" : c.twin === "any" ? "Evidence checked across the whole day" : `Evidence checked in ${surfaceOf(c.twin)}`}{c.before ? ` · Deadline: ${c.before}` : ""}</p>
        <details className="text-sn-sm text-sn-muted">
          <summary className="cursor-pointer font-medium">How this is checked</summary>
          <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="w-44">
            <label className="sr-only" htmlFor={`kind-${row.key}`}>
              How it is checked
            </label>
            {/* Never a text field. A model once wrote "mentioned" for "mentions",
                nothing matched, and a must quietly became judge prose. */}
            <select
              id={`kind-${row.key}`}
              className={CONTROL}
              value={c.kind}
              onChange={(e) => {
                const kind = asCriterionKind(e.target.value);
                if (kind) onPatch(row.key, { kind });
              }}
            >
              {CRITERION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </div>

          <div className="w-20">
            <label className="sr-only" htmlFor={`weight-${row.key}`}>
              Weight
            </label>
            {/* `defaultValue`, because a controlled number input snaps an emptied
                field back to 1 under the cursor. The row remounts with a fresh
                key whenever the checklist is re-read, which is what re-syncs it. */}
            <input
              id={`weight-${row.key}`}
              type="number"
              min={1}
              className={CONTROL}
              defaultValue={c.weight}
              onChange={(e) => {
                const weight = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(weight) && weight >= 1) onPatch(row.key, { weight });
              }}
            />
          </div>

          <span className="text-sn-xs text-sn-subtle">
            weight · {surfaceOf(c.twin)}
          </span>
        </div>

        <p className="text-sn-sm text-sn-subtle">{KIND_MEANING[c.kind]}</p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sn-sm text-sn-muted">App
            <select className={`${CONTROL} mt-1`} value={c.twin}
              onChange={(event) => onPatch(row.key, { twin: event.target.value as Criterion["twin"] })}>
              <option value="any">Across the whole day</option>
              {TWIN_NAMES.map((twin) => <option key={twin} value={twin}>{SERVICE_LABELS[twin]}</option>)}
            </select>
          </label>
          {([
            ["ref", "Event reference"],
            ["expect", "Text or item to match"],
            ["target", "Person or recipient"],
            ["before", "Before event reference"],
          ] as const).map(([field, label]) => (
            <label key={field} className="text-sn-sm text-sn-muted">{label}
              <input className={`${CONTROL} mt-1`} value={c[field] ?? ""}
                onChange={(event) => onPatch(row.key, { [field]: event.target.value })} />
            </label>
          ))}
        </div>
        <p className="mt-2 text-sn-xs text-sn-subtle">These fields determine the automatic check. References must match the scenario; changes are validated on save.</p>
        </details>
      </div>

      <Button
        size="sm"
        variant="ghost"
        iconOnly
        className="mt-0.5 ml-auto shrink-0 sm:ml-0"
        aria-label={`Remove criterion: ${c.description || "untitled"}`}
        onClick={() => onRemove(row.key)}
      >
        <IconClose size="sm" />
      </Button>
    </li>
  );
}
