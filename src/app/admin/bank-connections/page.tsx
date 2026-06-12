import { headers } from "next/headers";
import Link from "next/link";
import { Plus } from "lucide-react";

import { resolvePrincipalFromTrustedHeaders } from "../../../modules/auth";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { PageHeader } from "../../../components/ui/page-header";
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
  extractionMode: "Current-day date search",
};

export default async function AdminBankConnectionsPage() {
  const principal = resolvePrincipalFromTrustedHeaders(await headers());

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
        eyebrow="Admin bank operations"
        title="Bank connections"
        description="Configure read-only bank visibility and keep session work restricted to authorized operators."
        actions={
          <Button asChild>
            <Link href="/admin/bank-connections/new">
              <Plus className="h-4 w-4" aria-hidden />
              New connection
            </Link>
          </Button>
        }
      />

      <section className="grid gap-4" aria-label="Configured bank connections">
        {connections.map((connection) => (
          <Card key={connection.id}>
            <CardHeader>
              <div className="flex flex-wrap justify-between gap-3 text-sm">
                <Badge variant="outline">{connection.bankName}</Badge>
                <Badge variant="warning">Session action required</Badge>
              </div>
              <CardTitle>{connection.accountType} account</CardTitle>
              <CardDescription>
                Account {connection.accountNumber} · {connection.currency}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <p className="text-sm text-muted-foreground">
                Product: {connection.accountType}. Currency: {connection.currency}.
                Extraction: {connection.extractionMode}.
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <p className="text-sm text-muted-foreground">
                  Popular filters by date, not hour. The worker schedule controls the
                  8:00 AM–6:00 PM operating window.
                </p>
                <Button asChild variant="outline">
                  <Link href={`/admin/bank-connections/${connection.id}/session`}>
                    Renew session
                  </Link>
                </Button>
              </div>

              <p className="rounded-lg border border-border/60 bg-card/60 p-4 text-sm text-muted-foreground">
                Employees may see account {connection.accountNumber} in transaction views, but
                never bank-session controls, balances, credentials, cookies, or MFA prompts.
              </p>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
