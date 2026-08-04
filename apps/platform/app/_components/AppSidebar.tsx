"use client";

import { useEffect, type MouseEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Badge,
  IconBolt,
  IconLayers,
  IconPlay,
  IconSearch,
  IconSpark,
  Sidebar,
  SidebarGroup,
  SidebarItem,
  SidebarUser,
} from "@sonata/ui";
import { usePoll } from "./usePoll";
import type { Overview } from "@/lib/overview";

// The shell's navigation. It polls the same overview payload Home does, so the
// running-run count in the nav is live wherever you are in the app — you should
// never have to go back to Home to find out whether the day is still playing.

const NAV = [
  {
    label: "Simulate",
    items: [
      { href: "/", label: "Home", icon: <IconSpark size={16} /> },
      { href: "/scenarios", label: "Scenarios", icon: <IconLayers size={16} /> },
      { href: "/runs", label: "Runs", icon: <IconPlay size={14} /> },
    ],
  },
  {
    label: "Analyse",
    items: [{ href: "/results", label: "Results", icon: <IconSearch size={16} /> }],
  },
] as const;

const EMPTY: Pick<Overview, "live" | "twins"> = { live: [], twins: [] };

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { data } = usePoll<Pick<Overview, "live" | "twins">>("/api/overview", 5000, EMPTY);

  // Client-side navigation with real links: the href keeps middle-click and
  // "copy link address" working, the push keeps the transition instant.
  useEffect(() => {
    for (const group of NAV) for (const item of group.items) router.prefetch(item.href);
    router.prefetch("/settings");
  }, [router]);

  const go = (event: MouseEvent<HTMLElement>, href: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    router.push(href);
  };

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  const liveCount = data.live.length;
  const ready = data.twins.filter((t) => t.ok).length;

  return (
    <Sidebar
      label="Sonata"
      brand={
        <a
          href="/"
          onClick={(e) => go(e, "/")}
          className="inline-flex items-baseline rounded-sn-sm"
          aria-label="Sonata Labs home"
        >
          <span className="font-display text-[26px] text-sn-ink">Sonata</span>
          <span className="ml-1.5 text-[11px] font-medium tracking-[0.14em] text-sn-subtle uppercase">
            Labs
          </span>
        </a>
      }
      footer={
        <SidebarUser
          name="Local workspace"
          detail={
            data.twins.length === 0
              ? "Checking the clones…"
              : `${ready} of ${data.twins.length} clones ready`
          }
          href="/settings"
          onClick={(e) => go(e, "/settings")}
        />
      }
    >
      {NAV.map((group) => (
        <SidebarGroup key={group.label} label={group.label}>
          {group.items.map((item) => (
            <SidebarItem
              key={item.href}
              href={item.href}
              icon={item.icon}
              active={isActive(item.href)}
              onClick={(e) => go(e, item.href)}
              trailing={
                item.href === "/runs" && liveCount > 0 ? (
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
      ))}

      <SidebarGroup>
        <SidebarItem
          href="/settings"
          icon={<IconBolt size={16} />}
          active={isActive("/settings")}
          onClick={(e) => go(e, "/settings")}
        >
          Settings
        </SidebarItem>
      </SidebarGroup>
    </Sidebar>
  );
}
