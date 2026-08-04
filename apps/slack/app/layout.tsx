import type { Metadata } from "next";
import { Lato } from "next/font/google";
import "./globals.css";

// Slack's product typeface is Lato (shipped as "Slack-Lato"). Using the real
// face is most of what makes the replica read as Slack at a glance.
const lato = Lato({
  subsets: ["latin"],
  weight: ["400", "700", "900"],
  variable: "--font-lato",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Acme | Slack Sandbox",
  description: "Slack sandbox clone — a safe workspace for observing agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={lato.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
