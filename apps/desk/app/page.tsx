import { health } from "@/lib/desk";

export const dynamic = "force-dynamic";

// A status page, not a workspace.
//
// The other twins ship a UI because a human needs to see what the agent saw — an
// inbox, a workbook. A desk week has no human user: the agent works through
// tools and the evaluator reads the ledger out of the run artifact, where it
// arrives with the actor on every event. A browsable desk would be a third copy
// of that state whose only job is to look convincing.

export default function Page() {
  let state: ReturnType<typeof health> | null = null;
  let error: string | null = null;
  try {
    state = health();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return (
    <main style={{ font: "14px/1.6 ui-sans-serif, system-ui", margin: "3rem auto", maxWidth: "42rem", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Continuity desk</h1>
      {error ? (
        <p style={{ color: "#a33" }}>{error}</p>
      ) : (
        <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.35rem 1.25rem", marginTop: "1.5rem" }}>
          <dt>Case</dt><dd style={{ margin: 0 }}>{state!.caseId}</dd>
          <dt>Scenario</dt><dd style={{ margin: 0 }}>{state!.scenarioId}</dd>
          <dt>Simulated now</dt><dd style={{ margin: 0 }}>{state!.simTimeISO}</dd>
          <dt>Records</dt><dd style={{ margin: 0 }}>{state!.records}</dd>
        </dl>
      )}
      <p style={{ color: "#667", marginTop: "2rem" }}>
        This desk has no browsable workspace. The agent reaches it through tools, and the
        week&rsquo;s ledger is read out of the run artifact, where every event carries the actor
        that caused it.
      </p>
    </main>
  );
}
