import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Google Ads — Sandbox",
  description: "Local Google Ads sandbox for agent testing",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// The root layout exists because Next requires one for the landing page. There
// is no stylesheet and no web font: this clone ships no replica UI, and loading
// a typeface nothing renders would be noise in every build.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
