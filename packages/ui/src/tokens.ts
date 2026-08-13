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

/** Cream page, near-white cards, warm ink, slate-blue primary, gold accent. */
export const color = {
  /** Page background — parchment. */
  bg: "#f2f1ec",
  /** Inset/sunken areas: table zebra, code wells, hover troughs. */
  bgSubtle: "#e9e7df",
  /** Cards sit *above* the page, so they are lighter than it, not darker. */
  surface: "#fbfaf8",
  surfaceHover: "#f5f3ee",
  ink: "#1b1a17",
  muted: "#5f5b52",
  subtle: "#8c8779",
  line: "#e3e0d7",
  lineStrong: "#d2cec1",
  primary: "#5b7089",
  primaryHover: "#4d6178",
  primaryActive: "#3f5065",
  primarySoft: "#e7ecf2",
  primaryInk: "#3c5170",
  onPrimary: "#fbfaf8",
  gold: "#c9a227",
  goldSoft: "#f2e8cd",
  goldInk: "#87681a",
  success: "#3f7d53",
  successSoft: "#e4eee7",
  successInk: "#2f6340",
  danger: "#b04236",
  dangerHover: "#98392e",
  dangerSoft: "#f7e6e2",
  dangerInk: "#8c3327",
  warning: "#b3801f",
  warningSoft: "#f6ecd6",
  warningInk: "#7f5c14",
  info: "#4a6fa5",
  infoSoft: "#e6ecf5",
  infoInk: "#3a5a8a",
  neutral: "#6f6a5e",
  neutralSoft: "#ece9e1",
  neutralInk: "#4f4b42",
  focus: "#5b7089",
} as const;

/** Every twin. Brand hues pulled toward the cream palette so chips sit inside
 *  the page instead of shouting over it — which is the whole reason these are
 *  hand-picked rather than taken from each vendor: seven real brand colours side
 *  by side in one timeline is a fruit salad, and the surface a marker names
 *  matters more than whose logo it is. Neighbouring hues are kept apart so two
 *  chips in the same row never read as the same service at a glance. */
export const serviceColor = {
  gmail: { ink: "#b23f2f", soft: "#f8e7e3", line: "#eed4cd" },
  slack: { ink: "#6b3f77", soft: "#f1e8f3", line: "#e3d4e7" },
  calendar: { ink: "#2f6497", soft: "#e5edf6", line: "#cfdcea" },
  attio: { ink: "#2f6b5d", soft: "#e3f0ec", line: "#cadfd8" },
  "google-docs": { ink: "#3a5aa8", soft: "#e6eaf7", line: "#d0d8ee" },
  "google-ads": { ink: "#a06a24", soft: "#f7eede", line: "#eaddc4" },
  linkedin: { ink: "#2a5f86", soft: "#e4eef5", line: "#ccdfea" },
} as const;

export type ServiceId = keyof typeof serviceColor;

export const SERVICE_IDS: readonly ServiceId[] = [
  "gmail",
  "slack",
  "calendar",
  "attio",
  "google-docs",
  "google-ads",
  "linkedin",
];

export const SERVICE_LABELS: Record<ServiceId, string> = {
  gmail: "Gmail",
  slack: "Slack",
  calendar: "Calendar",
  attio: "Attio",
  "google-docs": "Google Docs",
  "google-ads": "Google Ads",
  linkedin: "LinkedIn",
};

/** Run lifecycle. `running` is the only one that animates. */
export const statusColor = {
  running: { ink: color.info, soft: color.infoSoft, line: "#cfdcea" },
  passed: { ink: color.successInk, soft: color.successSoft, line: "#cfe0d4" },
  failed: { ink: color.dangerInk, soft: color.dangerSoft, line: "#eed4cd" },
  pending: { ink: color.neutralInk, soft: color.neutralSoft, line: "#ddd9cd" },
  warning: { ink: color.warningInk, soft: color.warningSoft, line: "#e8d7ae" },
  neutral: { ink: color.neutralInk, soft: color.neutralSoft, line: "#ddd9cd" },
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

/** Generous. Cards are 2xl/3xl; controls are md/lg. */
export const radius = {
  sm: "6px",
  md: "10px",
  lg: "14px",
  xl: "20px",
  "2xl": "24px",
  "3xl": "32px",
  full: "9999px",
} as const;

/** Warm-tinted shadows — grey shadows go muddy on cream. */
export const shadow = {
  xs: "0 1px 2px rgba(27, 26, 23, 0.05)",
  sm: "0 1px 3px rgba(27, 26, 23, 0.06), 0 1px 2px rgba(27, 26, 23, 0.04)",
  md: "0 4px 14px -3px rgba(27, 26, 23, 0.10), 0 2px 5px -3px rgba(27, 26, 23, 0.06)",
  lg: "0 18px 44px -14px rgba(27, 26, 23, 0.20), 0 4px 12px -6px rgba(27, 26, 23, 0.10)",
  focus: `0 0 0 3px rgba(91, 112, 137, 0.28)`,
} as const;

/** Small and crisp for data; the display sizes are for serif italic headings. */
export const fontSize = {
  xs: { size: "11px", leading: "14px" },
  sm: { size: "12px", leading: "16px" },
  base: { size: "13px", leading: "18px" },
  md: { size: "14px", leading: "20px" },
  lg: { size: "16px", leading: "24px" },
  xl: { size: "18px", leading: "26px" },
  "2xl": { size: "22px", leading: "28px" },
  "3xl": { size: "28px", leading: "34px" },
  "4xl": { size: "36px", leading: "40px" },
  "5xl": { size: "48px", leading: "52px" },
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
  radius,
  shadow,
  fontSize,
  duration,
  easing,
  layout,
  zIndex,
} as const;
