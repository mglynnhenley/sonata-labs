import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LinkedIn — Sandbox",
  description: "Local LinkedIn sandbox for agent testing",
};

// No globals.css and no Tailwind: this clone is an API service, and the one page
// it serves styles itself inline. A stylesheet nothing but a landing page reads
// is config a future reader would assume is load-bearing.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
