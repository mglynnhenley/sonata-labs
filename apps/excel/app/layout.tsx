import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Reporting workbook · Sonata',
  description: 'Review reporting data, formulas, and proposed changes in a shared workbook.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
