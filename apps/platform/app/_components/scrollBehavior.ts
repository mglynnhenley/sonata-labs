"use client";

/**
 * The scroll behaviour to ask for, honouring "reduce motion".
 *
 * The design system already resets `scroll-behavior` under
 * `prefers-reduced-motion`, but that only governs the CSS property: an explicit
 * `behavior: "smooth"` passed to `scrollTo` or `scrollIntoView` wins over it, so
 * every JS-driven scroll has to ask for itself. Anyone who has told the OS that
 * moving pictures make them ill gets a jump instead.
 */
export function scrollBehavior(): ScrollBehavior {
  // Server-rendered code never scrolls, and older engines have no matchMedia.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
