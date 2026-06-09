import type { Metadata } from "next";
import Link from "next/link";
import { Toaster } from "sonner";
import type { ReactNode } from "react";
import {
  ArrowLeftRight,
  Building2,
  History,
  KeyRound,
  LayoutDashboard,
  ScrollText,
} from "lucide-react";

import "./globals.css";

export const metadata: Metadata = {
  title: "RD-Sync",
  description: "Private read-only bank transaction visibility dashboard.",
};

const NAV_LINKS = [
  { href: "/transactions", label: "Transactions", icon: LayoutDashboard },
  { href: "/admin/bank-connections", label: "Connections", icon: KeyRound },
  { href: "/admin/scrape-runs", label: "Admin", icon: ArrowLeftRight },
  { href: "/admin/audit", label: "Audit log", icon: ScrollText },
] as const;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          Skip to main content
        </a>

        <header className="sticky top-0 z-30 border-b border-border/80 bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
            <Link
              href="/"
              className="group flex items-center gap-2.5 transition-opacity hover:opacity-80"
            >
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
                <Building2 className="h-5 w-5" aria-hidden />
              </span>
              <span className="flex flex-col leading-none">
                <span className="text-base font-semibold tracking-tight text-foreground">
                  RD<span className="text-primary">·</span>Sync
                </span>
                <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Bank visibility
                </span>
              </span>
            </Link>

            <nav aria-label="Primary" className="flex items-center gap-1">
              {NAV_LINKS.map((link) => {
                const Icon = link.icon;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="group inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
                  >
                    <Icon className="h-4 w-4 transition-transform group-hover:scale-110" aria-hidden />
                    <span className="hidden sm:inline">{link.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </header>

        <main
          id="main"
          tabIndex={-1}
          className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6 lg:px-8"
        >
          {children}
        </main>

        <footer className="border-t border-border/60 py-6">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 text-xs text-muted-foreground sm:px-6 lg:px-8">
            <span>RD-Sync · Read-only bank visibility</span>
            <span className="inline-flex items-center gap-1.5">
              <History className="h-3 w-3" aria-hidden />
              <span>Last sync: live</span>
            </span>
          </div>
        </footer>

        <Toaster richColors theme="dark" position="top-right" />
      </body>
    </html>
  );
}
