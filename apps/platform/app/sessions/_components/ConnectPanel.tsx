import { Card, buttonClasses } from "@sonata/ui";

export function ConnectPanel() {
  return (
    <Card padding="lg">
      <h2 className="font-display text-sn-2xl text-sn-ink">Choose how to test</h2>
      <p className="mt-1.5 max-w-[74ch] text-sn-base text-sn-muted">
        To test a model, choose a scenario and model on the Runs page. Inspect connects it to a
        private workplace automatically. To try the work yourself, start a manual session below
        and open its browser apps once they are ready.
      </p>
      <a href="/runs" className={`${buttonClasses("secondary", "md")} mt-4`}>
        Run a model with Inspect
      </a>
      <p className="mt-4 max-w-[74ch] text-sn-sm text-sn-subtle">
        Docker needs to be running. Each session has its own apps and files, and its browser links
        work while that session is active.
      </p>
      <details className="mt-4 max-w-[74ch] text-sn-sm text-sn-muted">
        <summary className="cursor-pointer font-medium text-sn-ink">Connecting your own harness</summary>
        <p className="mt-2">
          Create a session through the session API and keep its returned connection details.
          Your harness runs Sonata&rsquo;s tool server inside the container assigned to that session.
          It receives private app connections and provider credentials after setup. Browser links
          are for you to inspect or test the apps; use the session connection for agent tools.
        </p>
      </details>
    </Card>
  );
}
