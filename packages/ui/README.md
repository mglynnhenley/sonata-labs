# @sonata/ui

The Sonata Labs design system. Cream page, serif-italic display headings,
slate-blue primary, gold accent, generously rounded cards. Consumed as TypeScript
source — there is no build step.

## Wiring an app (three edits)

**1. `next.config.ts`**

```ts
const nextConfig: NextConfig = {
  transpilePackages: ["@sonata/ui"],
};
```

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
`"@sonata/ui": "*"` so npm links the workspace.

## Conventions

- Every colour, radius and shadow utility is namespaced `sn-`: `bg-sn-surface`,
  `text-sn-muted`, `border-sn-line`, `rounded-sn-2xl`, `shadow-sn-xs`, `ease-sn`.
  Namespacing keeps the design system clear of the twins' own Gmail/Slack themes.
- `tokens.ts` holds the same values in TypeScript for charts and inline styles,
  and `cssVariables` emits them as a `:root` rule with identical names.
- `.font-display` is the serif italic; use it for h1/h2 only. Data stays sans and
  small.
- Animations: `animate-sn-fade-in`, `-slide-in`, `-rise`, `-pop`, `-pulse`,
  `-indeterminate`. Transitions are 150ms.
- Every clickable thing is an `<a>` or `<button>`. `StatCard` renders as one when
  given `href`/`onClick` — a number should always open its evidence.
