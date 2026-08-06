"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  IconAlert,
  IconArrowRight,
  IconCheck,
  IconInbox,
  IconSpark,
  Modal,
  PageHeader,
  Spinner,
  useToast,
} from "@sonata/ui";
import type { TwinStatus } from "@/lib/twins";
import type { CompanyCard, SeedOutcome } from "@/lib/engine/clone";
import { TwinStrip } from "../../_components/TwinStrip";
import { usePoll } from "../../_components/usePoll";
import { apiSend } from "../../api/_lib/client";
import { ago } from "@/lib/format";

// Companies, and the one button this page was missing: put this business into
// the clones NOW.
//
// Until this existed, a cloned company only reached Gmail when a run started —
// so the first thing a new user did, opening the fake inbox to look at what they
// had just invented, showed them somebody else's company. Seeding is its own
// act here, with its own warning (it wipes all three clones) and its own
// receipt (what landed, and a door into each app).

export interface CompaniesData {
  companies: CompanyCard[];
  clones: TwinStatus[];
}

/** Shown in order while a company with no history is being written. */
const WRITING_LINES = [
  "Writing the days behind this one…",
  "Filling the inbox: threads, replies, the ones nobody answered…",
  "Backfilling Slack, in everyone's own voice…",
  "Putting the meetings on the calendar…",
  "Loading it into Gmail, Slack and Calendar…",
];

function stateBadge(company: CompanyCard) {
  if (company.state === "seeded") return <Badge status="passed">In the clones</Badge>;
  if (company.state === "superseded") return <Badge status="neutral">Replaced</Badge>;
  return <Badge status="pending">Not in the clones</Badge>;
}

