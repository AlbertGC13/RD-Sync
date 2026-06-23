/**
 * Admin layout — server-side auth gate for all routes under /admin/*.
 *
 * Two-layer enforcement:
 * 1. Unauthenticated → redirect to /login (session cookie absent or invalid).
 * 2. Authenticated but not admin → show a minimal 403-style access denied page.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentPrincipal } from "../../modules/auth/server";

interface AdminLayoutProps {
  children: React.ReactNode;
}

export default async function AdminLayout({ children }: AdminLayoutProps) {
  const principal = await getCurrentPrincipal();

  if (!principal) {
    redirect("/login");
  }

  if (principal.role !== "admin") {
    return (
      <div className="flex min-h-screen items-center justify-center p-8">
        <div className="max-w-md text-center grid gap-4">
          <h1 className="text-2xl font-semibold">Acceso administrativo requerido</h1>
          <p className="text-muted-foreground">
            Esta área está restringida a administradores. Contacta al propietario del espacio de
            trabajo si crees que deberías tener acceso.
          </p>
          <Link
            href="/transactions"
            className="mx-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            ← Volver a transacciones
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
