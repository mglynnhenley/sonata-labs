"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";

/**
 * Client-side navigation from anything that is already a real `<a href>` — the
 * design system's cards and stats render their own anchor, so they cannot be
 * wrapped in next/link. The href keeps middle-click, "open in new tab" and
 * "copy link address" honest; the push keeps the transition instant.
 */
export function useGo(): (event: MouseEvent<HTMLElement>, href: string) => void {
  const router = useRouter();
  return useCallback(
    (event: MouseEvent<HTMLElement>, href: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      router.push(href);
    },
    [router],
  );
}
