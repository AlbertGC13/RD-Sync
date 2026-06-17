import { redirect } from "next/navigation";
import { ScrollText, ShieldAlert, ShieldCheck } from "lucide-react";

import { getCurrentPrincipal } from "../../../modules/auth/server";
import { defaultAuditSink } from "../../api/audit/defaults";
import { PageHeader } from "../../../components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { EmptyState } from "../../../components/ui/empty-state";

export const metadata = {
  title: "Audit log · RD-Sync",
  description: "Append-only audit trail of access and review actions.",
};

const PAGE_SIZE = 50;

interface AdminAuditPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminAuditPage({ searchParams }: AdminAuditPageProps) {
  // Defense-in-depth: admin layout already gates this route, but we verify here too.
  const principal = await getCurrentPrincipal();

  // Unauthenticated: redirect to login (matches what admin/layout.tsx does).
  if (!principal) {
    redirect("/login");
  }

  // Authenticated but not admin: show inline denial card.
  if (principal.role !== "admin") {
    return (
      <div className="grid gap-6">
        <PageHeader
          eyebrow="Restricted operations"
          title="Admin access required"
          description="Only admins can view the audit log."
        />
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            <ShieldAlert className="mx-auto h-8 w-8 text-warning" aria-hidden />
            <p className="text-sm text-muted-foreground">
              If you believe you should have access, contact the workspace owner and ask for
              the{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">admin</code>{" "}
              role.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const resolvedSearchParams = searchParams ? await searchParams : {};
  const rawPage = resolvedSearchParams["page"];
  const pageParam = Array.isArray(rawPage) ? rawPage[0] : rawPage;
  const parsedPage = parseInt(pageParam ?? "1", 10);
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? parsedPage : 1;

  // Fetch one extra row so we can detect whether a next page exists without a
  // separate count query. We display only the first PAGE_SIZE rows.
  const rawEvents = await defaultAuditSink.list({
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });

  const hasNext = rawEvents.length > PAGE_SIZE;
  const events = hasNext ? rawEvents.slice(0, PAGE_SIZE) : rawEvents;
  const hasPrev = page > 1;

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
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/30">
                <ScrollText className="h-5 w-5" aria-hidden />
              </div>
              <div className="grid gap-1">
                <CardTitle>Audit events</CardTitle>
                <CardDescription>
                  Newest-first · page {page}
                  {events.length === 0 && page === 1 ? " · no events yet" : ""}
                </CardDescription>
              </div>
            </div>
            <Badge variant="secondary" className="gap-1.5 self-start">
              {events.length} on this page
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <EmptyState
              icon={<ScrollText className="h-6 w-6" aria-hidden />}
              title="No audit events recorded yet"
              description="Events will appear here after the first login, ingestion run, or review action."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-4 whitespace-nowrap">Timestamp (UTC)</th>
                    <th className="py-2 pr-4 whitespace-nowrap">Actor</th>
                    <th className="py-2 pr-4 whitespace-nowrap">Role</th>
                    <th className="py-2 pr-4 whitespace-nowrap">Action</th>
                    <th className="py-2 pr-4 whitespace-nowrap">Target</th>
                    <th className="py-2 pr-4 whitespace-nowrap">Target ID</th>
                    <th className="py-2">Metadata</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {events.map((event) => {
                    const metaStr = event.metadata
                      ? JSON.stringify(event.metadata)
                      : "—";
                    const metaTruncated =
                      metaStr.length > 120 ? `${metaStr.slice(0, 120)}…` : metaStr;
                    return (
                      <tr
                        key={event.id}
                        className="text-foreground/90 hover:bg-muted/30 transition-colors"
                      >
                        <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap text-muted-foreground">
                          {event.createdAt.toISOString()}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {event.actorId ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          {event.actorRole ? (
                            <Badge variant="outline" className="text-xs">
                              {event.actorRole}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                          {event.action}
                        </td>
                        <td className="py-2 pr-4 text-xs">{event.target}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                          {event.targetId ?? "—"}
                        </td>
                        <td
                          className="py-2 font-mono text-xs text-muted-foreground max-w-xs truncate"
                          title={metaStr === "—" ? undefined : metaStr}
                        >
                          {metaTruncated}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {(hasPrev || hasNext) && (
            <nav
              className="mt-4 flex items-center justify-between border-t border-border/60 pt-4"
              aria-label="Audit log pagination"
            >
              <div>
                {hasPrev ? (
                  <a
                    href={`?page=${page - 1}`}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted/40 transition-colors"
                  >
                    ← Previous
                  </a>
                ) : (
                  <span aria-hidden className="invisible rounded-md border border-border px-3 py-1.5 text-sm font-medium">
                    ← Previous
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">Page {page}</span>
              <div>
                {hasNext ? (
                  <a
                    href={`?page=${page + 1}`}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted/40 transition-colors"
                  >
                    Next →
                  </a>
                ) : (
                  <span aria-hidden className="invisible rounded-md border border-border px-3 py-1.5 text-sm font-medium">
                    Next →
                  </span>
                )}
              </div>
            </nav>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
