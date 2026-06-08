import { PageHeader } from "../../../components/ui/page-header";
import { Card, CardContent } from "../../../components/ui/card";

export const metadata = {
  title: "Audit log · RD-Sync",
  description: "Append-only audit trail of access and review actions.",
};

/**
 * Audit log placeholder (REQ-AUD-UX-001).
 *
 * The data feed for this view lands in a follow-up change that wires
 * `InMemoryAuditSink.list()` (already part of the access-control spec) into
 * a paginated table. For this change the page exists with the new design
 * system in place so the admin nav can reach it and the empty state is
 * honest.
 */
export default function AdminAuditPage() {
  return (
    <main className="mx-auto grid min-h-screen max-w-4xl gap-6 px-6 py-12">
      <PageHeader
        eyebrow="Admin operations"
        title="Audit log"
        description="Append-only record of access, review, and ingestion events. Sensitive metadata is redacted before persistence."
      />
      <Card>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <p>No events yet.</p>
          <p>
            The audit log surface is reachable today; the data feed will be wired in a
            follow-up change. Visit again after the first review-state change or
            ingestion run.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
