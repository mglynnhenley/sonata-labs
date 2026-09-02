// Compiles @sonata/ui's Tailwind v4 styling into one real stylesheet for
// design-sync. The package deliberately ships no compiled CSS — each Next app
// compiles it via `@import "tailwindcss"` + `@source` — but the claude.ai/design
// bundle has no Tailwind build, so this produces the closure the previews and
// the design agent consume: theme variables, preflight, and every utility the
// component sources actually use.
//
// Output: packages/ui/.ds-css/sonata-ui.css (gitignored; rebuilt every sync).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages/ui");
const outDir = join(pkg, ".ds-css");
mkdirSync(outDir, { recursive: true });

// The input lives inside the package so @source and the styles import resolve
// exactly as they do in an app's globals.css.
const input = join(outDir, "input.css");
writeFileSync(
  input,
  [
    '@import "tailwindcss";',
    '@import "../src/styles.css";',
    '@source "../src";',
    // The scan only emits utilities the package source uses, but the semantic
    // families are documented API for the design agent (see conventions.md) —
    // safelist them so bg-sn-success-soft exists even though the library
    // itself never paints that background.
    '@source inline("{bg,text,border}-sn-{success,danger,warning,info,neutral,primary,gold}");',
    '@source inline("{bg,text,border}-sn-{success,danger,warning,info,neutral,primary,gold}-{soft,ink}");',
    '@source inline("{bg,text,border}-sn-{running,passed,failed,pending}-{soft,ink,line}");',
    "",
  ].join("\n"),
);

const cli = join(root, ".ds-sync/node_modules/.bin/tailwindcss");
const out = join(outDir, "sonata-ui.css");
execFileSync(cli, ["-i", input, "-o", out], { stdio: "inherit", cwd: pkg });

// Prepend the font wiring the app normally gets from next/font: the CSS
// variables the theme reads, and Geist Mono from Google (Satoshi's
// @font-face rules ship via extraFonts, pointing at the vendored woff2s).
const compiled = readFileSync(out, "utf8");
const prelude =
  '@import url("https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=swap");\n' +
  ":root{--font-sn-sans:'Satoshi';--font-sn-mono:'Geist Mono'}\n";
writeFileSync(out, prelude + compiled);
console.log(`[build-css] wrote ${out} (${(compiled.length / 1024).toFixed(0)}kB)`);
