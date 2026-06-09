import { headers } from "next/headers";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { resolvePrincipalFromTrustedHeaders } from "../../../../modules/auth";
import { Badge } from "../../../../components/ui/badge";
import { Button } from "../../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../../components/ui/card";
import { PageHeader } from "../../../../components/ui/page-header";
import { AdminAccessRequiredBanking, canManageBanking, type Principal } from "../_components";
import { popularBankConnection } from "../page";

export default async function NewBankConnectionPage() {
  const principal = resolvePrincipalFromTrustedHeaders(await headers());

  return <NewBankConnectionShell principal={principal} />;
}

export function NewBankConnectionShell({ principal }: { principal: Principal | null }) {
  if (!canManageBanking(principal)) {
    return <AdminAccessRequiredBanking />;
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Admin bank operations"
        title="New bank connection"
        description="Create the first Banco Popular connection reference before opening a controlled session."
        actions={<Badge variant="outline">Popular first</Badge>}
      />

      <Card>
        <CardHeader>
          <CardTitle>Banco Popular</CardTitle>
          <CardDescription>
            Configure account {popularBankConnection.accountNumber} as a read-only scraping target.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Account {popularBankConnection.accountType} · {popularBankConnection.accountNumber}.
            Search mode: {popularBankConnection.extractionMode}. Worker: Local server first,
            VPS later.
          </p>

          <p className="rounded-lg border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
            This shell records the product contract only. Credentials are entered later in the
            controlled bank-session flow and are never stored in plain text.
          </p>

          <Button asChild className="w-fit">
            <Link href={`/admin/bank-connections/${popularBankConnection.id}/session`}>
              Continue to session setup
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
