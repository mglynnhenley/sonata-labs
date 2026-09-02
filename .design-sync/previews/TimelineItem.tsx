import {
  Badge,
  CodeBlock,
  IconAlert,
  IconCheck,
  IconMail,
  Timeline,
  TimelineItem,
} from "@sonata/ui";

/** Full anatomy inside its parent rail: clock gutter, marker, title, quiet line, meta. */
export const Anatomy = () => (
  <div style={{ maxWidth: 560 }}>
    <Timeline>
      <TimelineItem
        time="10:42"
        timeMeta="tick 34"
        tone="gmail"
        icon={<IconMail size="sm" />}
        title="Sent reply to Dr. Kapoor"
        description="Re: Q3 pilot — renewal terms. Both revised terms restated."
        meta={<Badge status="passed" size="sm" />}
      />
      <TimelineItem
        time="11:30"
        timeMeta="tick 41"
        title="Updated the CRM note"
        description="No criterion attached — logged for provenance."
      />
    </Timeline>
  </div>
);

/** Expandable evidence, open — the tool call behind the moment. */
export const ExpandedEvidence = () => (
  <div style={{ maxWidth: 560 }}>
    <Timeline>
      <TimelineItem
        time="10:42"
        timeMeta="tick 34"
        tone="passed"
        icon={<IconCheck size="sm" />}
        title="Replied to Dr. Kapoor"
        description="Criterion 3 passed — click to see the call the agent made."
        meta={<Badge status="passed" size="sm" />}
        defaultOpen
      >
        <CodeBlock
          language="json"
          copyable={false}
          code={`{
  "tool": "gmail.send",
  "to": "d.kapoor@meridianbio.com",
  "subject": "Re: Q3 pilot — renewal terms",
  "tick": 34
}`}
        />
      </TimelineItem>
      <TimelineItem
        time="11:05"
        timeMeta="tick 38"
        tone="failed"
        icon={<IconAlert size="sm" />}
        title="Missed the CFO's follow-up"
        description="Criterion 7 failed — the thread sat unread for the rest of the day."
        meta={<Badge status="failed" size="sm" />}
      >
        Collapsed evidence — the chevron opens the judge's reasoning.
      </TimelineItem>
    </Timeline>
  </div>
);

/** `active` — the moment the replay is parked on wears a ring and a soft wash. */
export const ActiveMoment = () => (
  <div style={{ maxWidth: 560 }}>
    <Timeline>
      <TimelineItem time="09:40" timeMeta="tick 18" title="Accepted the moved standup" />
      <TimelineItem
        time="10:42"
        timeMeta="tick 34"
        tone="primary"
        active
        title="Sent reply to Dr. Kapoor"
        description="Autonomy at this point: 81%."
      />
      <TimelineItem time="11:30" timeMeta="tick 41" title="Updated the CRM note" />
    </Timeline>
  </div>
);
