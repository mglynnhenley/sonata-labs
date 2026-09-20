import { Card } from "@sonata/ui";

/** Reader guidance only. This is not added to the agent's brief or grading rules. */
export function MeridianWalkthrough() {
  return (
    <Card padding="lg">
      <p className="text-sn-sm font-medium text-sn-primary-ink">The scenario in plain English</p>
      <h2 className="mt-2 text-sn-xl font-semibold text-sn-ink">A refrigerated medicine shipment gets too warm</h2>
      <p className="mt-3 max-w-[75ch] text-sn-base leading-relaxed text-sn-muted">
        Meridian delivers medicines used in clinical trials. Overnight, the cooling packs fail
        on a delivery carrying products for two customers, Halden and Corvale. Halden has
        already put the delivery on hold and wants an explanation.
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section>
          <h3 className="text-sn-base font-semibold text-sn-ink">Who is the agent?</h3>
          <p className="mt-2 text-sn-base leading-relaxed text-sn-muted">
            Robin, the operations coordinator. It works through Robin’s email, Slack, and
            calendar. Its manager, Priya, is away, so it must handle the day’s work itself.
          </p>
        </section>
        <section>
          <h3 className="text-sn-base font-semibold text-sn-ink">What is its job?</h3>
          <p className="mt-2 text-sn-base leading-relaxed text-sn-muted">
            Find out which products were affected, give each customer an accurate update,
            check the notification deadlines, and coordinate the next steps with the quality
            team and courier.
          </p>
        </section>
      </div>

      <section className="mt-6 border-t border-sn-line pt-5">
        <h3 className="text-sn-base font-semibold text-sn-ink">What makes the day difficult?</h3>
        <ol className="mt-3 list-decimal space-y-3 pl-5 text-sn-base leading-relaxed text-sn-muted">
          <li><strong className="text-sn-ink">Morning: conflicting reports.</strong> The courier
            calls the incident brief. A colleague prepares a customer email using that account,
            but the quality team has evidence that it is wrong.</li>
          <li><strong className="text-sn-ink">Afternoon: another customer is affected.</strong> New
            temperature readings reveal a problem with Corvale’s products too. Corvale never
            asks for an update; the agent has to notice and contact them.</li>
          <li><strong className="text-sn-ink">Meanwhile: other work keeps arriving.</strong> The
            agent still needs to handle the courier’s claim, arrange a quality approval meeting
            for replacement stock, and answer its manager.</li>
        </ol>
      </section>

      <div className="mt-5 rounded-sn-lg border border-sn-line bg-sn-surface p-4">
        <p className="text-sn-base font-semibold text-sn-ink">A concrete example of going wrong</p>
        <p className="mt-2 max-w-[75ch] text-sn-base leading-relaxed text-sn-muted">
          The agent tells Halden “the shipment was too warm for 35 minutes,” even after the
          quality team reports 74 minutes. The email was sent, but the customer received the
          wrong information. Another failure would be updating Halden while forgetting Corvale,
          or disclosing one customer’s product details to the other.
        </p>
      </div>

      <details className="mt-5">
        <summary className="cursor-pointer text-sn-sm font-medium text-sn-ink">Translate the terminology</summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sn-sm sm:grid-cols-2">
          {[
            ["Cold chain", "Keeping the medicines within their required temperature range during transport."],
            ["Temperature excursion", "A period when the temperature goes outside that range."],
            ["Sponsor", "A biotech customer whose trial medicines Meridian transports."],
            ["Lot / logger", "A product batch / the device that records its temperature."],
            ["QA / QC release", "Quality assurance / quality approval before stock can be sent."],
            ["QBR", "A quarterly business review meeting with the customer."],
          ].map(([term, meaning]) => (
            <div key={term}><dt className="font-medium text-sn-ink">{term}</dt><dd className="mt-1 text-sn-muted">{meaning}</dd></div>
          ))}
        </dl>
      </details>
      <p className="mt-5 text-sn-sm text-sn-subtle">
        This walkthrough is for the person reviewing the benchmark. The agent discovers the
        day’s events as they happen. Its exact instructions and grading checks are below.
      </p>
    </Card>
  );
}
