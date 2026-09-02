import { CodeBlock } from "@sonata/ui";

const TOOL_CALL = `{
  "tool": "gmail.send",
  "to": "d.kapoor@meridianbio.com",
  "subject": "Re: Q3 pilot — renewal terms",
  "body_preview": "Dr. Kapoor — confirming the revised terms…",
  "tick": 34,
  "cost_usd": 0.0041
}`;

/** The evidence panel's workhorse: a tool call the agent actually made. */
export const ToolCall = () => (
  <div style={{ maxWidth: 560 }}>
    <CodeBlock language="json" code={TOOL_CALL} />
  </div>
);

/** Line numbers for anything a human might cite by line. */
export const LineNumbers = () => (
  <div style={{ maxWidth: 560 }}>
    <CodeBlock
      filename="run.sh"
      showLineNumbers
      code={`sonata clone --company meridian-bio
sonata run --scenario "the-final-loop" \\
  --model claude-haiku-4.5 \\
  --budget 0.40
sonata score r-0418`}
    />
  </div>
);

/** `wrap` for prose-shaped payloads — the judge's reasoning never scrolls sideways. */
export const Wrapped = () => (
  <div style={{ maxWidth: 460 }}>
    <CodeBlock
      filename="judge — criterion 3"
      wrap
      code={`The agent replied to Dr. Kapoor at tick 34 (simulated 10:42), before the 11:00 deadline, and the reply restates both revised terms. Criterion passed with high confidence.`}
    />
  </div>
);

/** Capped height — long transcripts scroll inside the block, not the page. */
export const Scrollable = () => (
  <div style={{ maxWidth: 560 }}>
    <CodeBlock
      language="log"
      maxHeight="140px"
      code={`09:00 tick 1   read inbox — 12 unread
09:05 tick 4   opened "Q3 pilot — renewal terms"
09:15 tick 9   drafted reply to Dr. Kapoor
09:22 tick 12  slack #client-fires — asked for pricing sign-off
09:40 tick 18  calendar — standup moved to 14:30, accepted
10:12 tick 27  revised draft after CFO reply
10:42 tick 34  sent reply to Dr. Kapoor
11:30 tick 41  updated CRM note
12:00 tick 48  lunch — no actions`}
    />
  </div>
);

/** Chrome off — no header, no copy — for inline snippets inside prose. */
export const Bare = () => (
  <div style={{ maxWidth: 560 }}>
    <CodeBlock copyable={false} code={`npx sonata run --scenario the-final-loop`} />
  </div>
);
