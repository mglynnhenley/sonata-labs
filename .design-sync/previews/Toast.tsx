import { Toast } from "@sonata/ui";

/** Toast renders standalone from a record + onDismiss — no provider needed. */
export const Success = () => (
  <Toast
    toast={{
      id: "t-success",
      tone: "success",
      title: "Run scored",
      description: "Claude Haiku 4.5 finished 14 of 16 tasks in Axiom Health's Tuesday.",
    }}
    onDismiss={() => {}}
  />
);

export const ErrorTone = () => (
  <Toast
    toast={{
      id: "t-error",
      tone: "error",
      title: "Scenario failed to start",
      description: "The Slack clone for Axiom Health is still syncing — try again in a minute.",
    }}
    onDismiss={() => {}}
  />
);

export const InfoWithAction = () => (
  <Toast
    toast={{
      id: "t-action",
      tone: "info",
      title: "Day started",
      description: "The agent is working through 22 emails and 4 meetings.",
      action: { label: "Watch the day", onClick: () => {} },
    }}
    onDismiss={() => {}}
  />
);
