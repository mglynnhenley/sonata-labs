"use client";

import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Badge,
  IconBolt,
  IconInbox,
  IconLayers,
  IconPlay,
  IconSearch,
  IconSpark,
  Sidebar,
  SidebarGroup,
  SidebarItem,
  SidebarTrigger,
  SidebarUser,
} from "@sonata/ui";
import { usePoll } from "./usePoll";
import type { Overview } from "@/lib/overview";
import { ROUTES } from "@/lib/routes";

// The shell: navigation beside the content on a wide screen, a drawer behind a
// menu button on a narrow one, and the single content column both feed.
//
// The nav polls the same overview payload Home does, so the running-run count is
// live wherever you are in the app — you should never have to go back to Home to
// find out whether the day is still playing.

// One flat list sorted by a user's day, not our data lifecycle. "Runs" is the
// only place a run lives; "Compare" is the benchmark's front door.
const NAV = [
  { href: ROUTES.home, label: "Home", icon: <IconSpark size={16} /> },
  { href: ROUTES.companies, label: "Companies", icon: <IconInbox size={16} /> },
  { href: ROUTES.scenarios, label: "Scenarios", icon: <IconLayers size={16} /> },
  { href: ROUTES.runs, label: "Runs", icon: <IconPlay size={14} /> },
  { href: ROUTES.compare, label: "Compare", icon: <IconSearch size={16} /> },
  { href: ROUTES.settings, label: "Settings", icon: <IconBolt size={16} /> },
] as const;

const EMPTY: Pick<Overview, "live" | "twins"> = { live: [], twins: [] };

/** Names the apps rather than counting an unexplained noun. */
function twinLine(twins: Pick<Overview, "twins">["twins"]): string {
  if (twins.length === 0) return "Checking the three apps…";
  const down = twins.filter((t) => !t.ok);
  if (down.length === 0) return "Gmail, Slack and Calendar are up";
  return `${down.map((t) => t.label).join(" and ")} ${down.length === 1 ? "is" : "are"} down`;
}

/** The wordmark. `compact` drops the tagline for the narrow top bar. */
function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="block">
      <span className="inline-flex items-baseline">
        <span className={compact ? "font-display text-[20px] text-sn-ink" : "font-display text-[26px] text-sn-ink"}>
          Sonata
        </span>
        <span className="ml-1.5 text-[11px] font-medium tracking-[0.14em] text-sn-subtle uppercase">
          Labs
        </span>
      </span>
      {/* The premise, permanently — immune to every boolean and every state. */}
      {compact ? null : (
        <span className="mt-1 block text-[11.5px] leading-[16px] text-sn-subtle">
          Clone a company. Test your agent inside it.
        </span>
      )}
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data } = usePoll<Pick<Overview, "live" | "twins">>("/api/overview", 5000, EMPTY);
  const [navOpen, setNavOpen] = useState(false);

  // Client-side navigation with real links: the href keeps middle-click and
  // "copy link address" working, the push keeps the transition instant.
  useEffect(() => {
    for (const item of NAV) router.prefetch(item.href);
  }, [router]);

  // Arriving somewhere is what closes the drawer — leaving it open over the page
  // you just asked for would hide the answer behind the question.
  useEffect(() => setNavOpen(false), [pathname]);

  const closeNav = useCallback(() => setNavOpen(false), []);

  const go = (event: MouseEvent<HTMLElement>, href: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.push(href);
  };

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  const liveCount = data.live.length;

  return (
    <div className="flex min-h-dvh items-stretch">
      <Sidebar
        label="Sonata"
        open={navOpen}
        onClose={closeNav}
        brand={
          <a
            href="/"
            onClick={(e) => go(e, "/")}
            className="block rounded-sn-sm"
            aria-label="Sonata Labs home"
          >
            <Wordmark />
          </a>
        }
        footer={
          <SidebarUser
            name="Local workspace"
            detail={twinLine(data.twins)}
            href={ROUTES.settings}
            onClick={(e) => go(e, ROUTES.settings)}
          />
        }
      >
        <SidebarGroup>
          {NAV.map((item) => (
            <SidebarItem
              key={item.href}
              href={item.href}
              icon={item.icon}
              active={isActive(item.href)}
              onClick={(e) => go(e, item.href)}
              trailing={
                item.href === ROUTES.runs && liveCount > 0 ? (
                  <Badge status="running" size="sm">
                    {liveCount}
                  </Badge>
                ) : undefined
              }
            >
              {item.label}
            </SidebarItem>
          ))}
        </SidebarGroup>
      </Sidebar>

      <main id="main" className="sn-scroll min-w-0 flex-1">
        <SidebarTrigger
          open={navOpen}
          onClick={() => setNavOpen(true)}
          brand={
            <a href="/" onClick={(e) => go(e, "/")} className="rounded-sn-sm" aria-label="Sonata Labs home">
              <Wordmark compact />
            </a>
          }
        />
        <div className="mx-auto w-full max-w-[1180px] px-5 py-8 sm:px-8 sm:py-12 lg:px-14 lg:py-16">
          {children}
        </div>
      </main>
    </div>
  );
}
