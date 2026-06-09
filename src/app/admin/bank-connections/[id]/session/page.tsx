import { headers } from "next/headers";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";

import { resolvePrincipalFromTrustedHeaders } from "../../../../../modules/auth";
import { Badge } from "../../../../../components/ui/badge";
import { Button } from "../../../../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AdminAccessRequiredBanking, canManageBanking, type Principal } from "../../_components";
import { popularBankConnection } from "../../page";

interface BankConnectionSessionPageProps {
  params: Promise<{ id: string }>;
}

export default async function BankConnectionSessionPage({
  params,
}: BankConnectionSessionPageProps) {
  const [{ id }, principal] = await Promise.all([
    params,
    headers().then(resolvePrincipalFromTrustedHeaders),
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
        eyebrow="Admin bank operations"
        title="Popular session setup"
        description="Renew or establish the controlled browser session for Banco Popular without exposing the bank portal to employees."
        actions={
          <Badge variant="warning" className="gap-1.5">
            <TriangleAlert className="h-3 w-3" aria-hidden />
            needs_admin_action
          </Badge>
        }
      />

      <Card>
        <CardHeader>
          <CardDescription>Connection</CardDescription>
          <CardTitle>
            {connection.bankName} · {connection.accountNumber}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm text-muted-foreground">
          <section className="grid gap-2 rounded-lg border border-border/60 bg-card/60 p-4">
            <h2 className="text-sm font-semibold text-foreground">Token entry is admin-only</h2>
            <p>
              If Popular asks for a cellphone token, the run pauses and an authorized admin or
              session operator handles it.
            </p>
            <h2 className="text-sm font-semibold text-foreground">Physical token device</h2>
            <p>
              The local-server browser may reuse trusted cookies, but new-device authorization
              still requires the physical device.
            </p>
          </section>

          <p className="rounded-lg border border-border/60 bg-muted/20 p-4">
            Session renewal is intentionally a shell in this PR. The next slice will wire the
            controlled browser flow; until then, scrape runs remain in{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              needs_admin_action
            </code>{" "}
            when Popular asks for authorization.
          </p>

          <p>
            Employee viewers never receive bank-session controls, cookies, credentials, token
            prompts, or balance data.
          </p>

          <Button asChild variant="outline" className="w-fit">
            <Link href="/admin/bank-connections">Back to connections</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
