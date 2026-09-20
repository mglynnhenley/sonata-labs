import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Continuity desk · Sonata",
  description: "The records, receipts and submissions a critical-infrastructure desk works in.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
