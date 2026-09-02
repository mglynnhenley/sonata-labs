/**
 * Sonata design tokens.
 *
 * Source of truth for anything that needs a value in TypeScript — canvas,
 * charts, inline styles, favicons. `styles.css` mirrors the same numbers in a
 * Tailwind `@theme` block because Tailwind needs literal values at build time,
 * so the two files must be edited together. `cssVariables` below emits exactly
 * the same custom-property names the `@theme` block declares, so an app can
 * inject it at runtime and override the compiled theme without a rebuild.
 */

/**
 * Warm paper, white cards, near-black ink, one petrol accent, muted
 * sage/terracotta states. See DESIGN.md — colour is rationed: buttons are ink,
 * petrol or outlined, and the state hues appear only on badges, pills and
 * chart marks.
 */
export const color = {
  /** Page background — warm paper. */
  bg: "#f7f6f2",
  /** Inset/sunken areas: table zebra, code wells, hover troughs. */
  bgSubtle: "#f1efe9",
  /** Cards are plain white above the paper. */
  surface: "#ffffff",
  surfaceHover: "#f7f6f2",
  ink: "#16181a",
  muted: "#5a6060",
  subtle: "#6b716e",
  line: "#eceae2",
  lineStrong: "#dddad0",
  primary: "#0e5c55",
  primaryHover: "#0b4a44",
  primaryActive: "#093d38",
  primarySoft: "#e3f0ec",
  primaryInk: "#0b4a44",
  onPrimary: "#ffffff",
  /** Ochre — the "attention, not danger" family (syncing, unpriced, stale). */
  gold: "#8a6520",
  goldSoft: "#f5ebd6",
  goldInk: "#6e4f16",
  success: "#63936f",
  successSoft: "#e4eee6",
  successInk: "#3f6b4c",
  danger: "#b26355",
  dangerHover: "#9e5044",
  dangerSoft: "#f5e6e1",
  dangerInk: "#8e4335",
  warning: "#8a6520",
  warningSoft: "#f5ebd6",
  warningInk: "#6e4f16",
  info: "#3d7a7a",
  infoSoft: "#e3eeee",
  infoInk: "#2e5f5f",
  neutral: "#6b726e",
  neutralSoft: "#f1efe9",
  neutralInk: "#4c524e",
  focus: "#0e5c55",
} as const;

/** Every twin. Brand hues pulled toward the cream palette so chips sit inside
 *  the page instead of shouting over it — which is the whole reason these are
 *  hand-picked rather than taken from each vendor: five real brand colours side
 *  by side in one timeline is a fruit salad, and the surface a marker names
 *  matters more than whose logo it is. Neighbouring hues are kept apart so two
 *  chips in the same row never read as the same service at a glance. */
export const serviceColor = {
  gmail: { ink: "#b23f2f", soft: "#f8e7e3", line: "#eed4cd" },
  slack: { ink: "#6b3f77", soft: "#f1e8f3", line: "#e3d4e7" },
  calendar: { ink: "#2f6497", soft: "#e5edf6", line: "#cfdcea" },
  attio: { ink: "#2f6b5d", soft: "#e3f0ec", line: "#cadfd8" },
  "google-docs": { ink: "#3a5aa8", soft: "#e6eaf7", line: "#d0d8ee" },
} as const;

export type ServiceId = keyof typeof serviceColor;

export const SERVICE_IDS: readonly ServiceId[] = [
  "gmail",
  "slack",
  "calendar",
  "attio",
  "google-docs",
];

export const SERVICE_LABELS: Record<ServiceId, string> = {
  gmail: "Gmail",
  slack: "Slack",
  calendar: "Calendar",
  attio: "Attio",
  "google-docs": "Google Docs",
};

/** Run lifecycle. `running` wears the accent — live is the loudest thing on
 *  any page — and the rest are the muted sage/terracotta family. */
export const statusColor = {
  running: { ink: color.primary, soft: color.primarySoft, line: "#cbe2dc" },
  passed: { ink: color.successInk, soft: color.successSoft, line: "#cde0d1" },
  failed: { ink: color.dangerInk, soft: color.dangerSoft, line: "#ebd2ca" },
  pending: { ink: color.neutralInk, soft: color.neutralSoft, line: "#dddad0" },
  warning: { ink: color.warningInk, soft: color.warningSoft, line: "#e8d7ae" },
  neutral: { ink: color.neutralInk, soft: color.neutralSoft, line: "#dddad0" },
} as const;

export type StatusId = keyof typeof statusColor;

export const STATUS_LABELS: Record<StatusId, string> = {
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  pending: "Pending",
  warning: "Warning",
  neutral: "Unknown",
};

/** 4px base. Named so layout intent survives a redesign. */
export const space = {
  px: "1px",
  "0.5": "2px",
  "1": "4px",
  "1.5": "6px",
  "2": "8px",
  "3": "12px",
  "4": "16px",
  "5": "20px",
  "6": "24px",
  "8": "32px",
  "10": "40px",
  "12": "48px",
  "16": "64px",
} as const;

/**
 * Vertical rhythm, named by what the gap separates rather than by size.
 *
 * Four page components stacked their sections at 32px, 40px, 48px and 56px —
 * one hierarchy level wearing four different spacings, which is why the app read
 * as slightly different software on every route. This is a dense dashboard, so
 * the scale tops out at 32px: the tier tells you which gap to reach for, and the
 * number stops being a per-file opinion.
 */
