import type { Metadata } from "next";
import { ToastProvider } from "@sonata/ui";
import { fontVariables } from "@sonata/ui/fonts";
import { AppShell } from "./_components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sonata Labs",
  description: "Clone a company. Test your agent inside it.",
};

/**
 * The document. AppShell owns the sidebar, the narrow-screen top bar and the one
 * generous content column — everything the dashboard shows lives in that column
 * at a fixed maximum width, so a run timeline and a settings form read at the
 * same measure.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fontVariables}>
      <head>
        {/* Matches --color-sn-bg, so a phone's chrome does not band against the page. */}
        <meta name="theme-color" content="#f7f6f2" />
      </head>
      <body>
        <ToastProvider>
          <a href="#main" className="sn-skip rounded-sn-md border border-sn-line bg-sn-surface px-3 py-2 text-[13px] font-medium text-sn-ink shadow-sn-md">
            Skip to content
          </a>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
