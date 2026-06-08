import { ScrollText, ShieldCheck } from "lucide-react";

import { PageHeader } from "../../../components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";

export const metadata = {
  title: "Audit log · RD-Sync",
  description: "Append-only audit trail of access and review actions.",
};

/**
 * Audit log placeholder (REQ-AUD-UX-001).
 *
 * The data feed for this view lands in a follow-up change that wires
 * `InMemoryAuditSink.list()` into a paginated table. For this change the
 * page exists with the new design system in place so the admin nav can
 * reach it and the empty state is honest.
 */
export default function AdminAuditPage() {
  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Admin operations"
        title="Audit log"
        description="Append-only record of access, review, and ingestion events. Sensitive metadata is redacted before persistence."
        actions={
          <Badge variant="outline" className="gap-1.5">
            <ShieldCheck className="h-3 w-3 text-primary" aria-hidden />
            Append-only
          </Badge>
        }
      />

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/30">
              <ScrollText className="h-5 w-5" aria-hidden />
            </div>
            <div className="grid gap-1">
              <CardTitle>No events yet</CardTitle>
              <CardDescription>
                The audit log surface is reachable today; the data feed will be wired in a
                follow-up change.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm text-muted-foreground">
          <p>
            Visit again after the first review-state change or ingestion run. Events are
            redacted at write time: tokens, passwords, cookies, account numbers, and
            screenshots are never persisted.
          </p>
          <ul className="grid list-disc gap-1.5 pl-5 text-foreground/80">
            <li>User logins and role changes</li>
            <li>Transaction views and review-state transitions</li>
            <li>Bank connection lifecycle (create, edit, disable, renew)</li>
            <li>Scraping start, success, failure, MFA prompts</li>
            <li>Access denials and audit-log reads</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
