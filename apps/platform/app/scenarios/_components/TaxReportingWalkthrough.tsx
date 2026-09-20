import { Card } from '@sonata/ui';

export function TaxReportingWalkthrough() {
  return <Card padding="lg">
    <p className="text-sn-sm font-medium text-sn-primary-ink">Workflow pilot · AI assisting a human tax adviser</p>
    <h2 className="mt-2 text-sn-xl font-semibold text-sn-ink">What changed in the population, and is the reporting pack ready?</h2>
    <p className="mt-3 max-w-[76ch] text-sn-base leading-relaxed text-sn-muted">Marta takes calls with a bank, private-equity manager, pension provider and insurer. The AI prepares questions, reconciles the bank data, drafts client follow-ups and keeps a clear record of decisions still needed from Daniel, the technical reviewer.</p>
    <div className="mt-8 grid gap-8">
      <section><h3 className="text-sn-base font-semibold text-sn-ink">The work arriving today</h3>
        <ul className="mt-2 space-y-4 text-sn-base leading-relaxed text-sn-muted">
          <li>A bank extract contains a duplicate, a changed account ID, a missing account and incomplete personal details.</li>
          <li>Four human calls produce written notes: conflicting entity classifications, a claimed pension exemption and insurance records with different person roles.</li>
          <li>At 15:00, verified evidence changes one bank account from held to included. The latest pack must change with it.</li>
        </ul>
      </section>
      <section><h3 className="text-sn-base font-semibold text-sn-ink">What good work delivers</h3>
        <ul className="mt-2 space-y-4 text-sn-base leading-relaxed text-sn-muted">
          <li>Before noon: a reconciliation separating source-record changes from approved reporting decisions.</li>
          <li>Before 16:30: an updated internal CSV with matching counts, totals and source versions, plus a four-client status log.</li>
          <li>Before 18:00: a handoff identifying the latest pack, available client drafts, unresolved questions, owners and deadlines.</li>
        </ul>
      </section>
    </div>
    <div className="mt-5 rounded-sn-lg border border-sn-line bg-sn-surface p-4">
      <h3 className="text-sn-base font-semibold text-sn-ink">A concrete failure to look for</h3>
      <p className="mt-2 text-sn-base leading-relaxed text-sn-muted">The morning pack contains five approved accounts totalling £19,100. The 15:00 decision adds one account, taking the final pack to six accounts and £27,100. A reassuring handoff that still links the five-account version has failed to carry the new evidence into the deliverable.</p>
    </div>
    <p className="mt-4 max-w-[76ch] text-sn-sm leading-relaxed text-sn-muted">This is a small, fictional dataset based on the workflow you described. Two automatic checks measure replies; nine criteria need content review. Following supplied case decisions and preparing an internal CSV are measured. Legal classification, tax-authority XML compliance, filing, authority acceptance and actual human time saved are unmeasured. Jurisdiction-specific rules and a real XML specification are needed for a later benchmark.</p>
  </Card>;
}
