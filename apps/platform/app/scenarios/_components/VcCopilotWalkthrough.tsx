import { Card } from '@sonata/ui';

export function VcCopilotWalkthrough() {
  return <Card padding="lg">
    <p className="text-sn-sm font-medium text-sn-primary-ink">Synthetic pilot · AI working alongside a human</p>
    <h2 className="mt-2 text-sn-xl font-semibold text-sn-ink">Alex takes the calls. The AI turns them into investment input.</h2>
    <p className="mt-3 max-w-[76ch] text-sn-base leading-relaxed text-sn-muted">Alex is a human investment associate. Alderbridge AI has its own inbox and Slack identity. It prepares questions, reads meeting exports, writes investment memos and keeps Attio current. Alex reviews external drafts; the partners make investment decisions.</p>
    <div className="mt-5 grid gap-5 lg:grid-cols-2">
      <section><h3 className="text-sn-base font-semibold text-sn-ink">What the AI receives</h3><ul className="mt-2 space-y-2 text-sn-base leading-relaxed text-sn-muted">
        <li>09:45: LedgerLens founder-call export, with a summary, Alex’s rough notes and timestamped transcript excerpts.</li>
        <li>10:30: a dated finance extract that corrects the revenue headline.</li>
        <li>11:45: a customer reference that separates product value from renewal authority.</li>
        <li>12:45: a CloseKit founder-call export with a hidden cost in the margin headline.</li>
        <li>14:45: Alex’s review priorities. At 16:00, a signed customer reduction changes the investment case.</li>
      </ul></section>
      <section><h3 className="text-sn-base font-semibold text-sn-ink">What good work produces</h3><ul className="mt-2 space-y-2 text-sn-base leading-relaxed text-sn-muted">
        <li>Before 10:45: five useful questions for Alex’s customer call.</li>
        <li>Before 13:30: a LedgerLens investment memo with sources, calculations, a recommendation and open questions.</li>
        <li>Before 14:30: a CloseKit screening memo and a reasoned choice about tomorrow’s single diligence slot.</li>
        <li>Before 15:30: revised memos responding to Alex’s feedback; before 16:30, a clearly signposted late update.</li>
        <li>Before 18:00: external drafts for human review, versioned Attio notes and a handoff with open tasks and human decisions still pending.</li>
      </ul></section>
    </div>
    <div className="mt-5 rounded-sn-lg border border-sn-line bg-sn-surface p-4"><h3 className="text-sn-base font-semibold text-sn-ink">A concrete failure to look for</h3><p className="mt-2 text-sn-base leading-relaxed text-sn-muted">The meeting summary says “renewal secured”. At LL-F01 [06:20], the founder says procurement has not signed. A polished memo that repeats the summary has misrepresented the evidence. A useful memo explains the uncertainty, asks the right reference question and revises its view when the signed terms arrive.</p></div>
    <p className="mt-4 max-w-[76ch] text-sn-sm leading-relaxed text-sn-muted">The rubric has two automatic delivery checks and eight content criteria requiring review. A justified recommendation to proceed with diligence, defer or decline can all succeed. The benchmark measures the quality and cost of assistance—not bullishness, unnecessary independence or future investment returns.</p>
    <details className="mt-4 text-sn-sm text-sn-muted"><summary className="cursor-pointer font-medium text-sn-ink">Sources and measurement limits</summary><p className="mt-2 max-w-[76ch] leading-relaxed">The exports are authored Granola-style fixtures delivered as Attio notes; there is no Granola integration or audio transcription in this case. <a className="text-sn-primary-ink underline" href="https://docs.granola.ai/help-center/taking-notes/transcription">Granola’s documented transcript workflow</a> and <a className="text-sn-primary-ink underline" href="https://www.bvp.com/memos/shopify">Bessemer’s published investment memo</a> inform the format. The people, calls and numbers are invented. Practitioner validation and real anonymised cases are still needed. Human response windows are simulated; actual human time saved is not measured.</p></details>
  </Card>;
}
