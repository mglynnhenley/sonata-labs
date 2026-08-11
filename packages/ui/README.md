# @sonata/ui

The [Sonata Labs](../../README.md) design system: cream page, serif-italic display
headings, slate-blue primary, gold accent, generously rounded cards. Consumed as
TypeScript source — there is no build step.

It dresses **Sonata's own surfaces**, not the twins'. `apps/platform` is the only
consumer today. The clones deliberately do not use it: a Gmail replica has to look
like Gmail and a Slack replica like Slack, or an agent's behaviour stops being
evidence about the real thing.

## Wiring an app (three edits, plus the dependency)

**1. `next.config.ts`**

```ts
const nextConfig: NextConfig = {
  transpilePackages: ["@sonata/ui"],
};
```

`fonts.ts` calls `next/font`, which only runs through Next's own compiler — so
this is required, not an optimisation.

**2. `app/globals.css`**

```css
@import "tailwindcss";
@import "@sonata/ui/styles.css";
/* Tailwind resolves the import through the node_modules symlink and its scanner
   honours .gitignore, so point @source at the real workspace path or the
   components' classes will not be generated. */
@source "../../../packages/ui/src";
```

**3. `app/layout.tsx`**

```tsx
import { fontVariables } from "@sonata/ui/fonts";

<html lang="en" className={fontVariables}>
```

`@sonata/ui` must also be listed in the app's `package.json` dependencies as
`"@sonata/ui": "*"` so npm links the workspace. Miss it and the import resolves
in the editor (hoisted `node_modules`) while the build has nothing to transpile.

## What's in it

Sixteen components — `Badge`, `Button`, `Card`, `Chip`, `CodeBlock`,
`EmptyState`, `Modal`, `PageHeader`, `ProgressBar`, `Sidebar`, `Spinner`,
`StatCard`, `Table`, `Tabs`, `Timeline`, `Toast` — plus an icon set, `cn`, and
`tokens.ts`.

## Conventions

- Every colour, radius and shadow utility is namespaced `sn-`: `bg-sn-surface`,
  `text-sn-muted`, `border-sn-line`, `rounded-sn-2xl`, `shadow-sn-xs`, `ease-sn`.
  Namespacing keeps the design system clear of the twins' own Gmail/Slack themes,
  which live in those apps and use raw hex on purpose.
- `tokens.ts` holds the same values in TypeScript for charts and inline styles;
  `styles.css` mirrors them in a Tailwind `@theme` block because Tailwind needs
  literal values at build time. **The two files must be edited together.**
  `cssVariables` emits the same names as a `:root` rule, so an app can override
  the compiled theme at runtime without a rebuild.
- `.font-display` is the serif italic (Instrument Serif, 400, the only weight it
  ships); use it for h1/h2 only. Data stays sans and small.
- Animations: `animate-sn-fade-in`, `-slide-in`, `-rise`, `-pop`, `-pulse`,
  `-shimmer`, `-indeterminate`. 150ms is the house transition; anything slower
  reads as lag.
- `serviceColor` carries the three twins' brand hues pulled toward the cream
  palette, so a Gmail or Slack chip sits inside the page instead of shouting
  over it.
- Every clickable thing is an `<a>` or `<button>`. `StatCard` renders as one when
  given `href`/`onClick` — a number should always open its evidence.
