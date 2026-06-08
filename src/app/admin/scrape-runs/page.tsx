import { headers } from "next/headers";

import {
  assertCanAccessBankSession,
  resolvePrincipalFromTrustedHeaders,
  type Principal,
} from "../../../modules/auth";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { PageHeader } from "../../../components/ui/page-header";
import { RunActionAffordances } from "../../../components/admin/run-action-affordances";
import type { ScrapeRunStatus } from "../../../worker/queues";

export interface AdminScrapeRun {
  id: string;
  bankId: string;
  status: ScrapeRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  insertedCount: number;
  skippedCount: number;
  safeErrorSummary: string | null;
}

interface AdminScrapeRunsDashboardProps {
  principal: Principal | null;
  runs: readonly AdminScrapeRun[];
}

interface AdminScrapeRunsPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

const previewRuns: AdminScrapeRun[] = [
  {
    id: "preview-run-1",
    bankId: "popular",
    status: "needs_admin_action",
    startedAt: "2026-06-07T13:45:00.000Z",
    endedAt: "2026-06-07T13:46:00.000Z",
    insertedCount: 0,
    skippedCount: 0,
    safeErrorSummary: "Bank session requires admin MFA action",
  },
  {
    id: "preview-run-2",
    bankId: "banreservas",
    status: "succeeded",
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:02:00.000Z",
    insertedCount: 12,
    skippedCount: 3,
    safeErrorSummary: null,
  },
  {
    id: "preview-run-3",
    bankId: "bhd",
    status: "failed",
    startedAt: "2026-06-07T11:00:00.000Z",
    endedAt: "2026-06-07T11:01:00.000Z",
    insertedCount: 0,
    skippedCount: 0,
    safeErrorSummary: "Transaction table selector missing",
  },
];

export default async function AdminScrapeRunsPage({ searchParams }: AdminScrapeRunsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const principal = resolvePreviewPrincipal(resolvedSearchParams) ?? resolvePrincipalFromTrustedHeaders(await headers());

  return <AdminScrapeRunsDashboard principal={principal} runs={previewRuns} />;
}

