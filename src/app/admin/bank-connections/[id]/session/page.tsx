import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { getCurrentPrincipal } from "../../../../../modules/auth/server";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AdminAccessRequiredBanking, canManageBanking, type Principal } from "../../_components";
import { popularBankConnection, type AdminBankConnection } from "../../page";

interface BankConnectionSessionPageProps {
  params: Promise<{ id: string }>;
}

/**
 * Operator-facing Spanish labels for bank-session statuses. Keep this map
 * complete — the badge MUST NEVER echo the raw underscored enum value
 * (e.g. `needs_admin_action`) to a Dominican banking operator.
 */
const BANK_SESSION_STATUS_LABELS: Record<AdminBankConnection["sessionStatus"], string> = {
  active: "Sesión activa",
  needs_admin_action: "Necesita acción administrativa",
  expired: "Sesión expirada",
};

function bankSessionStatusLabel(status: AdminBankConnection["sessionStatus"]): string {
  return BANK_SESSION_STATUS_LABELS[status];
}

export default async function BankConnectionSessionPage({
  params,
}: BankConnectionSessionPageProps) {
  const [{ id }, principal] = await Promise.all([
    params,
    getCurrentPrincipal(),
  ]);

  return <BankSessionShell connectionId={id} principal={principal} />;
}

export function BankSessionShell({
  connectionId,
  principal,
}: {
  connectionId: string;
  principal: Principal | null;
}) {
  if (!canManageBanking(principal)) {
    return <AdminAccessRequiredBanking />;
  }

  const connection =
    connectionId === popularBankConnection.id
      ? popularBankConnection
      : { ...popularBankConnection, id: connectionId };

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Operaciones bancarias administrativas"
        title="Configuración de sesión de Popular"
        description="Renueve o establezca la sesión controlada del navegador para Banco Popular sin exponer el portal bancario a empleados."
        actions={
          <Badge variant="warning" className="gap-1.5">
            <TriangleAlert className="h-3 w-3" aria-hidden />
            {bankSessionStatusLabel(connection.sessionStatus)}
          </Badge>
        }
      />

      <Card>
        <CardHeader>
          <CardDescription>Conexión</CardDescription>
          <CardTitle>
            {connection.bankName} · {connection.accountNumber}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm text-muted-foreground">
          <section className="grid gap-2 rounded-lg border border-border/60 bg-card/60 p-4">
            <h2 className="text-sm font-semibold text-foreground">El token solo lo ingresa un administrador</h2>
            <p>
              Si Popular solicita un token celular, la corrida se pausa y la atiende un administrador
              autorizado o un operador de sesión.
            </p>
            <h2 className="text-sm font-semibold text-foreground">Dispositivo físico de token</h2>
            <p>
              El navegador del servidor local puede reutilizar cookies confiables, pero la autorización
              de un dispositivo nuevo todavía requiere el dispositivo físico.
            </p>
          </section>

          <section className="grid gap-2 rounded-lg border border-border/60 bg-muted/20 p-4 text-sm">
            <h2 className="font-semibold text-foreground">Para renovar la sesión</h2>
            <ol className="grid list-decimal gap-1.5 pl-5 text-muted-foreground leading-relaxed">
              <li>Abra el portal bancario en una estación autorizada para administradores.</li>
              <li>Complete el inicio de sesión y cualquier validación MFA con el dispositivo físico de token.</li>
              <li>Regrese aquí y dispare una nueva corrida; la sesión se detectará automáticamente.</li>
            </ol>
          </section>

          <p>
            Los usuarios de consulta nunca reciben controles de sesión bancaria, cookies, credenciales,
            solicitudes de token ni datos de balance.
          </p>

          <Button asChild variant="outline" className="w-fit">
            <Link href="/admin/bank-connections">Volver a conexiones</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
