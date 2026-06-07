import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "RD-Sync",
  description: "Private read-only bank transaction visibility dashboard.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="app-nav" aria-label="RD-Sync navigation">
          <Link className="brand-link" href="/">
            RD-Sync
          </Link>
          <nav aria-label="Primary">
            <Link href="/transactions">Transactions</Link>
            <Link href="/admin/scrape-runs?previewRole=admin">Admin demo</Link>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
