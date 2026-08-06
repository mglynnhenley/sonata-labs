import { buildEpisodePrompt } from "@sonata/judge";
import { buildJudgeInput } from "../app/api/results/_lib/rejudge";
import { readRun, readSpec } from "../app/results/_lib/artifacts";

// What a run's judge prompt actually costs, section by section.
//
//   npx tsx scripts/judge-prompt-size.ts <runId>
//
// The judge prompt is built by a pure function off a saved artifact, which means
// its size is knowable for nothing — no key, no model, no run. This script is the
// only thing standing between "we added a section" and finding out what it cost
// on a bill, and it exists because the sections compete: the end state, the trace
// and the timeline are drawn from one context window, and a section that quietly
// doubles is a section that pushed another one out through `fitLines`.
//
// Sections are located by their own headings rather than re-derived, so this
// measures the string that is actually sent.

/** Tokens are the unit that costs money; ~4 chars each is close enough to budget on. */
const CHARS_PER_TOKEN = 4;

/** In prompt order. Every heading `buildEpisodePrompt` can emit. */
const HEADINGS = [
  "THE TASK THE AGENT WAS GIVEN",
  "FIRST, RESTATE THE TASK",
  "HOW MUCH OF THIS RUN YOU ARE READING",
  "THE DAY, AS IT HAPPENED",
  "WHAT THE AGENT DID",
  "WHAT THE AGENT SAID",
  "WHAT THE WORLD DID BACK",
  "WHAT CHANGED ON EACH SURFACE",
  "WHERE THINGS ENDED UP",
  "DETERMINISTIC CHECKS ALREADY RUN",
  "FAILURE MODES TO CHECK",
  "QUESTIONS THIS EPISODE ASKS BY NAME",
  "THE QUESTION",
] as const;

interface Section {
  heading: string;
  chars: number;
}

/** Split the prompt at its headings. A heading absent from this run is skipped. */
function sections(prompt: string): Section[] {
  const found = HEADINGS.map((heading) => ({
    heading,
    at: prompt.startsWith(heading) ? 0 : prompt.indexOf(`\n\n${heading}\n`),
  }))
    .filter((s) => s.at >= 0)
    .sort((a, b) => a.at - b.at);

  return found.map((s, i) => ({
    heading: s.heading,
    chars: (found[i + 1]?.at ?? prompt.length) - s.at,
  }));
}

function row(label: string, chars: number, total: number): string {
  const tokens = Math.round(chars / CHARS_PER_TOKEN);
  const share = total === 0 ? 0 : Math.round((chars / total) * 100);
  return `  ${label.padEnd(38)} ${String(chars).padStart(8)} chars  ${String(tokens).padStart(7)} tok  ${String(share).padStart(3)}%`;
}

function main(): void {
  const runId = process.argv[2];
  if (!runId) throw new Error("Say which run: npx tsx scripts/judge-prompt-size.ts <runId>");

  const run = readRun(runId);
  if (!run) throw new Error(`No run artifact for ${runId}.`);

  const input = buildJudgeInput(run, readSpec(runId));
  const { system, prompt, coverage } = buildEpisodePrompt(input);
  const parts = sections(prompt);
  const total = prompt.length + system.length;

  console.log(`\n${runId} — judge prompt`);
  console.log(row("system", system.length, total));
  for (const p of parts) console.log(row(p.heading.toLowerCase(), p.chars, total));
  console.log(row("TOTAL", total, total));

  const endState = parts.find((p) => p.heading === "WHERE THINGS ENDED UP");
  console.log(
    `\ncoverage  steps ${coverage.steps.shown}/${coverage.steps.total}` +
      `  timeline ${coverage.timeline.shown}/${coverage.timeline.total}` +
      `  narration ${coverage.narration.shown}/${coverage.narration.total}` +
      `  final state ${coverage.finalState?.shown ?? 0}/${coverage.finalState?.total ?? 0}` +
      `  headline ${Math.round(coverage.fraction * 100)}%`,
  );
  console.log(
    `end state  ${endState?.chars ?? 0} chars ` +
      `(~${Math.round((endState?.chars ?? 0) / CHARS_PER_TOKEN)} tokens), ` +
      `${total === 0 ? 0 : Math.round(((endState?.chars ?? 0) / total) * 100)}% of the prompt\n`,
  );
}

main();
