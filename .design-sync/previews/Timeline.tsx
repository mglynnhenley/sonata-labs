import {
  Badge,
  Chip,
  IconCalendar,
  IconCheck,
  IconMail,
  IconMessage,
  Timeline,
  TimelineItem,
} from "@sonata/ui";

/** The run view's hero: a workday playing out against the simulated clock. */
export const Workday = () => (
  <div style={{ maxWidth: 560 }}>
    <Timeline>
      <TimelineItem
        time="09:00"
        timeMeta="tick 1"
        tone="gmail"
        icon={<IconMail size="sm" />}
        title="Read the inbox"
        description="12 unread — flagged the Meridian Bio renewal thread as urgent."
      />
      <TimelineItem
        time="09:22"
        timeMeta="tick 12"
        tone="slack"
        icon={<IconMessage size="sm" />}
        title="Asked #client-fires for pricing sign-off"
        description="CFO replied in 4 simulated minutes with revised terms."
        meta={<Chip service="slack" size="sm" icon={false}>#client-fires</Chip>}
      />
      <TimelineItem
        time="09:40"
        timeMeta="tick 18"
        tone="calendar"
        icon={<IconCalendar size="sm" />}
        title="Standup moved to 14:30"
        description="Accepted the new invite without double-booking the client call."
      />
      <TimelineItem
        time="10:42"
        timeMeta="tick 34"
        tone="passed"
        icon={<IconCheck size="sm" />}
        title="Replied to Dr. Kapoor"
        description="Criterion 3 passed — reply landed 18 minutes before the deadline."
        meta={<Badge status="passed" size="sm" />}
      />
    </Timeline>
  </div>
);

/** Marker tones: neutral rail, accent for the current moment, states and services. */
export const MarkerTones = () => (
  <div style={{ maxWidth: 560 }}>
    <Timeline>
      <TimelineItem time="09:00" tone="neutral" title="neutral — plain moments" />
      <TimelineItem time="09:15" tone="primary" title="primary — the moment being replayed" />
      <TimelineItem time="09:30" tone="gold" title="gold — the golden-run reference" />
      <TimelineItem time="10:00" tone="passed" title="passed — a criterion cleared" />
      <TimelineItem time="10:30" tone="failed" title="failed — a criterion missed" />
    </Timeline>
  </div>
);
