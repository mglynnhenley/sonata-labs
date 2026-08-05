"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Chip, IconSpark, Modal, cn } from "@sonata/ui";
import { DEFAULT_MODELS, MODEL_CATALOG, modelLabel } from "@/lib/models";

// Re-judging is the payoff of keeping everything in the artifact: a run recorded
// months ago can be read again by a different model, with no twin running and no
// agent replayed. Only the judge's half of the verdict changes — the checklist
// is deterministic and stays exactly as it was.

/**
 * Shortcuts, not a whitelist: the box takes any OpenRouter slug, and the point
 * of re-judging is usually to try a model the settings page never picked. One
 * per vendor keeps the row short and the comparison meaningful.
 */
const SUGGESTIONS = [...new Map(MODEL_CATALOG.map((m) => [m.vendor, m.id])).values()];

export function RejudgeButton({
  runId,
  currentModel,
  variant = "secondary",
}: {
  runId: string;
  /** The model that judged it last, pre-filled so a re-run is one click. */
  currentModel?: string;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState(currentModel ?? DEFAULT_MODELS.judge);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/results/${encodeURIComponent(runId)}/rejudge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || `The judge call failed (HTTP ${res.status}).`);
      setOpen(false);
      // The page reads the artifact on every request, so a refresh is the update.
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A run nobody has judged is not being *re*-judged, and calling it that is how
  // a first-time user concludes they have missed a step somewhere.
  const first = !currentModel;

  return (
    <>
      <Button variant={variant} icon={<IconSpark size={14} />} onClick={() => setOpen(true)}>
        {first ? "Judge this run" : "Re-judge with another model"}
      </Button>

      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={first ? "Judge this run" : "Re-judge this run"}
        description={
          first
            ? "A model reads the saved day and names what went wrong, with evidence for each finding. Nothing is re-run — the deterministic checklist stays exactly as it is."
            : "The saved day is read again by a different model. Nothing is re-run: the checklist and the autonomy score are counted off the day itself and stay put — only the diagnosis changes."
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={!model.trim()} onClick={submit}>
              {first ? "Judge it" : "Judge it again"}
            </Button>
          </>
        }
      >
        <label className="block text-[12px] font-medium text-sn-ink" htmlFor="rejudge-model">
          Model
        </label>
        <input
          id="rejudge-model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          spellCheck={false}
          placeholder="provider/model-slug"
          className={cn(
            "mt-1.5 h-9 w-full rounded-sn-md border border-sn-line bg-sn-surface px-3 font-mono text-[12.5px] text-sn-ink",
            "transition-colors duration-150 ease-sn placeholder:text-sn-subtle hover:border-sn-line-strong",
          )}
        />
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {SUGGESTIONS.map((slug) => (
            <Chip
              key={slug}
              size="sm"
              icon={false}
              selected={model === slug}
              onClick={() => setModel(slug)}
              title={slug}
            >
              {modelLabel(slug)}
            </Chip>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-sn-muted">
          Any OpenRouter slug works. The key comes from OPENROUTER_API_KEY on this machine.
        </p>
        {error ? (
          <p className="mt-3 rounded-sn-md border border-sn-failed-line bg-sn-failed-soft p-2.5 text-[12.5px] text-sn-failed-ink">
            {error}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
