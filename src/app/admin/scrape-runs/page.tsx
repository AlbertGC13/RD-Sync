import {
  Activity,
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Clock,
  Inbox,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import {
  assertCanAccessBankSession,
  type Principal,
} from "../../../modules/auth";
import { getCurrentPrincipal } from "../../../modules/auth/server";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { PageHeader } from "../../../components/ui/page-header";
import { EmptyState } from "../../../components/ui/empty-state";
import { RunActionAffordances } from "../../../components/admin/run-action-affordances";
import type { ScrapeRunStatus } from "../../../worker/queues";
import { listScrapeRunsForPage } from "../../api/scrape-runs/defaults";

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

export default async function AdminScrapeRunsPage({ searchParams }: AdminScrapeRunsPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const principal =
    resolvePreviewPrincipal(resolvedSearchParams) ??
    await getCurrentPrincipal();
  const runs = await listScrapeRunsForPage({});

  return <AdminScrapeRunsDashboard principal={principal} runs={runs} />;
}

export function AdminScrapeRunsDashboard({ principal, runs }: AdminScrapeRunsDashboardProps) {
  try {
    assertCanAccessBankSession(principal);
  } catch {
    return (
      <div className="grid gap-6">
        <PageHeader
          eyebrow="Restricted operations"
          title="Admin access required"
          description="Only admins can view scraping health or handle MFA/session intervention."
        />
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            <ShieldAlert className="mx-auto h-8 w-8 text-warning" aria-hidden />
            <p className="text-sm text-muted-foreground">
              If you believe you should have access, contact the workspace owner and ask for
              the <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">admin</code>{" "}
              role.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const summary = summarizeScrapeRuns(runs);
  const attentionRuns = runs.filter(
    (run) => run.status === "needs_admin_action" || run.status === "failed",
  );

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Admin operations"
        title="Scrape run operations"
        description="Monitor bank ingestion health, review safe failure summaries, and keep MFA/session work restricted to admins."
        actions={
          <Badge variant="outline" className="gap-1.5">
            <Activity className="h-3 w-3 text-primary" aria-hidden />
            {summary.total} runs · last 24h
          </Badge>
        }
      />

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Scrape run health summary"
      >
        <MetricCard
          label="Total runs"
          value={summary.total}
          detail={`${summary.inserted} inserted`}
          icon={Activity}
          tone="default"
        />
        <MetricCard
          label="Successful"
          value={summary.succeeded}
          detail={`${summary.skipped} skipped duplicates`}
          icon={CheckCircle2}
          tone="success"
        />
        <MetricCard
          label="Needs admin action"
          value={summary.needsAdminAction}
          detail="MFA or session renewal"
          icon={AlertTriangle}
          tone="warning"
        />
        <MetricCard
          label="Failed"
          value={summary.failed}
          detail="Safe summaries only"
          icon={ShieldAlert}
          tone="destructive"
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardDescription>Intervention queue</CardDescription>
                <CardTitle>Admin intervention required</CardTitle>
              </div>
              {attentionRuns.length > 0 ? (
                <Badge variant="destructive">{attentionRuns.length} pending</Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {attentionRuns.length > 0 ? (
              <div className="grid gap-3">
                {attentionRuns.map((run) => (
                  <ScrapeRunCard key={run.id} run={run} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<CheckCircle2 className="h-6 w-6 text-success" aria-hidden />}
                title="No scrape runs currently require admin intervention."
                description="All runs are succeeding or in queue. The next failure or MFA prompt will appear here."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Safe recovery checklist</CardDescription>
            <CardTitle>MFA / session handling</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="grid list-decimal gap-3 pl-5 text-sm leading-relaxed text-foreground/90">
              <li>Confirm the alert contains no credentials, cookies, or raw bank session data.</li>
              <li>Renew the bank session using an admin-only workstation and authorized credentials.</li>
              <li>Resume only after session renewal is completed by an admin.</li>
            </ol>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardDescription>Run history</CardDescription>
              <CardTitle>Recent scrape runs</CardTitle>
            </div>
            <Badge variant="secondary" className="gap-1.5">
              <Clock className="h-3 w-3" aria-hidden />
              Newest first
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {runs.length > 0 ? (
            <div className="grid gap-3">
              {runs.map((run) => (
                <ScrapeRunCard key={run.id} run={run} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Inbox className="h-6 w-6" aria-hidden />}
              title="No scrape runs recorded yet"
              description="Once a bank connection is wired and the scheduler is on, runs will appear here."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function summarizeScrapeRuns(runs: readonly AdminScrapeRun[]) {
  return runs.reduce(
    (summary, run) => ({
      total: summary.total + 1,
      succeeded: summary.succeeded + (run.status === "succeeded" ? 1 : 0),
      failed: summary.failed + (run.status === "failed" ? 1 : 0),
      needsAdminAction:
        summary.needsAdminAction + (run.status === "needs_admin_action" ? 1 : 0),
      inserted: summary.inserted + run.insertedCount,
      skipped: summary.skipped + run.skippedCount,
    }),
    { total: 0, succeeded: 0, failed: 0, needsAdminAction: 0, inserted: 0, skipped: 0 },
  );
}

interface MetricCardProps {
  label: string;
  value: number;
  detail: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  tone: "default" | "success" | "warning" | "destructive";
}

function MetricCard({ label, value, detail, icon: Icon, tone }: MetricCardProps) {
  const toneClasses = {
    default: "text-foreground",
    success: "text-emerald-300",
    warning: "text-amber-300",
    destructive: "text-rose-300",
  } as const;
  const TrendIcon =
    tone === "success" ? TrendingUp : tone === "destructive" ? TrendingDown : Icon;

  return (
    <Card>
      <CardContent className="grid gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <span className={`rounded-md bg-muted/40 p-1.5 ${toneClasses[tone]}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <strong className="font-mono text-3xl font-semibold tabular-nums tracking-tight text-foreground">
            {value}
          </strong>
          <TrendIcon
            className={`h-4 w-4 ${toneClasses[tone]}`}
            aria-hidden
          />
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function ScrapeRunCard({ run }: { run: AdminScrapeRun }) {
  const statusVisual = statusToBadge(run.status);
  return (
    <Card className="overflow-hidden">
      <CardContent className="grid gap-4 p-0">
        <div className="grid gap-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Banknote className="h-3.5 w-3.5" aria-hidden />
                <span className="font-medium text-foreground">{formatBankName(run.bankId)}</span>
                <span aria-hidden>·</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                  {run.id}
                </code>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusVisual.variant} className="gap-1">
                  {statusVisual.icon}
                  {statusVisual.label}
                </Badge>
                {run.safeErrorSummary ? (
                  <span className="text-xs text-muted-foreground">{run.safeErrorSummary}</span>
                ) : null}
              </div>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <RunStat label="Started" value={formatRelative(run.startedAt)} absolute={formatAbsolute(run.startedAt)} />
            <RunStat label="Ended" value={formatRelative(run.endedAt)} absolute={formatAbsolute(run.endedAt)} />
            <RunStat
              label="Inserted"
              value={String(run.insertedCount)}
              mono
              tone="success"
            />
            <RunStat
              label="Skipped"
              value={String(run.skippedCount)}
              mono
              tone="muted"
            />
          </dl>
        </div>
        <div className="border-t border-border/60 bg-muted/20 px-5 py-3">
          <RunActionAffordances runId={run.id} status={run.status} />
        </div>
      </CardContent>
    </Card>
  );
}

interface RunStatProps {
  label: string;
  value: string;
  absolute?: string;
  mono?: boolean;
  tone?: "default" | "muted" | "success";
}

function RunStat({ label, value, absolute, mono, tone = "default" }: RunStatProps) {
  const toneClass =
    tone === "muted"
      ? "text-muted-foreground"
      : tone === "success"
        ? "text-emerald-300"
        : "text-foreground";
  return (
    <div className="grid gap-0.5">
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`${mono ? "font-mono tabular-nums" : ""} text-sm font-medium ${toneClass}`}
        title={absolute}
      >
        {value}
      </dd>
    </div>
  );
}

function statusToBadge(status: ScrapeRunStatus): {
  variant: "default" | "secondary" | "destructive" | "success" | "warning" | "outline";
  label: string;
  icon: React.ReactNode;
} {
  switch (status) {
    case "succeeded":
      return {
        variant: "success",
        label: "Succeeded",
        icon: <CheckCircle2 className="h-3 w-3" aria-hidden />,
      };
    case "failed":
      return {
        variant: "destructive",
        label: "Failed",
        icon: <ShieldAlert className="h-3 w-3" aria-hidden />,
      };
    case "needs_admin_action":
      return {
        variant: "warning",
        label: "Needs admin action",
        icon: <AlertTriangle className="h-3 w-3" aria-hidden />,
      };
    case "running":
      return {
        variant: "secondary",
        label: "Running",
        icon: <Activity className="h-3 w-3 animate-pulse" aria-hidden />,
      };
    case "queued":
    default:
      return {
        variant: "outline",
        label: "Queued",
        icon: <Clock className="h-3 w-3" aria-hidden />,
      };
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

function formatAbsolute(value: string | null): string {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatRelative(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = date.getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  if (Math.abs(diffMin) < 60) return new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(diffMin, "minute");
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(diffHour, "hour");
  const diffDay = Math.round(diffHour / 24);
  return new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(diffDay, "day");
}

export function resolvePreviewPrincipal(
  searchParams: Record<string, string | string[] | undefined>,
): Principal | null {
  if (process.env.NODE_ENV === "production" || process.env.RD_SYNC_DEV_PREVIEW !== "enabled") {
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