export function CompaniesClient({ initial }: { initial: CompaniesData }) {
  const { toast } = useToast();
  const { data, refresh } = usePoll<CompaniesData>("/api/companies", 8000, initial);

  const [confirming, setConfirming] = useState<CompanyCard | null>(null);
  const [seeding, setSeeding] = useState<string | null>(null);
  const [line, setLine] = useState(0);
  const [outcome, setOutcome] = useState<SeedOutcome | null>(null);

  const { companies, clones } = data;
  const inTheClones = companies.find((c) => c.state === "seeded") ?? null;
  const offline = clones.filter((c) => !c.ok);

  useEffect(() => {
    if (seeding === null) {
      setLine(0);
      return;
    }
    // The last line stays put rather than looping: a cycling list reads as a
    // fake progress bar, and this one is telling the truth about the order.
    const timer = setInterval(
      () => setLine((current) => Math.min(current + 1, WRITING_LINES.length - 1)),
      2400,
    );
    return () => clearInterval(timer);
  }, [seeding]);

  async function seed(company: CompanyCard) {
    setConfirming(null);
    setSeeding(company.id);
    try {
      const { seeded } = await apiSend<{ seeded: SeedOutcome }>(
        `/api/companies/${encodeURIComponent(company.id)}/seed`,
        "POST",
      );
      setOutcome(seeded);
      toast({
        title: `${seeded.worldName} is in the clones`,
        description: "Open Gmail, Slack or the calendar and read what these people have been up to.",
        tone: "success",
      });
      refresh();
    } catch (err) {
      // `seedCompany` forces a health check before it does anything, so the
      // registry already knows which clone is off. Re-reading it here is what
      // puts a Start button under the message instead of only a red toast.
      refresh();
      toast({
        title: "Could not seed the clones",
        description: (err as Error).message,
        tone: "error",
        duration: 0,
      });
    } finally {
      setSeeding(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Companies"
        title="The companies you've cloned"
        subtitle="Each one is a cast of people with an inbox, Slack channels and a calendar — the same people in all three. Put one into the clones, then go and read their mail."
        actions={
          <Link href="/scenarios/new">
            <Button variant="primary" iconRight={<IconArrowRight size={14} />}>
              Clone a company
            </Button>
          </Link>
        }
      />

      {/* Seeding needs all three clones up, so a clone that is off is shown here
          with its own switch rather than discovered as a failed POST. */}
      {offline.length > 0 ? (
        <Card padding="lg" radius="2xl">
          <div className="flex items-start gap-2.5">
            <IconAlert size={15} className="mt-0.5 shrink-0 text-sn-danger" />
            <div>
              <p className="text-[13.5px] font-medium text-sn-ink">
                {offline.map((c) => c.label).join(" and ")}{" "}
                {offline.length === 1 ? "is" : "are"} not running.
              </p>
              <p className="mt-1 text-[12.5px] leading-[19px] text-sn-muted">
                A company is loaded into all three at once, so all three have to be answering.
                Starting one takes a few seconds the first time.
              </p>
            </div>
          </div>
          <div className="mt-4">
            <TwinStrip twins={clones} onChanged={refresh} />
          </div>
        </Card>
      ) : null}

      {companies.length === 0 ? (
        <EmptyState
          icon={<IconInbox size={20} />}
          title="Nothing cloned yet"
          description="Describe a company in one line — “a 12-person fintech, the week before an audit” — and Sonata writes the people, their threads, their channels and their meetings."
          hints={[
            "Seed it into the clones, then open Gmail and read what they were up to before nine",
            "Everything stays on this machine; no real account is ever touched",
          ]}
          action={
            <Link href="/scenarios/new">
              <Button variant="primary" iconRight={<IconArrowRight size={14} />}>
                Clone a company
              </Button>
            </Link>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {companies.map((company) => (
            <li key={company.id}>
              <CompanyTile
                company={company}
                clones={clones}
                busy={seeding === company.id}
                busyLine={WRITING_LINES[line] ?? ""}
                disabled={seeding !== null}
                onSeed={() => setConfirming(company)}
              />
            </li>
          ))}
        </ul>
      )}

      <ConfirmSeed
        company={confirming}
        replacing={inTheClones}
        onCancel={() => setConfirming(null)}
        onConfirm={(company) => void seed(company)}
      />
      <Landed outcome={outcome} onClose={() => setOutcome(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface TileProps {
  company: CompanyCard;
  clones: TwinStatus[];
  busy: boolean;
  busyLine: string;
  disabled: boolean;
  onSeed: () => void;
}

function CompanyTile({ company, clones, busy, busyLine, disabled, onSeed }: TileProps) {
  const now = Date.now();
  return (
    <Card padding="lg" radius="2xl" className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display min-w-0 text-[23px] text-sn-ink">{company.name}</h2>
        {stateBadge(company)}
      </div>
      <p className="mt-2 text-[13.5px] leading-[21px] text-sn-muted">{company.description}</p>

      <div className="mt-4 flex flex-wrap items-center gap-1.5">
        {company.industry ? <Chip size="sm">{company.industry}</Chip> : null}
        <Chip size="sm">
          {company.castSize} people · {company.channelCount} channels
        </Chip>
        <Chip size="sm">Cloned {ago(company.createdAt, now)}</Chip>
      </div>

      {/* What has been written, or an honest note that nothing has. The counts
          the preview promised are not shown here: they describe an inbox that
          does not exist until the backlog is. */}
      {company.counts ? (
        <p className="mt-3 text-[12px] leading-[18px] text-sn-subtle">
          <span data-numeric>{company.counts.threads}</span> threads ·{" "}
          <span data-numeric>{company.counts.slackMessages}</span> Slack messages ·{" "}
          <span data-numeric>{company.counts.events}</span> events written
        </p>
      ) : (
        <p className="mt-3 text-[12px] leading-[18px] text-sn-subtle">
          No history written yet — seeding writes it first, which takes about a minute.
        </p>
      )}

      {company.state === "superseded" && company.supersededBy ? (
        <p className="mt-3 text-[12px] leading-[18px] text-sn-subtle">
          Was in the clones {ago(company.seededAt, now)}; {company.supersededBy} replaced it.
        </p>
      ) : null}

      {company.state === "seeded" ? (
        <div className="mt-4 rounded-sn-lg border border-sn-passed-line bg-sn-passed-soft px-3.5 py-3">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-sn-passed-ink">
            <IconCheck size={13} />
            Loaded {ago(company.seededAt, now)} — this is what the clones are holding
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {clones.map((clone) => (
              <li key={clone.twin} className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-sn-muted">
                  {clone.label} · {clone.ok ? clone.detail : "not running"}
                </span>
                <a
                  href={clone.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-sn-primary-ink hover:underline"
                >
                  Open
                  <IconArrowRight size={11} />
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-3 pt-5">
        <Button
          variant={company.state === "seeded" ? "secondary" : "primary"}
          icon={<IconSpark size={14} />}
          loading={busy}
          disabled={disabled && !busy}
          onClick={onSeed}
        >
          {company.state === "seeded" ? "Load it again" : "Put this company in the clones"}
        </Button>
        {busy ? (
          <span className="flex items-center gap-2 text-[12px] text-sn-muted">
            <Spinner size="sm" />
            {busyLine}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface ConfirmProps {
  company: CompanyCard | null;
  /** Whatever is in the clones now, and is about to stop being. */
  replacing: CompanyCard | null;
  onCancel: () => void;
  onConfirm: (company: CompanyCard) => void;
}

/** The warning goes BEFORE the deed: seeding rebuilds all three clones from
 *  scratch, and anything a run left in them is gone. */
function ConfirmSeed({ company, replacing, onCancel, onConfirm }: ConfirmProps) {
  if (!company) return null;
  const displaced = replacing && replacing.id !== company.id ? replacing.name : null;
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Put ${company.name} into the clones?`}
      description={
        company.counts
          ? "Gmail, Slack and the calendar are rebuilt from this company. It takes a few seconds."
          : "Gmail, Slack and the calendar are rebuilt from this company. Its history has to be written first, so give it about a minute."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" icon={<IconSpark size={14} />} onClick={() => onConfirm(company)}>
            Seed the clones
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-2 text-[13px] leading-[20px] text-sn-muted">
        <li>
          <span className="font-medium text-sn-ink">Everything in the clones now is erased.</span>{" "}
          {displaced
            ? `${displaced} is in them at the moment — it will be gone, along with anything a run left behind.`
            : "Whatever is in them at the moment — including anything a run left behind — will be gone."}
        </li>
        {company.counts ? null : (
          <li>
            This company has no history yet, so it gets written first: threads, channels and
            meetings for the days before today. That is a model call, and takes about a minute.
          </li>
        )}
        <li>Nothing outside this machine is touched. No real account is ever involved.</li>
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/** The receipt: what each clone says it now holds, and a door into it. */
function Landed({ outcome, onClose }: { outcome: SeedOutcome | null; onClose: () => void }) {
  if (!outcome) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`${outcome.worldName} is in the clones`}
      description={
        outcome.wroteBacklog
          ? "Its history was written and loaded. Every number below came back from the clone itself."
          : "Every number below came back from the clone itself, not from what we sent."
      }
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <ul className="flex flex-col gap-2">
        {outcome.landed.map((twin) => (
          <li
            key={twin.twin}
            className="flex items-center justify-between gap-3 rounded-sn-lg border border-sn-line px-3.5 py-3"
          >
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-sn-ink">{twin.label}</p>
              <p className="mt-0.5 text-[12px] text-sn-muted" data-numeric>
                {twin.items.length > 0 ? twin.items.map((i) => i.label).join(" · ") : "nothing reported"}
              </p>
            </div>
            <a
              href={twin.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded-sn-md px-2 py-1 text-[12px] font-medium text-sn-primary-ink transition-colors duration-150 ease-sn hover:bg-sn-primary-soft"
            >
              Open {twin.label}
              <IconArrowRight size={11} />
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[12.5px] leading-[19px] text-sn-muted">
        Go and look — this is the same company an agent will find when you start the day.
      </p>
    </Modal>
  );
}
