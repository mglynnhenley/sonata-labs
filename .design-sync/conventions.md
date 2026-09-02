# Sonata UI — how to build with it

Warm-paper product UI: page background `--color-sn-bg` (#f7f6f2), white cards, near-black ink, ONE petrol accent (#0e5c55) that is rationed. Type is Satoshi for everything (weight does hierarchy: 900 display, 700 headings/buttons, 400/500 text) and Geist Mono for numerals/metadata only. Both ship with this bundle — never substitute Inter or a serif.

## Setup

No provider is required for rendering. Wrap the app in `ToastProvider` only when using `useToast()`. Components style themselves; the page supplies background `var(--color-sn-bg)` and text `var(--color-sn-ink)` (both applied by `styles.css` on `body`).

## Styling idiom — Tailwind utilities on the `sn-` theme

Style your own layout glue with these class families (all defined by the shipped `styles.css`):

| Family | Classes |
|---|---|
| Surfaces | `bg-sn-bg` `bg-sn-bg-subtle` `bg-sn-surface` `bg-sn-surface-hover` |
| Ink | `text-sn-ink` `text-sn-muted` `text-sn-subtle` |
| Lines | `border-sn-line` `border-sn-line-strong` |
| Accent (rationed) | `bg-sn-primary` `text-sn-primary` `bg-sn-primary-soft` `text-sn-primary-ink` |
| States (badges/pills only) | `*-sn-success` `*-sn-danger` `*-sn-warning` `*-sn-info` `*-sn-neutral`, each with `-soft` and `-ink` |
| Run status | `*-sn-running` `*-sn-passed` `*-sn-failed` `*-sn-pending`, each with `-ink` `-soft` `-line` |
| Radii | `rounded-sn-sm` (6) `rounded-sn-md` (10) `rounded-sn-lg` (12) `rounded-sn-2xl` (14, cards) — buttons are `rounded-full` pills (Button does this itself) |
| Shadows | `shadow-sn-xs` (cards) `shadow-sn-md` (hover) `shadow-sn-lg` (modals) — never heavier |
| Vertical rhythm | `sn-stack-section` (40px) `sn-stack-block` (24) `sn-stack-group` (16) `sn-stack-item` (8) — flex-column stacks; use the tier, don't invent gaps |
| Type | `font-display` (Satoshi 900 tight — page titles, big values) `font-display-upright` (Geist Mono — clocks/readouts) `data-numeric` attribute for tabular figures |

**Constraint:** the shipped CSS contains only utilities the library itself uses. The families above are safe; arbitrary Tailwind classes (`grid-cols-7`, `w-96`, …) may not exist — use inline styles for novel layout values.

## House rules

- ONE petrol-primary button per view; everything else `secondary` (outlined) or `ghost`.
- State colours appear only on `Badge`, `Chip`, deltas and chart marks — never on buttons or chrome.
- Live/running is petrol and is the loudest thing on a page; `Badge status="running" dot` pulses.
- Numbers, timestamps, run ids: Geist Mono via `font-display-upright` or `data-numeric` — never prose.
- Dashboards state findings and hand over the action (severity pill + one-line headline + one button), not raw stat dumps.

## Truth

Read `styles.css` (all tokens under `@theme`/`:root`) and each component's `.d.ts` + `.prompt.md` before styling. Icons: `size` takes `"xs"|"sm"|"md"|"lg"` (12/14/16/20) or a number.

## Idiomatic slice

```tsx
<div className="sn-stack-section">
  <PageHeader eyebrow="Overview" title="What's happening"
    subtitle="Autonomy is the share of the day's work your agent finished without handing it back to a human."
    actions={<Button variant="primary">New run</Button>} />
  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
    <StatCard label="Autonomy" value="76%" hint="Mean across 21 scored runs" />
    <StatCard label="Runs" value="44" hint="21 companies · 21 scenarios" />
    <StatCard label="Spend" value="$12.06" hint="Every model call so far" />
  </div>
  <Table columns={columns} rows={runs} rowKey={(r) => r.id} rowHref={(r) => `/runs/${r.id}`} />
</div>
```
