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
      <p className="text-lg font-semibold text-foreground">Acceso de administrador requerido</p>
      <p className="text-sm text-muted-foreground">
        Solo los administradores pueden gestionar conexiones bancarias, renovar sesiones o ejecutar operaciones bancarias restringidas.
        Solicite al propietario del espacio el rol{" "}
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">admin</code>{" "}
        si necesita configurar conexiones bancarias.
      </p>
    </section>
  );
}
