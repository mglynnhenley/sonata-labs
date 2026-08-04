import type { Metadata } from "next";
import { ToastProvider } from "@sonata/ui";
import { fontVariables } from "@sonata/ui/fonts";
import { AppSidebar } from "./_components/AppSidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sonata Labs",
  description: "Clone your business, then test how well your agent does the work inside the clone.",
};

/**
 * The shell: a sticky sidebar and one generous content column. Everything the
 * dashboard shows lives in that column at a fixed maximum width, so a run
 * timeline and a settings form read at the same measure.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={fontVariables}>
      <body>
        <ToastProvider>
          <a href="#main" className="sn-skip rounded-sn-md border border-sn-line bg-sn-surface px-3 py-2 text-[13px] font-medium text-sn-ink shadow-sn-md">
            Skip to content
          </a>
          <div className="flex min-h-dvh items-stretch">
            <AppSidebar />
            <main id="main" className="sn-scroll min-w-0 flex-1">
              <div className="mx-auto w-full max-w-[1180px] px-8 py-12 lg:px-14 lg:py-16">
                {children}
              </div>
            </main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
