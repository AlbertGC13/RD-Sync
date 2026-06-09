import { assertCanAccessBankSession, type Principal } from "../../../modules/auth";

export type { Principal };

export function canManageBanking(principal: Principal | null) {
  try {
    assertCanAccessBankSession(principal);
    return true;
  } catch {
    return false;
  }
}

export function AdminAccessRequiredBanking() {
  return (
    <section className="grid gap-3 rounded-lg border border-border/60 bg-card p-6">
      <p className="text-lg font-semibold text-foreground">Admin access required</p>
      <p className="text-sm text-muted-foreground">
        Only admins can manage bank connections, session renewal, or restricted bank operations.
        Ask the workspace owner for the{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">admin</code>{" "}
        role if you need to manage bank connection setup.
      </p>
    </section>
  );
}
