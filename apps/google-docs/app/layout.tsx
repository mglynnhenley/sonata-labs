import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Google Docs — Sandbox",
  description: "Local Google Docs sandbox for agent testing",
};

// No stylesheet and no webfont: this clone ships an API and a one-page index, and
// a Docs-replica editor is phase 2 (UI port 4400 is reserved for it). Pulling a
// font in here would also make a build on a network-isolated machine fail in the
// layout rather than in anything anyone wrote.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
