import type { Metadata } from "next";

import { sanitizeNextParam } from "../../lib/next-redirect-sanitizer";
import { LoginForm } from "./_components/login-form";

export const metadata: Metadata = {
  title: "Sign in · RD-Sync",
};

interface LoginPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolved = searchParams ? await searchParams : {};
  const rawNext = Array.isArray(resolved.next) ? resolved.next[0] : resolved.next;
  const next = sanitizeNextParam(rawNext);

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to RD-Sync</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Enter your credentials to continue.
          </p>
        </div>

        <LoginForm next={next} />
      </div>
    </div>
  );
}