export function AdminScrapeRunsDashboard({ principal, runs }: AdminScrapeRunsDashboardProps) {
  try {
    assertCanAccessBankSession(principal);
  } catch {
    return (
      <main className="mx-auto grid min-h-screen max-w-3xl gap-4 px-6 py-12">
        <PageHeader
          eyebrow="Restricted operations"
          title="Admin access required"
          description="Only admins can view scraping health or handle MFA/session intervention."
        />
      </main>
    );
  }

  const summary = summarizeScrapeRuns(runs);
  const attentionRuns = runs.filter(
    (run) => run.status === "needs_admin_action" || run.status === "failed",
  );

  return (
    <main className="mx-auto grid min-h-screen max-w-6xl gap-6 px-6 py-12">
      <PageHeader
        eyebrow="Admin operations"
        title="Scrape run operations"
        description="Monitor bank ingestion health, review safe failure summaries, and keep MFA/session work restricted to admins."
      />

      <section
        className="grid gap-4 sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]"
        aria-label="Scrape run health summary"
      >
        <MetricCard label="Total runs" value={summary.total} detail={`${summary.inserted} inserted`} />
        <MetricCard
          label="Successful runs"
          value={summary.succeeded}
          detail={`${summary.skipped} skipped duplicates`}
        />
        <MetricCard
          label="Runs needing admin action"
          value={summary.needsAdminAction}
          detail="MFA or session renewal"
        />
        <MetricCard label="Failed runs" value={summary.failed} detail="Safe summaries only" />
      </section>

      <section
        className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(18rem,0.7fr)]"
        aria-label="Scraping operations details"
      >
        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">Intervention queue</p>
            <CardTitle>Admin intervention required</CardTitle>
          </CardHeader>
          <CardContent>
            {attentionRuns.length > 0 ? (
              <div className="grid gap-4">
                {attentionRuns.map((run) => (
                  <ScrapeRunCard key={run.id} run={run} />
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-border bg-card/50 p-4 text-sm text-muted-foreground">
                No scrape runs currently require admin intervention.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <p className="text-sm text-muted-foreground">Safe recovery checklist</p>
            <CardTitle>MFA/session handling</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="grid list-decimal gap-3 pl-5 leading-relaxed text-card-foreground">
              <li>Confirm the alert contains no credentials, cookies, or raw bank session data.</li>
              <li>Renew the bank session using an admin-only workstation and authorized credentials.</li>
              <li>Resume only after session renewal is completed by an admin.</li>
            </ol>
          </CardContent>
        </Card>
      </section>

      <Card aria-label="Recent scrape run history">
        <CardHeader>
          <p className="text-sm text-muted-foreground">Run history</p>
          <CardTitle>Recent scrape runs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            {runs.map((run) => (
              <ScrapeRunCard key={run.id} run={run} />
            ))}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

export function summarizeScrapeRuns(runs: readonly AdminScrapeRun[]) {
  return runs.reduce(
    (summary, run) => ({
      total: summary.total + 1,
      succeeded: summary.succeeded + (run.status === "succeeded" ? 1 : 0),
      failed: summary.failed + (run.status === "failed" ? 1 : 0),
      needsAdminAction: summary.needsAdminAction + (run.status === "needs_admin_action" ? 1 : 0),
      inserted: summary.inserted + run.insertedCount,
      skipped: summary.skipped + run.skippedCount,
    }),
    { total: 0, succeeded: 0, failed: 0, needsAdminAction: 0, inserted: 0, skipped: 0 },
  );
}

function MetricCard({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <Card>
      <CardContent className="grid gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        <strong className="text-2xl leading-none text-foreground">{value}</strong>
        <span className="text-sm text-muted-foreground">{detail}</span>
      </CardContent>
    </Card>
  );
}

function ScrapeRunCard({ run }: { run: AdminScrapeRun }) {
  return (
    <Card>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">{formatBankName(run.bankId)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">{formatRunStatus(run.status)}</h3>
            <RunStatusBadge status={run.status} />
          </div>
          <p className="text-sm text-card-foreground">
            {run.safeErrorSummary ?? "No safe failure summary recorded."}
          </p>
        </div>
        <dl className="m-0 grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
          <div>
            <dt className="text-xs text-muted-foreground">Started</dt>
            <dd className="mt-1 text-sm text-foreground">{formatDateTime(run.startedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Ended</dt>
            <dd className="mt-1 text-sm text-foreground">{formatDateTime(run.endedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Transactions</dt>
            <dd className="mt-1 text-sm text-foreground">
              {run.insertedCount} inserted / {run.skippedCount} skipped
            </dd>
          </div>
        </dl>
        <RunActionAffordances runId={run.id} status={run.status} />
      </CardContent>
    </Card>
  );
}

function RunStatusBadge({ status }: { status: ScrapeRunStatus }) {
  const variant = statusToBadgeVariant(status);
  return <Badge variant={variant}>{formatRunStatus(status)}</Badge>;
}

function statusToBadgeVariant(status: ScrapeRunStatus) {
  switch (status) {
    case "succeeded":
      return "success" as const;
    case "failed":
    case "needs_admin_action":
      return "destructive" as const;
    case "running":
      return "warning" as const;
    case "queued":
    default:
      return "secondary" as const;
  }
}

function formatBankName(bankId: string): string {
  const names: Record<string, string> = {
    banreservas: "Banreservas",
    bhd: "BHD",
    popular: "Banco Popular",
  };

  return names[bankId] ?? bankId;
}

function formatRunStatus(status: ScrapeRunStatus): string {
  const labels: Record<ScrapeRunStatus, string> = {
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    needs_admin_action: "Needs admin action",
  };

  return labels[status];
}

function formatDateTime(value: string | null): string {
  if (!value) return "Not recorded";

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function resolvePreviewPrincipal(
  searchParams: Record<string, string | string[] | undefined>,
): Principal | null {
  if (process.env.RD_SYNC_DEV_PREVIEW !== "enabled") {
    return null;
  }

  return firstValue(searchParams.previewRole) === "admin"
    ? { id: "admin-preview", role: "admin" }
    : null;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
