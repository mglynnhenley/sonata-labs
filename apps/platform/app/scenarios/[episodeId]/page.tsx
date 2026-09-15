import Link from "next/link";
import styles from "./reading.module.css";
import { notFound } from "next/navigation";
import { tickLabel, resolveTwinApiUrl } from "@sonata/core";
import { beatWords } from "@sonata/engine";
import { Card, Chip, PageHeader, SERVICE_LABELS } from "@sonata/ui";
import { getEpisode } from "../../api/_lib/records";
import { GradingPanel } from "../../_components/GradingPanel";
import { MeridianWalkthrough } from "../_components/MeridianWalkthrough";
import { TaxWorkbookWalkthrough } from "../_components/TaxWorkbookWalkthrough";
import { TaxReportingWalkthrough } from "../_components/TaxReportingWalkthrough";
import { VcCopilotWalkthrough } from "../_components/VcCopilotWalkthrough";
import { VcInvestmentWalkthrough } from "../_components/VcInvestmentWalkthrough";
import { ScenarioContract } from "../_components/ScenarioContract";
import { dayRange } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review scenario" };

export default async function ScenarioPage({ params }: { params: Promise<{ episodeId: string }> }) {
  const { episodeId } = await params;
  const episode = getEpisode(episodeId);
  if (!episode) notFound();
  const { spec } = episode;
  const { world, clock } = spec;
  const owner = world.cast.find((person) => person.id === world.mailboxOwner);

  return (
    <div className={`sn-stack-section ${styles.reading}`}>
      <PageHeader
        eyebrow={<Link href="/scenarios" className="hover:underline">Scenarios</Link>}
        title={episode.title}
        subtitle="Review the situation and what the agent should achieve. Then choose a model to run it."
      />

      {episode.id === "tax-reporting-workbook-day" ? <TaxWorkbookWalkthrough excelUrl={resolveTwinApiUrl("excel", process.env)} /> : null}
      {episode.id === "tax-reporting-workflow-day" ? <>
        <Card padding="lg"><p className="text-sn-base">This is the earlier reconciliation pilot. <Link className="font-semibold text-sn-primary-ink underline" href="/scenarios/tax-reporting-workbook-day">Open the updated Excel scenario</Link>, which starts with the institution’s categorised reporting workbook.</p></Card>
        <TaxReportingWalkthrough />
      </> : null}
      {episode.id === "meridian-excursion" ? <MeridianWalkthrough /> : null}
      {episode.id === "vc-ai-assistant-day" ? <VcCopilotWalkthrough /> : null}
      {episode.id === "vc-investment-day" ? <VcInvestmentWalkthrough /> : null}
      {episode.id === "vc-busy-investment-day" ? <VcInvestmentWalkthrough busy /> : null}

      <ScenarioContract spec={spec} twins={episode.twins} />

      <Card padding="lg">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sn-sm text-sn-muted">Environment</p>
            <Link href={`/scenarios?environment=${encodeURIComponent(episode.worldId)}`}
              className="text-sn-md font-semibold text-sn-primary-ink hover:underline">
              {episode.worldName}
            </Link>
            <p className="mt-1 text-sn-sm text-sn-muted">
              {owner ? `The agent works as ${owner.name}, ${owner.role}.` : `${world.cast.length} people in this company.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {episode.twins.map((twin) => <Chip key={twin} service={twin} size="sm">{SERVICE_LABELS[twin]}</Chip>)}
          </div>
        </div>
        <details open={!["meridian-excursion", "vc-investment-day", "vc-busy-investment-day", "vc-ai-assistant-day", "tax-reporting-workflow-day", "tax-reporting-workbook-day"].includes(episode.id)} className="mt-4 border-t border-sn-line pt-4">
          <summary className="cursor-pointer text-sn-base font-medium text-sn-ink">Read the scenario background</summary>
          <p className="mt-3 max-w-[76ch] whitespace-pre-line text-sn-base leading-relaxed text-sn-muted">{spec.story}</p>
        </details>
        <details className="mt-3">
          <summary className="cursor-pointer text-sn-base font-medium text-sn-ink">Explore the people and scheduled events</summary>
          <div className="mt-4 grid gap-8">
            <section>
              <h2 className="text-sn-base font-semibold text-sn-ink">People</h2>
              <ul className="mt-2 divide-y divide-sn-line">
                {world.cast.map((person) => (
                  <li key={person.id} className="py-2 text-sn-sm">
                    <span className="font-medium text-sn-ink">{person.name}</span>
                    <span className="block text-sn-muted">{person.role}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h2 className="text-sn-base font-semibold text-sn-ink">Scheduled events</h2>
              <p className="mt-1 text-sn-sm text-sn-muted">
                {dayRange(clock.startISO, clock.simMinutesPerTick, clock.ticks)} · Company time. Responses during a run may vary.
              </p>
              <ol className="mt-2 divide-y divide-sn-line">
                {[...spec.beats].sort((a, b) => a.tick - b.tick).map((beat) => (
                  <li key={beat.id} className="py-3 text-sn-sm">
                    <p className="font-medium text-sn-ink">{tickLabel(clock, beat.tick)} · {SERVICE_LABELS[beat.twin]}</p>
                    <p className="mt-1 whitespace-pre-line text-sn-muted">{beatWords(beat) || beat.note || beat.kind}</p>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </details>
      </Card>

      <GradingPanel key={episode.id} fixedEpisodeId={episode.id} initialEpisode={episode} />
    </div>
  );
}
