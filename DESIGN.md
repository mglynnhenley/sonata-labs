# Design System — Sonata Labs

## Product Context
- **What this is:** Clone a business into fake Gmail/Slack/Calendar, run an AI agent through a simulated workday inside it, score how much of the job it finished.
- **Who it's for:** People building and evaluating AI agents.
- **Space:** Agent evaluation / dev tooling (Braintrust, Langfuse, LangSmith adjacent).
- **Project type:** Data-dense product dashboard. Local-first.
- **The memorable thing:** "A simulator you can watch live — the day plays out in front of you."

## Aesthetic Direction
- **Direction:** Calm modern product. The register of ElevenLabs' agent console: light, airy, whisper-quiet elevation, insight-led.
- **Decoration level:** Minimal. Provenance and numbers do the explaining; no explainer paragraphs on dashboards.
- **Mood:** Confident, warm, quiet. A product, not a demo and not a terminal.
- **What it replaced, deliberately:** cream + Instrument Serif italic + Inter + muted slate blue — the AI-default combo. Do not reintroduce any of these.

## Typography
- **Display & UI:** Satoshi (Fontshare, vendored woff2). Weight does the hierarchy work: 900 for page titles and the wordmark, 700 for headings/buttons, 500/400 for body. Tight tracking on display sizes (−0.02em to −0.035em).
- **Numerals / metadata:** Geist Mono, `tabular-nums`, used sparingly — timestamps, counts, sync states, run ids. Never for prose.
- **Banned:** Inter, Instrument Serif, Space Grotesk, system-ui as primary.
- **Scale:** 30/26 display · 15/14.5 card titles · 13.5 body · 12 meta · 11 mono-meta.

## Color
- **Approach:** Restrained. One accent with conviction; state colours carry meaning; everything else is neutral.
- **Background (paper):** `#F7F6F2` — warm, kept from the old system's temperament.
- **Surface:** `#FFFFFF`
- **Ink:** `#16181A` · muted `#5A6060` · subtle `#8A908D`
- **Line:** `#ECEAE2` (hairlines), `#F1EFE9` (internal dividers)
- **Accent (petrol):** `#0E5C55`, soft `#E3F0EC` — primary CTAs, active states, chart line, "new" markers.
- **State (muted, per the ElevenLabs reference — never saturated traffic-light hues):**
  - pass / yes: sage `#63936F`, soft `#E4EEE6`, ink-on-soft `#3F6B4C`
  - fail / no: terracotta `#B26355`, soft `#F5E6E1`, ink-on-soft `#8E4335`
  - warn / syncing: ochre `#8A6520`, soft `#F5EBD6`
  - Boolean pills (Yes/No cells) are *filled* sage/terracotta with white text; graded states use soft bg + ink-on-soft.
- **Data viz:** teal `#5D9C9C` + terracotta `#B26355` as the categorical pair; petrol reserved for the primary series; thresholds are dashed `#C24C3F`.
- **Atmosphere:** very soft pastel washes (sage/blue tints at ≤8% over paper) allowed behind hero and empty states — never behind data.
- **Rule:** buttons are ink or petrol or outlined — never a state colour. State colours appear only on badges, pills, deltas and chart marks.
- **Dark mode:** none. Light-only; `color-scheme: light`.

## Spacing & Layout
- **Rhythm tiers (kept from prior pass):** section 40 / block 24 / group 16 / item 8 (`sn-stack-*`).
- **Radii:** cards 14 · controls 10 · buttons pill (9999) · avatars circle.
- **Shadows:** whisper only — `0 1px 2px rgba(22,24,26,.04)`; hover `0 4px 16px -8px rgba(22,24,26,.10)`. Never heavier.
- **Sidebar:** white, hairline right border, grouped nav with 11px group labels, workspace/sync state pinned bottom.
- **Content column:** max 1120–1180px, gutters 40/44.

## Components — signature moves
- **Insight cards:** severity pill + one-line headline + one-sentence body + action button. The product states the finding and hands over the action ("View run", "Review"). Prefer these over raw stat grids on Home.
- **Stat strip + chart:** plain numbers with tiny labels in one panel, active metric underlined, one calm area chart (petrol line, soft gradient fill, hover tooltip card).
- **Provenance line:** every generated artifact shows where it came from (`#client-fires · Tue`, `billing@ · Fri`) in Geist Mono with source glyphs.
- **Pills over rectangles:** buttons, badges, filters (segmented control with ink-filled active) are all rounded-full.

## Motion
- **Approach:** intentional. One choreographed page-load: staggered rise (8px translate + fade, 450ms, `cubic-bezier(.16,1,.3,1)`, 60ms steps). Hover: cards lift 2px with border darkening. One pulse allowed: the live/sync dot.
- **Reduced motion:** all of the above collapse; spinners keep turning slowly (`data-loading-motion` carve-out).

## Navigation (IA, from the approved v3 mockup)
Home · **Workspace:** Clones, Scenarios · **Testing:** Runs, Sessions, Results · **Configure:** Sources, Settings.
`/sessions` and `/connect` must always have nav entries — they were orphaned once; never again.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-13 | Initial system from /design-consultation | Replaced AI-default cream/serif after category research (Braintrust, Modal, Langfuse) and three iterations with the user; final register set by ElevenLabs console reference |
| 2026-08-13 | Two-surface (light/dark) idea rejected | User call: one surface, lower maintenance |
| 2026-08-13 | Dark-pine sidebar + volt accent rejected | User reference showed light, calm register |
