import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Attio · Sonata', description: 'Your simulated workspace: companies, people, deals and follow-ups.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