export const rhythm = {
  /**
   * Between top-level sections of a page.
   *
   * 40 and not 32: a section step has to beat the 24px one inside it by enough
   * to read as a different kind of boundary. At 32 the two were close enough
   * that a heading with no subtitle sat almost equidistant between the block
   * above it and the content below, and the hierarchy went flat.
   */
  section: "40px",
  /** Between blocks inside one section. */
  block: "24px",
  /** Between related items — cards in a grid, chips in a row. */
  group: "16px",
  /** A label and its value; an icon and its text. */
  item: "8px",
} as const;

/**
 * Icon sizes. Four steps, because eight was not a scale.
 *
 * 11, 12, 13, 14, 15, 16, 18 and 20 were all in use across 158 call sites, which
 * is the difference between a rhythm and a rounding error.
 */
export const iconSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
} as const;

/** Calm. Cards are 2xl (14px); controls are md; buttons are full pills. */
export const radius = {
  sm: "6px",
  md: "10px",
  lg: "12px",
  xl: "14px",
  "2xl": "14px",
  "3xl": "16px",
  full: "9999px",
} as const;

/** Whisper shadows — elevation you feel rather than see. */
export const shadow = {
  xs: "0 1px 2px rgba(22, 24, 26, 0.04)",
  sm: "0 1px 2px rgba(22, 24, 26, 0.04), 0 2px 6px -4px rgba(22, 24, 26, 0.05)",
  md: "0 4px 16px -8px rgba(22, 24, 26, 0.10)",
  lg: "0 18px 44px -14px rgba(22, 24, 26, 0.16), 0 4px 12px -6px rgba(22, 24, 26, 0.08)",
  focus: `0 0 0 3px rgba(14, 92, 85, 0.25)`,
} as const;

/** Small and crisp for data; the display sizes are for serif italic headings. */
export const fontSize = {
  xs: { size: "11px", leading: "15px" },
  sm: { size: "12px", leading: "16px" },
  base: { size: "13px", leading: "19px" },
  md: { size: "14px", leading: "20px" },
  lg: { size: "16px", leading: "24px" },
  xl: { size: "20px", leading: "26px" },
  "2xl": { size: "24px", leading: "30px" },
  "3xl": { size: "30px", leading: "34px" },
  "4xl": { size: "40px", leading: "42px" },
  "5xl": { size: "52px", leading: "54px" },
  "6xl": { size: "76px", leading: "76px" },
} as const;

/** 150ms is the house transition. Anything slower reads as lag. */
export const duration = { fast: "100ms", base: "150ms", slow: "260ms" } as const;

export const easing = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  out: "cubic-bezier(0.16, 1, 0.3, 1)",
} as const;

export const layout = {
  sidebarWidth: "252px",
  contentMax: "1180px",
  proseMax: "68ch",
} as const;

export const zIndex = {
  sticky: 20,
  overlay: 50,
  modal: 60,
  toast: 70,
} as const;

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/**
 * The same tokens as a `:root { ... }` rule. Names match the `@theme` block in
 * styles.css exactly, so injecting this string is a valid theme override.
 */
export function buildCssVariables(): string {
  const lines: string[] = [];
  const push = (name: string, value: string) => lines.push(`  ${name}: ${value};`);

  for (const [key, value] of Object.entries(color)) push(`--color-sn-${kebab(key)}`, value);
  for (const [service, tones] of Object.entries(serviceColor)) {
    for (const [tone, value] of Object.entries(tones)) push(`--color-sn-${service}-${tone}`, value);
  }
  for (const [status, tones] of Object.entries(statusColor)) {
    for (const [tone, value] of Object.entries(tones)) push(`--color-sn-${status}-${tone}`, value);
  }
  for (const [key, value] of Object.entries(radius)) push(`--radius-sn-${key}`, value);
  for (const [key, value] of Object.entries(shadow)) push(`--shadow-sn-${key}`, value);
  for (const [key, value] of Object.entries(space)) push(`--sn-space-${key.replace(".", "_")}`, value);
  for (const [key, value] of Object.entries(rhythm)) push(`--sn-rhythm-${key}`, value);
  for (const [key, value] of Object.entries(iconSize)) push(`--sn-icon-${key}`, `${value}px`);
  for (const [key, value] of Object.entries(fontSize)) {
    push(`--sn-text-${key}`, value.size);
    push(`--sn-leading-${key}`, value.leading);
  }
  for (const [key, value] of Object.entries(duration)) push(`--sn-duration-${key}`, value);
  for (const [key, value] of Object.entries(easing)) push(`--ease-sn-${key}`, value);
  for (const [key, value] of Object.entries(layout)) push(`--sn-${kebab(key)}`, value);

  return `:root {\n${lines.join("\n")}\n}`;
}

/** Precomputed so it can be dropped straight into a `<style>` tag. */
export const cssVariables: string = buildCssVariables();

export const tokens = {
  color,
  serviceColor,
  statusColor,
  space,
  rhythm,
  iconSize,
  radius,
  shadow,
  fontSize,
  duration,
  easing,
  layout,
  zIndex,
} as const;
