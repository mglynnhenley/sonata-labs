import { Button, Card, EmptyState, IconInbox, IconPlay } from "@sonata/ui";

/** The teaching empty state: what lives here, why it matters, the one next action. */
export const FirstRun = () => (
  <div style={{ maxWidth: 640 }}>
    <EmptyState
      icon={<IconInbox size="md" />}
      title="No runs yet"
      description="A run drops an agent into a cloned workday and scores how much of the job it finished. Your first one takes about two minutes."
      hints={[
        "A live timeline of every email, message and meeting the agent touches",
        "A pass/fail verdict for each criterion the day could decide",
        "Cost per simulated day — most runs land around $0.40",
      ]}
      action={
        <Button variant="primary" icon={<IconPlay size="sm" />}>
          Start the first day
        </Button>
      }
      secondaryAction={<Button variant="ghost">Browse scenarios</Button>}
    />
  </div>
);

/** `sm`, borderless — for the state that already sits inside a Card. */
export const InsideCard = () => (
  <div style={{ maxWidth: 460 }}>
    <Card padding="sm">
      <EmptyState
        size="sm"
        bordered={false}
        title="No sessions today"
        description="Sessions appear here the moment a scheduled run wakes up."
        action={<Button variant="secondary" size="sm">Schedule a run</Button>}
      />
    </Card>
  </div>
);

/** Minimal — title and description only, for narrow side panels. */
export const Minimal = () => (
  <div style={{ maxWidth: 420 }}>
    <EmptyState
      size="sm"
      title="Nothing to review"
      description="Every criterion from The Final Loop has been graded. Check back after the next run."
    />
  </div>
);
