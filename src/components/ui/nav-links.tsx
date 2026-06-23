"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftRight,
  KeyRound,
  LayoutDashboard,
  ScrollText,
} from "lucide-react";

import { cn } from "../../lib/utils";

const NAV_LINKS = [
  { href: "/transactions", label: "Transacciones", icon: LayoutDashboard },
  { href: "/admin/bank-connections", label: "Conexiones", icon: KeyRound },
  { href: "/admin/scrape-runs", label: "Administración", icon: ArrowLeftRight },
  { href: "/admin/audit", label: "Auditoría", icon: ScrollText },
] as const;

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="Principal" className="flex items-center gap-1">
      {NAV_LINKS.map((link) => {
        const Icon = link.icon;
        const isActive = pathname !== null && (pathname === link.href || pathname.startsWith(link.href + "/"));
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              "focus-visible:bg-muted focus-visible:text-foreground",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon
              className={cn(
                "h-4 w-4 transition-transform",
                isActive ? "text-primary" : "group-hover:scale-110",
              )}
              aria-hidden
            />
            <span className="hidden sm:inline">{link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
