import Link from "next/link";
import { Badge, Button, Card, Chip, EmptyState, IconArrowRight, IconInbox, PageHeader, SERVICE_LABELS } from "@sonata/ui";
import { TWIN_NAMES } from "@sonata/core";
import { listWorlds } from "@/lib/db";
import { twinUrl } from "@/lib/twins";
import { ago } from "@/lib/format";

// The product's opening move finally has an address: every fake company you
// have cloned, and doors into the three apps where its people live. A company
// is a thing to look at, not administer — no forms here, on purpose.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Companies",
  description: "The fake companies you've cloned, and doors into Gmail, Slack and Calendar.",
};

export default function CompaniesPage() {
  const worlds = listWorlds();
  const now = Date.now();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Companies"
        title="The companies you've cloned"
        subtitle="Each one is a cast of people with an inbox, Slack channels and a calendar — the same people in all three. Open the apps and read what they were up to before the day even starts."
        actions={
          <Link href="/scenarios/new">
            <Button variant="primary" iconRight={<IconArrowRight size={14} />}>
              Clone a company
            </Button>
          </Link>
        }
      />

      {worlds.length === 0 ? (
        <EmptyState
          icon={<IconInbox size={20} />}
          title="Nothing cloned yet"
          description="Describe a company in one line — “a 12-person fintech, the week before an audit” — and Sonata writes the people, their threads, their channels and their meetings."
          hints={[
            "Every scenario clones its company for you, so running a day makes one too",
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
          {worlds.map((world) => (
            <li key={world.id}>
              <Card padding="lg" radius="2xl" className="flex h-full flex-col">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-display min-w-0 text-[23px] text-sn-ink">{world.name}</h2>
                  <Badge status={world.seededAt ? "passed" : "neutral"} size="sm">
                    {world.seededAt ? "In the apps" : "Not seeded yet"}
                  </Badge>
                </div>
                <p className="mt-2 text-[13.5px] leading-[21px] text-sn-muted">
                  {world.description}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  {world.industry ? <Chip size="sm">{world.industry}</Chip> : null}
                  <Chip size="sm">
                    {world.castSize} people · {world.channelCount} channels
                  </Chip>
                  <Chip size="sm">Cloned {ago(world.createdAt, now)}</Chip>
                </div>
                {world.prompt ? (
                  <p className="mt-3 text-[12px] leading-[18px] text-sn-subtle">
                    From the line: “{world.prompt}”
                  </p>
                ) : null}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-5">
                  {TWIN_NAMES.map((twin) => (
                    <a key={twin} href={twinUrl(twin)} target="_blank" rel="noreferrer">
                      <Chip service={twin} size="sm">
                        Open {SERVICE_LABELS[twin]}
                      </Chip>
                    </a>
                  ))}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
