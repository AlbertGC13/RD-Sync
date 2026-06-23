import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { getCurrentPrincipal } from "../../../../modules/auth/server";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../../components/ui/card";
import { PageHeader } from "../../../../components/ui/page-header";
import { AdminAccessRequiredBanking, canManageBanking, type Principal } from "../_components";
import { popularBankConnection } from "../page";

export default async function NewBankConnectionPage() {
  const principal = await getCurrentPrincipal();

  return <NewBankConnectionShell principal={principal} />;
}

export function NewBankConnectionShell({ principal }: { principal: Principal | null }) {
  if (!canManageBanking(principal)) {
    return <AdminAccessRequiredBanking />;
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Operaciones bancarias administrativas"
        title="Nueva conexión bancaria"
        description="Cree la primera referencia de conexión de Banco Popular antes de abrir una sesión controlada."
        actions={<Badge variant="outline">Popular primero</Badge>}
      />

      <Card>
        <CardHeader>
          <CardTitle>Banco Popular</CardTitle>
          <CardDescription>
            Configure la cuenta {popularBankConnection.accountNumber} como objetivo de consulta de solo lectura.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Cuenta {popularBankConnection.accountType} · {popularBankConnection.accountNumber}.
            Modo de búsqueda: {popularBankConnection.extractionMode}. Worker: servidor local primero,
            VPS más adelante.
          </p>

          <p className="rounded-lg border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
            Esta pantalla registra solo el contrato del producto. Las credenciales se ingresan luego en el
            flujo controlado de sesión bancaria y nunca se almacenan en texto plano.
          </p>

          <Button asChild className="w-fit">
            <Link href={`/admin/bank-connections/${popularBankConnection.id}/session`}>
              Continuar a configuración de sesión
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
