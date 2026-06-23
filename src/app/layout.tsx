import type { Metadata } from "next";
import Link from "next/link";
import { Toaster } from "sonner";
import type { ReactNode } from "react";
import { Building2, History } from "lucide-react";

import { NavLinks } from "../components/ui/nav-links";
import "./globals.css";

export const metadata: Metadata = {
  title: "RD-Sync",
  description: "Panel de visibilidad privada y de solo lectura sobre transacciones bancarias.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es">
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
        >
          Ir al contenido principal
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
                  Visibilidad bancaria
                </span>
              </span>
            </Link>

            <NavLinks />
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
            <span>RD-Sync · Visibilidad bancaria de solo lectura</span>
            <span className="inline-flex items-center gap-1.5">
              <History className="h-3 w-3" aria-hidden />
              <span>Última sincronización: en vivo</span>
            </span>
          </div>
        </footer>

        <Toaster richColors theme="dark" position="top-right" />
      </body>
    </html>
  );
}
