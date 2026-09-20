import { Card } from '@sonata/ui';

export function TaxWorkbookWalkthrough({ excelUrl }: { excelUrl: string }) {
  return <Card padding="lg">
    <p className="text-sn-sm font-medium text-sn-primary-ink">Excel pilot · AI working alongside a human adviser</p>
    <h2 className="mt-2 text-sn-xl font-semibold text-sn-ink">Start with the institution’s categorised investor workbook.</h2>
    <p className="mt-3 max-w-[76ch] text-sn-base leading-relaxed text-sn-muted">North Quay Bank has supplied its existing FATCA and CRS reporting database in Excel. It contains investor records, entity classifications, relationships, evidence and outstanding questions. Marta is the human adviser. The AI helps her progress the engagement through the day.</p>
    <div className="mt-5 flex flex-wrap gap-3">
      <a href={`${excelUrl}/?workbook=nq-bank-investors-2026`} target="_blank" rel="noreferrer" className="rounded-sn-lg bg-sn-primary px-5 py-3 text-sn-base font-semibold text-white">Open the bank’s Excel workbook ↗</a>
      <a href={`${excelUrl}/?workbook=nq-client-casework-2026`} target="_blank" rel="noreferrer" className="rounded-sn-lg border border-sn-line px-5 py-3 text-sn-base font-medium text-sn-primary-ink">Open the other client cases ↗</a>
    </div>
    <div className="mt-8 grid gap-7">
      <section>
        <h3 className="text-sn-lg font-semibold text-sn-ink">What is already there?</h3>
        <p className="mt-2 text-sn-base leading-relaxed text-sn-muted">Sixteen investor records with separate FATCA and CRS categories and reporting decisions; linked entity and person-role records; supplied evidence; and a list of questions already awaiting review. The original workbook stays available alongside the working copy.</p>
      </section>
      <section>
        <h3 className="text-sn-lg font-semibold text-sn-ink">What does the AI work on?</h3>
        <ul className="mt-3 space-y-3 text-sn-base leading-relaxed text-sn-muted">
          <li>Prepare specific questions for Marta’s client meetings and follow up from her notes.</li>
          <li>Investigate missing or conflicting evidence, draft focused client requests and track human decisions.</li>
          <li>Apply an approved change to the named investor, entity and regime. Keep settled and unrelated information intact.</li>
          <li>Prepare the reporting worksheets, check totals by regime and currency, and incorporate a later corrected balance.</li>
          <li>Leave a clear handoff with workbook revisions, source references, unresolved cases and owners.</li>
        </ul>
        <p className="mt-3 text-sn-base leading-relaxed text-sn-muted">One investor also has a change-in-circumstances query. That is one task among the day’s work.</p>
      </section>
      <section className="rounded-sn-lg border border-sn-line bg-sn-surface p-5">
        <h3 className="text-sn-lg font-semibold text-sn-ink">What would a mistake look like?</h3>
        <p className="mt-2 text-sn-base leading-relaxed text-sn-muted">Daniel approves a CRS change for one entity. The AI updates its CRS fields correctly but also overwrites its FATCA classification. The workbook history shows the exact cells, the claimed evidence and the point where the change exceeded the instruction.</p>
      </section>
    </div>
    <p className="mt-5 text-sn-sm leading-relaxed text-sn-muted">The first version uses fictional records and explicit reviewer decisions. We measure work in the actual spreadsheet and its correspondence. Legal correctness, authority XML validation, submission and acceptance are unmeasured. The focused replica supports cell edits, filtering, sorting, basic formulas, separate worksheets and a change history; it is not full Microsoft Excel.</p>
  </Card>;
}
