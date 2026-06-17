/**
 * Admin layout — server-side auth gate for all routes under /admin/*.
 *
 * Two-layer enforcement:
 * 1. Unauthenticated → redirect to /login (session cookie absent or invalid).
 * 2. Authenticated but not admin → show a minimal 403-style access denied page.
 */

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
        <div className="max-w-md text-center">
          <h1 className="mb-2 text-2xl font-semibold">Admin access required</h1>
          <p className="text-muted-foreground">
            This area is restricted to administrators. Contact the workspace owner if
            you believe you should have access.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
