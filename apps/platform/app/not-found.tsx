import Link from "next/link";
import { buttonClasses, EmptyState, IconArrowRight, IconSearch } from "@sonata/ui";
import { ROUTES } from "@/lib/routes";

// Every route that has no page of its own lands here. Without it Next serves its
// own black-on-white "404 This page could not be found" inside the Sonata shell,
// which is the one page in the product that looks like somebody else built it.
//
// So it does what every other empty state here does: says what happened in plain
// language, and offers the way on rather than a dead end.

const ELSEWHERE = [
  { href: ROUTES.companies, label: "Companies", hint: "The fake companies you've cloned" },
  { href: ROUTES.scenarios, label: "Scenarios", hint: "The days you can run" },
  { href: ROUTES.runs, label: "Runs", hint: "Every day played, live or finished" },
  { href: ROUTES.compare, label: "Compare", hint: "Models against scenarios, cell by cell" },
  { href: ROUTES.settings, label: "Settings", hint: "Models, key and the three apps" },
] as const;

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-[720px]">
      <EmptyState
        icon={<IconSearch size="lg" />}
        title="There's nothing at this address"
        description="The link is wrong, or whatever used to be here has been cleared away. Nothing is broken — you are just somewhere the product does not have a page for."
        action={
          <Link href={ROUTES.home} className={buttonClasses("primary", "md")}>
            Back to the overview
            <IconArrowRight size="sm" />
          </Link>
        }
      />

      <div className="mt-8">
        <h2 className="text-[13px] font-medium text-sn-ink">Or pick up where you were</h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {ELSEWHERE.map((place) => (
            <li key={place.href}>
              <Link
                href={place.href}
                className="group flex items-center gap-3 rounded-sn-lg border border-sn-line bg-sn-surface px-4 py-3 shadow-sn-xs transition-colors duration-150 ease-sn hover:border-sn-line-strong"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-sn-ink">{place.label}</span>
                  <span className="block text-[12px] text-sn-muted">{place.hint}</span>
                </span>
                <IconArrowRight
                  size="sm"
                  className="shrink-0 text-sn-subtle transition-transform duration-150 ease-sn group-hover:translate-x-0.5 group-hover:text-sn-ink"
                />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
