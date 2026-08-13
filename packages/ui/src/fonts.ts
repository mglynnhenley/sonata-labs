import localFont from "next/font/local";
import { Geist_Mono } from "next/font/google";

/**
 * The two faces. Loaded here rather than in each app so every surface gets the
 * same variables: styles.css reads --font-sn-sans / --font-sn-mono.
 *
 * Satoshi is vendored (Fontshare's licence permits self-hosting; there is no
 * Google Fonts fallback for it, and the 900 weight is the display voice of the
 * whole system — see DESIGN.md). Weight does the hierarchy work: 900 display,
 * 700 headings and buttons, 500/400 text.
 *
 * next/font only runs through Next's compiler, so an app consuming this must
 * list @sonata/ui in `transpilePackages`.
 */

export const sansFont = localFont({
  src: [
    { path: "./fonts/Satoshi-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Satoshi-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Satoshi-700.woff2", weight: "700", style: "normal" },
    { path: "./fonts/Satoshi-900.woff2", weight: "900", style: "normal" },
  ],
  display: "swap",
  variable: "--font-sn-sans",
});

/** Numerals and metadata only — timestamps, counts, run ids. Never prose. */
export const monoFont = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-sn-mono",
});

/** Put on <html> or <body>. */
export const fontVariables = `${sansFont.variable} ${monoFont.variable}`;
