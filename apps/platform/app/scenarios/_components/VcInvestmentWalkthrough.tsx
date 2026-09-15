import { Card } from "@sonata/ui";

/** Reviewer guidance, never part of the agent prompt or a substitute for the saved rubric. */
export function VcInvestmentWalkthrough({ busy = false }: { busy?: boolean }) {
  return (
    <Card padding="lg">
      <p className="text-sn-sm font-medium text-sn-primary-ink">Synthetic pilot · Awaiting practitioner validation</p>
      <h2 className="mt-2 text-sn-xl font-semibold text-sn-ink">{busy ? "Keep a VC team’s busy day moving" : "Get the partners ready to discuss one investment"}</h2>
      <p className="mt-3 max-w-[76ch] text-sn-base leading-relaxed text-sn-muted">
        The agent is Alex, an associate at a fictional VC fund. Its main job is to send a
        reliable briefing about LedgerLens, a company selling software to finance teams,
        before the partners meet. Two new pitches and a customer reference also need attention.
      </p>
      {busy ? <div className="mt-4 space-y-3 text-sn-base leading-relaxed text-sn-muted">
        <p><strong className="text-sn-ink">Everyone’s calendar is packed.</strong> Alex and three colleagues
          have back-to-back morning meetings. The agent must find shared time for a group meeting
          and arrange coffee with another VC without moving existing commitments.</p>
        <p><strong className="text-sn-ink">Relationships and events need follow-through.</strong> Two VCs
          want deal information. One has permission for a specific introduction; the other needs
          founder consent. Tomorrow’s six-person founder supper needs venue confirmation, catering
          and invitations before 14:00.</p>
        <p><strong className="text-sn-ink">Attio is the team’s CRM.</strong> It already holds the deals,
          contacts, sharing permissions and outstanding tasks. The agent must correct stale notes,
          record what it shared and leave the right next steps with the right owners.</p>
      </div> : null}
      <ol className="mt-5 space-y-3 text-sn-base leading-relaxed text-sn-muted">
        <li><strong className="text-sn-ink">Morning:</strong> read the existing deal history,
          screen the new pitches, and rearrange the customer reference.</li>
        <li><strong className="text-sn-ink">Before 15:00:</strong> send the briefing using the
          corrected financial figures and written customer evidence. Explain what is still unknown.</li>
        <li><strong className="text-sn-ink">15:15:</strong> the largest customer says it will not
          renew. Update the partners before their 16:00 meeting.</li>
        <li><strong className="text-sn-ink">By the end of the day:</strong> give the founder an
          accurate status and leave each deal with a clear next step and owner.</li>
      </ol>
      <div className="mt-5 rounded-sn-lg border border-sn-line bg-sn-surface p-4">
        <p className="text-sn-base font-semibold text-sn-ink">A concrete failure to look for</p>
        <p className="mt-2 text-sn-base leading-relaxed text-sn-muted">
          The agent sends a polished memo saying annual recurring revenue is £2.4m. The
          finance email says it is £1.8m; the rest is one-off services. Sending the memo on
          time passes a delivery check, but the analysis is still wrong.
        </p>
      </div>
      <p className="mt-4 max-w-[76ch] text-sn-sm leading-relaxed text-sn-muted">
        The rubric below has four automatic checks for delivery and a calendar change, plus
        {busy ? "eight" : "four"} content criteria requiring evidence-based review. The automatic percentage alone
        does not measure work quality. Appropriate requests for a partner’s decision are allowed.
        The agent is not being graded on predicting investment returns.
      </p>
      {busy ? <p className="mt-3 text-sn-sm leading-relaxed text-sn-muted">
        Colleagues’ fixed meetings delay their replies. The agent can keep working while its human
        account owner is in a meeting; attendance and human working time are not simulated.
      </p> : null}
      <details className="mt-4 text-sn-sm text-sn-muted">
        <summary className="cursor-pointer font-medium text-sn-ink">Where this scenario comes from</summary>
        <p className="mt-2 max-w-[76ch] leading-relaxed">
          Public investment memos show how diligence findings and customer evidence inform a
          recommendation. See <a className="text-sn-primary-ink underline" href="https://www.bvp.com/atlas/an-inside-look-at-our-investment-process-for-twilio/">Bessemer’s published Twilio example</a>.
          This pilot invents its own fund, numbers, deadlines and interruptions. It does not
          reproduce Bessemer’s process or an observed workday. A real, anonymised example and
          a fund practitioner’s review are still needed before using it as a validated benchmark.
        </p>
      </details>
    </Card>
  );
}
