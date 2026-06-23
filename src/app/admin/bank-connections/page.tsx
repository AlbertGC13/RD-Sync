import Link from "next/link";
import { Plus } from "lucide-react";

import { getCurrentPrincipal } from "../../../modules/auth/server";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { PageHeader } from "../../../components/ui/page-header";
import { bankSessionStatusLabel } from "../../../lib/banks";
import { AdminAccessRequiredBanking, canManageBanking, type Principal } from "./_components";

export interface AdminBankConnection {
  id: string;
  bankName: string;
  accountNumber: string;
  accountType: string;
  currency: string;
  sessionStatus: "active" | "needs_admin_action" | "expired";
  extractionMode: string;
}

export const popularBankConnection: AdminBankConnection = {
  id: "popular-0000000000",
  bankName: "Banco Popular",
  accountNumber: "0000000000",
  accountType: "Corriente",
  currency: "DOP",
  sessionStatus: "needs_admin_action",
  extractionMode: "Búsqueda por fecha del día actual",
};

/**
 * Operator-facing Spanish labels for bank-session statuses come from
 * `src/lib/banks.ts` (`BANK_SESSION_STATUS_LABELS`) — the single source of
 * truth — so the badge never echoes the raw underscored enum value
 * (e.g. `needs_admin_action`) to a Dominican banking operator.
 */

export default async function AdminBankConnectionsPage() {
  const principal = await getCurrentPrincipal();

  return (
    <AdminBankConnectionsDashboard
      principal={principal}
      connections={[popularBankConnection]}
    />
  );
}

export function AdminBankConnectionsDashboard({
  principal,
  connections,
}: {
  principal: Principal | null;
  connections: readonly AdminBankConnection[];
}) {
  if (!canManageBanking(principal)) {
    return <AdminAccessRequiredBanking />;
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Operaciones bancarias administrativas"
        title="Conexiones bancarias"
        description="Configure visibilidad bancaria de solo lectura y mantenga el manejo de sesiones restringido a operadores autorizados."
        actions={
          <Button asChild>
            <Link href="/admin/bank-connections/new">
              <Plus className="h-4 w-4" aria-hidden />
              Nueva conexión
            </Link>
          </Button>
        }
      />

      <section className="grid gap-4" aria-label="Conexiones bancarias configuradas">
        {connections.map((connection) => (
          <Card key={connection.id}>
            <CardHeader>
              <div className="flex flex-wrap justify-between gap-3 text-sm">
                <Badge variant="outline">{connection.bankName}</Badge>
                <Badge variant="warning">{bankSessionStatusLabel(connection.sessionStatus)}</Badge>
              </div>
              <CardTitle>Cuenta {connection.accountType.toLowerCase()}</CardTitle>
              <CardDescription>
                Cuenta {connection.accountNumber} · {connection.currency}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <p className="text-sm text-muted-foreground">
                Producto: {connection.accountType}. Moneda: {connection.currency}.
                Extracción: {connection.extractionMode}.
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <p className="text-sm text-muted-foreground">
                  Popular filtra por fecha, no por hora. El horario del worker controla la
                  ventana operativa de 8:00 AM a 6:00 PM.
                </p>
                <Button asChild variant="outline">
                  <Link href={`/admin/bank-connections/${connection.id}/session`}>
                    Renovar sesión
                  </Link>
                </Button>
              </div>

              <p className="rounded-lg border border-border/60 bg-card/60 p-4 text-sm text-muted-foreground">
                Los empleados pueden ver la cuenta {connection.accountNumber} en las vistas de transacciones,
                pero nunca controles de sesión bancaria, balances, credenciales, cookies ni solicitudes MFA.
              </p>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
