import { Card, Chip, IconClock, cn } from "@sonata/ui";
import { END_STATE_LEAD, sightSentence, type EndOfDayReport, type TwinEnd } from "./endstate";

// THE OTHER QUESTION.
//
// Everything else on this page answers "what did it do": the replay, the
// findings, the diffs behind the checklist. This card answers "where did it
// leave things", and the two are not the same question — a thread the agent
// never opened moves nothing and is exactly what "no customer left without a
// response" is about.
//
// So the lead sentence does one job before any number is read: it names the
// distinction. A reader who takes these counts for a summary of the day's
// activity has been misled by us, and the counts are the kind that look like
// activity — "10 still unread" reads as ten things that happened unless the
// heading above it says otherwise.
//
// Compact on purpose. The page is dense already, so each surface gets one line
// of counts and at most a handful of items, and the numbers carry the magnitude
// the list cannot.

export function EndOfDay({ report }: { report: EndOfDayReport }) {
  return (
    <Card padding="none" radius="2xl" className="scroll-mt-6">
      <div className="flex items-start justify-between gap-4 p-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-medium text-sn-ink">Where the day ended up</h2>
          <p className="mt-0.5 max-w-[80ch] text-[13px] leading-[20px] text-sn-muted">
            {END_STATE_LEAD}
          </p>
        </div>
        {report.closedAt ? (
          <Chip size="sm" icon={<IconClock size="xs" />} className="shrink-0">
            stopped {report.closedAt}
          </Chip>
        ) : null}
      </div>

      <div className="divide-y divide-sn-line border-t border-sn-line">
        {report.twins.map((twin) => (
          <Surface key={twin.twin} end={twin} />
        ))}

        {/* Said once for the group, not once per surface: three copies of the
            same admission is a wall, and a wall gets skipped. */}
        {report.unseen.length > 0 ? (
          <section className="px-5 py-4">
            {report.unseen.map((row) => (
              <p
                key={row.twin}
                className="flex flex-wrap items-baseline gap-x-2.5 text-[13px] leading-[20px] not-first:mt-2"
              >
                <Chip size="sm" service={row.twin} />
                <span className="min-w-0 flex-1 text-sn-gold-ink">
                  Where this ended up is not in the file — {row.why}.
                </span>
              </p>
            ))}
            <p className="mt-2.5 max-w-[78ch] text-[12px] leading-[18px] text-sn-subtle">
              That is ours, not the agent&rsquo;s. A surface with nothing left open reads as a
              clean one, and this is not that.
            </p>
          </section>
        ) : null}
      </div>

      {report.sight ? (
        <p className="border-t border-sn-line px-5 py-3 text-[12px] leading-[18px] text-sn-subtle">
          {sightSentence(report.sight)}
        </p>
      ) : null}
    </Card>
  );
}

function Surface({ end }: { end: TwinEnd }) {
  return (
    <section className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Chip size="sm" service={end.twin} />
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] leading-[20px]">
          {end.counts.map((count) => (
            <span key={count.label} className="whitespace-nowrap">
              <span
                data-numeric
                className={cn(
                  "font-medium",
                  count.flag && count.value > 0 ? "text-sn-gold-ink" : "text-sn-ink",
                )}
              >
                {count.value}
              </span>{" "}
              <span className="text-sn-muted">{count.label}</span>
            </span>
          ))}
        </p>
      </div>

      {end.open.length === 0 ? (
        end.settled ? (
          <p className="mt-2 text-[13px] leading-[20px] text-sn-muted">{end.settled}</p>
        ) : null
      ) : (
        <ul className="mt-2.5 space-y-1.5">
          {end.open.map((item) => (
            <li
              key={item.key}
              className="flex flex-wrap items-baseline gap-x-2.5 text-[13px] leading-[20px]"
            >
              {/* Always rendered, empty or not: it holds the column, so a draft
                  with no clock does not start a row where a subject line starts. */}
              <span
                data-numeric
                className="min-w-[78px] shrink-0 whitespace-nowrap text-sn-subtle"
              >
                {item.when}
              </span>
              {item.who ? <span className="shrink-0 text-sn-subtle">{item.who}</span> : null}
              <span className="min-w-0 flex-1 truncate text-sn-ink">{item.what}</span>
              <span className="text-[11.5px] text-sn-subtle">{item.why}</span>
            </li>
          ))}
        </ul>
      )}

      {end.more > 0 ? (
        <p className="mt-2 text-[12px] text-sn-subtle">
          And {end.more} more like {end.more === 1 ? "it" : "them"}, left open the same way.
        </p>
      ) : null}

      {end.scope ? (
        <p className="mt-2 max-w-[78ch] text-[12px] leading-[18px] text-sn-subtle">{end.scope}</p>
      ) : null}
    </section>
  );
}
