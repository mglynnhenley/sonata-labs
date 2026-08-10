"use client";

import { formatUsd, formatWhen } from "../_lib/summary";
import type { JudgeState } from "./judgeState";

// One set of words for "there is no diagnosis here", said in one place because
// three sections say it. The rule they all follow is the rule the coverage notes
// follow: name what happened, name what it cost, and never let an absence pass
// for a result. "Not judged" with nothing after it is the sentence being retired.

export type JudgeTone = "waiting" | "failed" | "quiet";

export interface JudgeCopy {
  tone: JudgeTone;
  headline: string;
  detail: string;
  /** The second paragraph: what survives the failure, or what to do next. */
  footnote: string | null;
}

/** The deterministic half is a fact whatever the judge did. Said every time. */
const CHECKLIST_STANDS =
  "The checklist and the verdict above are untouched by this — they ran in code against the " +
  "clones, and no model was asked for them.";

export function judgeCopy(state: JudgeState | null): JudgeCopy {
  if (!state) {
    return {
      tone: "quiet",
      headline: "No diagnosis on file for this day",
      detail: "Checking whether one is on its way.",
      footnote: null,
    };
  }

  if (state.state === "judging") {
    return {
      tone: "waiting",
      headline: "A judge is reading this day now",
      detail:
        `${state.model ?? "The judge model"} started ${state.at ? formatWhen(state.at) : "just now"}. ` +
        "Nothing is being re-run — it is reading the saved day start to finish, which takes a minute " +
        "or two. The findings appear here as soon as it answers.",
      footnote: null,
    };
  }

  if (state.state === "failed") {
    const paid = state.spend?.usd ? ` It was billed ${formatUsd(state.spend.usd)} anyway.` : "";
    return {
      tone: "failed",
      headline: "This day could not be diagnosed",
      detail:
        (state.automatic
          ? "The run judged itself when the day ended, and that pass failed: "
          : "The last judge pass failed: ") +
        (state.reason ?? "no reason was recorded.") +
        paid,
      footnote: `${CHECKLIST_STANDS} Judging it again is one press, and costs one model call.`,
    };
  }

  // Judged, but the page rendering this was painted before the report landed —
  // a pass that finished in another tab or another process. Saying "no judge has
  // read this" over a report that exists is the very thing being fixed.
  if (state.state === "judged") {
    return {
      tone: "quiet",
      headline: "This day has been judged",
      detail: `${state.model ?? "A judge"} finished reading it. This page was drawn before the report landed.`,
      footnote: "Reload to see the findings.",
    };
  }

  // `none` with a reason is a day there was never anything to read in — a crash
  // at 09:15, a run stopped before it worked. That is not the same as un-judged.
  if (state.reason) {
    return {
      tone: "quiet",
      headline: "There was nothing here for a judge to read",
      detail: `${state.reason} So no diagnosis was attempted, and a diagnosis of a day that did not happen would be worth nothing.`,
      footnote: null,
    };
  }

  return {
    tone: "quiet",
    headline: "No judge has read this day",
    detail:
      "Runs judge themselves the moment they finish. This one either predates that or was told " +
      "not to, so its diagnosis was never written.",
    footnote: "Judging it now reads the saved day back — nothing is re-run.",
  };
}

/** What the stat card at the top of the page puts under "Failure modes". */
export function judgeStateLabel(state: JudgeState | null): string {
  if (!state) return "not judged";
  if (state.state === "judging") return "being judged";
  if (state.state === "failed") return "could not be judged";
  if (state.state === "none") return state.reason ? "nothing to judge" : "not judged";
  return "judged";
}
