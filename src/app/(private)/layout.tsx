/**
 * Private layout — server-side auth gate for all routes under (private)/.
 *
 * This is the real security boundary for employee-facing pages.
 * The Edge middleware does a cookie presence check; this layout performs
 * the full cryptographic verification via getCurrentPrincipal().
 */

import { redirect } from "next/navigation";

import { getCurrentPrincipal } from "../../modules/auth/server";

interface PrivateLayoutProps {
  children: React.ReactNode;
}

export default async function PrivateLayout({ children }: PrivateLayoutProps) {
  const principal = await getCurrentPrincipal();

  if (!principal) {
    redirect("/login");
  }

  return <>{children}</>;
}
