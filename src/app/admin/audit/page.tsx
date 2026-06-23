import { redirect } from "next/navigation";
import Link from "next/link";
import { ScrollText, ShieldAlert, ShieldCheck } from "lucide-react";

import { getCurrentPrincipal } from "../../../modules/auth/server";
import type { Principal } from "../../../modules/auth";
import type { AuditEvent } from "../../../modules/audit";
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

  return (
    <AdminAuditDashboard principal={principal} events={events} page={page} hasNext={hasNext} />
  );
}

interface AdminAuditDashboardProps {
  principal: Principal | null;
  events: readonly AuditEvent[];
  page: number;
  hasNext: boolean;
}

/**
 * Standalone dashboard shell preserved for unit testing without the
 * server-side `headers()`/`cookies()` call — mirrors the pattern used by the
 * scrape-runs and transactions pages.
 */
export function AdminAuditDashboard({ principal, events, page, hasNext }: AdminAuditDashboardProps) {
  // Authenticated but not admin: show inline denial card.
  if (!principal || principal.role !== "admin") {
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
          {/* aria-live so assistive tech announces page changes. */}
          <div aria-live="polite">
            {events.length === 0 ? (
              <EmptyState
                icon={<ScrollText className="h-6 w-6" aria-hidden />}
                title="No audit events recorded yet"
                description="Events will appear here after the first login, ingestion run, or review action."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Registro de auditoría: eventos de acceso, revisión e ingesta, ordenados del
                    más reciente al más antiguo.
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <th scope="col" className="py-2 pr-4 whitespace-nowrap">
                        Timestamp (UTC)
                      </th>
                      <th scope="col" className="py-2 pr-4 whitespace-nowrap">
                        Actor
                      </th>
                      <th scope="col" className="py-2 pr-4 whitespace-nowrap">
                        Action
                      </th>
                      <th scope="col" className="py-2 pr-4 whitespace-nowrap">
                        Target
                      </th>
                      <th scope="col" className="py-2 pr-4 whitespace-nowrap">
                        Target ID
                      </th>
                      <th scope="col" className="py-2">
                        Metadata
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {events.map((event) => (
                      <tr
                        key={event.id}
                        className="text-foreground/90 hover:bg-muted/30 transition-colors"
                      >
                        <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap text-muted-foreground">
                          {event.createdAt.toISOString()}
                        </td>
                        <td className="py-2 pr-4">
                          <ActorCell actorId={event.actorId} actorRole={event.actorRole} />
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                          {event.action}
                        </td>
                        <td className="py-2 pr-4 text-xs">{event.target}</td>
                        <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                          {event.targetId ?? "—"}
                        </td>
                        <td className="py-2">
                          <AuditMetadataCell metadata={event.metadata} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {(hasPrev || hasNext) && (
            <nav
              className="mt-4 flex items-center justify-between border-t border-border/60 pt-4"
              aria-label="Paginación de auditoría"
            >
              <div>
                {hasPrev ? (
                  <Link
                    href={`?page=${page - 1}`}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted/40 transition-colors"
                    aria-label="Página anterior"
                  >
                    ← Anterior
                  </Link>
                ) : (
                  <span
                    aria-hidden
                    className="invisible rounded-md border border-border px-3 py-1.5 text-sm font-medium"
                  >
                    ← Anterior
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground" aria-current="page">
                Página {page}
              </span>
              <div>
                {hasNext ? (
                  <Link
                    href={`?page=${page + 1}`}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted/40 transition-colors"
                    aria-label="Página siguiente"
                  >
                    Siguiente →
                  </Link>
                ) : (
                  <span
                    aria-hidden
                    className="invisible rounded-md border border-border px-3 py-1.5 text-sm font-medium"
                  >
                    Siguiente →
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

/**
 * Operator-facing Spanish labels for audit actor roles. The raw role enum
 * (e.g. `admin`, `viewer`, `system`) is never shown to operators — it is
 * mapped to a human-readable label here. System-initiated events (null role)
 * are labelled "Sistema".
 */
const ACTOR_ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  reviewer: "Revisor",
  viewer: "Empleado",
  system: "Sistema",
};

function actorLabel(actorRole: string | null): string {
  if (!actorRole) return "Sistema";
  // Never surface the raw enum to operators — fall back to a safe Spanish
  // label for any unmapped role. The full actor id remains in aria-label for
  // traceability.
  return ACTOR_ROLE_LABELS[actorRole] ?? "Desconocido";
}

/**
 * Shortens an actor identifier for display, appending an ellipsis only when it
 * was actually truncated. The full identifier is preserved in the element's
 * `aria-label` so screen readers announce it in full.
 */
function shortenId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function ActorCell({ actorId, actorRole }: { actorId: string | null; actorRole: string | null }) {
  const label = actorLabel(actorRole);
  if (!actorId) {
    return <span className="text-xs">{label}</span>;
  }
  return (
    <span className="text-xs" aria-label={`${label}, identificador ${actorId}`}>
      {label} · {shortenId(actorId)}
    </span>
  );
}

/**
 * Renders audit metadata as an accessible disclosure — never as raw JSON.
 *
 * - Empty/null metadata → em dash.
 * - Non-empty metadata → a `<details>` summarising "N propiedades" that expands
 *   to a definition list of key/value pairs. Complex values (objects/arrays)
 *   are described by shape rather than serialised, so no raw JSON reaches the
 *   operator. The `<details>`/`<summary>` element is keyboard- and
 *   touch-accessible, replacing the previous inaccessible `title` tooltip.
 */
function AuditMetadataCell({ metadata }: { metadata: Record<string, unknown> | null }) {
  if (!metadata) {
    return <span className="text-muted-foreground">—</span>;
  }
  const entries = Object.entries(metadata);
  if (entries.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const count = entries.length;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground">
        {count} {count === 1 ? "propiedad" : "propiedades"}
      </summary>
      <dl className="mt-1 grid gap-0.5 pl-2">
        {entries.map(([key, value]) => (
          <div key={key} className="grid grid-cols-[auto_1fr] gap-x-2">
            <dt className="font-medium text-foreground/80">{key}:</dt>
            <dd className="text-muted-foreground">{formatMetadataValue(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function formatMetadataValue(value: unknown): string {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `arreglo (${value.length})`;
  if (typeof value === "object") return "objeto";
  return String(value);
}
