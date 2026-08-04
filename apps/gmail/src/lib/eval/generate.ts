import type { gmail_v1 } from "googleapis";
import { composeFixture } from "./generate/compose";
import { buildTimeline } from "./generate/timeline";
import type { Approach, StageCtx } from "./generate/types";
import type {
  Anchor,
  Contact,
  Exemplar,
  Fixture,
  MailboxProfile,
  StressScenario,
} from "./types";

// Contact binding, plus the pre-pipeline entry point into generation.
//
// The prose-writing that used to live here is now `generate/compose.ts` — stage 6 of
// the pipeline in `generate/pipeline.ts`, which researches the mailbox before writing
// rather than working from a single excerpt. `bindContact` stays here because both
// the pipeline and its composer need it and neither owns it.

const PERSONAL = /(family|friend|spouse|partner|personal|sibling|parent)/i;

/** Choose which real contact plays the scenario's sender role. */
export function bindContact(
  scenario: StressScenario,
  profile: MailboxProfile,
  anchor: Anchor | null,
): Contact {
  const contacts = profile.contacts ?? [];

  // Sensitive-personal wants a personal relationship if the mailbox has one.
  if (scenario.id === "sensitive-personal") {
    const personal = contacts.find((c) => PERSONAL.test(c.relationship));
    if (personal) return personal;
  }

  // Anchored scenarios bind to whoever actually wrote the anchor thread.
  if (scenario.preferAnchor && anchor) {
    const match = contacts.find(
      (c) => c.email.toLowerCase() === anchor.fromAddr.toLowerCase(),
    );
    if (match) return match;
    return {
      name: anchor.fromName,
      email: anchor.fromAddr,
      relationship: "correspondent",
      styleNotes: "Matches the tone of their existing messages in this mailbox.",
    };
  }

  if (contacts.length > 0) return contacts[0];

  // Last resort — a mailbox with no identifiable human correspondents.
  return {
    name: "Sam Okafor",
    email: "sam.okafor@example.com",
    relationship: "colleague",
    styleNotes: "Direct, lowercase, short paragraphs.",
  };
}

export interface GenerateOptions {
  model?: string;
  exemplarCount?: number;
}

/**
 * Generate a concrete fixture for a scenario against this mailbox.
 * Returns the fixture plus the contact the scenario was bound to.
 *
 * This is stage 6 on its own, for callers that already hold an anchor and exemplars
 * and only want the prose: no thread is read, no angle is weighed, and slot times are
 * the scenario's own offsets rebased onto the anchor. Anything holding a live mailbox
 * should call `runPipeline` instead and get all six stages — the research is what
 * makes a scenario hard rather than merely plausible.
 */
export async function generateFixture(args: {
  scenario: StressScenario;
  profile: MailboxProfile;
  anchor: Anchor | null;
  exemplars: Exemplar[];
  options?: GenerateOptions;
}): Promise<{ fixture: Fixture; contact: Contact }> {
  const { scenario, profile, anchor, exemplars } = args;
  // Read once and pass it down: the timeline and the composer must date the same
  // fixture against the same instant.
  const now = Date.now();

  // Stage 5 picks between angles it has a reading of the thread to judge; with no
  // reading there is nothing to pick between, so the scenario's own premise stands.
  const approach: Approach = {
    id: "as-declared",
    angle: `${scenario.title}. ${scenario.difficulty}`,
    rationale: "No angle was weighed — this path never read the thread to weigh one.",
    plausibility: 0.5,
  };

  const ctx: StageCtx = {
    // Stage 6 makes no mailbox call; the handle is on the stage contract for the
    // stages that search and read, and this entry point has none to hand over. Left
    // absent rather than stubbed so a future use fails loudly instead of quietly
    // reading an empty mailbox.
    gmail: undefined as unknown as gmail_v1.Gmail,
    userId: "me",
    scenario,
    profile,
    now,
    model: () => args.options?.model,
    say: () => {},
  };

  return composeFixture(
    {
      anchor,
      // Null is stage 6's signal that nobody read the anchor, so it quotes the raw
      // excerpt rather than a summary of a reading that never happened.
      thread: null,
      timeline: buildTimeline(scenario.slots, anchor?.internalDate ?? null, now),
      approach,
      exemplars,
    },
    ctx,
  );
}
