import type { Metadata } from "next";
import Link from "next/link";
import { Toaster } from "sonner";
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
        <nav
          aria-label="Admin navigation placeholder"
          className="flex items-center gap-4 border-b border-border bg-background px-6 py-3 text-sm text-foreground"
        >
          <Link href="/transactions" className="text-foreground hover:text-accent">
            Transactions
          </Link>
          <Link href="/admin/scrape-runs" className="text-foreground hover:text-accent">
            Admin
          </Link>
        </nav>
        {children}
        <Toaster richColors theme="dark" />
      </body>
    </html>
  );
}
