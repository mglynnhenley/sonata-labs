import { Instrument_Serif, Inter } from "next/font/google";

/**
 * The two faces. Loaded here rather than in each app so every surface gets the
 * same variables: styles.css reads --font-sn-display / --font-sn-sans.
 *
 * next/font only runs through Next's compiler, so an app consuming this must
 * list @sonata/ui in `transpilePackages`.
 */

/** Display: serif, italic, 400 — the only weight Instrument Serif ships. */
export const displayFont = Instrument_Serif({
  weight: "400",
  style: "italic",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sn-display",
});

export const sansFont = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sn-sans",
});

/** Put on <html> or <body>. */
export const fontVariables = `${displayFont.variable} ${sansFont.variable}`;
