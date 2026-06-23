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
import { TriggerScrapeButton } from "../../../components/admin/trigger-scrape-button";
import type { ScrapeRunStatus } from "../../../worker/queues";
import { listScrapeRunsForPage } from "../../api/scrape-runs/defaults";
import { BANKING_TIMEZONE } from "../../../lib/banking-day";
import { bankDisplayName, scrapeRunStatusLabel } from "../../../lib/banks";

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

export default async function AdminScrapeRunsPage() {
  const principal = await getCurrentPrincipal();
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
          eyebrow="Operaciones restringidas"
          title="Acceso administrativo requerido"
          description="Solo los administradores pueden ver la salud de la extracción o gestionar la intervención de MFA/sesión."
        />
        <Card>
          <CardContent className="grid gap-3 p-8 text-center">
            <ShieldAlert className="mx-auto h-8 w-8 text-warning" aria-hidden />
            <p className="text-sm text-muted-foreground">
              Si crees que deberías tener acceso, contacta al propietario del espacio de trabajo y
              solicita el <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">admin</code>{" "}
              rol.
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
  const hasActivePopularRun = runs.some(
    (run) =>
      run.bankId === "popular" && (run.status === "queued" || run.status === "running"),
  );

  return (
    <div className="grid gap-6">
      <PageHeader
        eyebrow="Operaciones administrativas"
        title="Operaciones de extracción"
        description="Monitorea la salud de la ingesta bancaria, revisa resúmenes seguros de fallos y mantiene el trabajo de MFA/sesión restringido a administradores."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1.5">
              <Activity className="h-3 w-3 text-primary" aria-hidden />
              {summary.total} corridas · últimas 24h
            </Badge>
            <TriggerScrapeButton disabled={hasActivePopularRun} />
          </div>
        }
      />

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        aria-label="Resumen de salud de extracción"
      >
        <MetricCard
          label="Corridas totales"
          value={summary.total}
          detail={`${summary.inserted} insertadas`}
          icon={Activity}
          tone="default"
        />
        <MetricCard
          label="Exitosas"
          value={summary.succeeded}
          detail={`${summary.skipped} duplicados omitidos`}
          icon={CheckCircle2}
          tone="success"
        />
        <MetricCard
          label="Necesita acción admin"
          value={summary.needsAdminAction}
          detail="MFA o renovación de sesión"
          icon={AlertTriangle}
          tone="warning"
        />
        <MetricCard
          label="Fallidas"
          value={summary.failed}
          detail="Solo resúmenes seguros"
          icon={ShieldAlert}
          tone="destructive"
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardDescription>Cola de intervención</CardDescription>
                <CardTitle>Intervención administrativa requerida</CardTitle>
              </div>
              {attentionRuns.length > 0 ? (
                <Badge variant="destructive">{attentionRuns.length} pendientes</Badge>
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
                title="Ninguna corrida requiere intervención administrativa actualmente."
                description="Todas las corridas están finalizadas o en cola. El próximo fallo o aviso de MFA aparecerá aquí."
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Lista de recuperación segura</CardDescription>
            <CardTitle>Gestión de MFA / sesión</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="grid list-decimal gap-3 pl-5 text-sm leading-relaxed text-foreground/90">
              <li>Confirma que la alerta no contenga credenciales, cookies ni datos crudos de sesión bancaria.</li>
              <li>Renueva la sesión bancaria usando una estación de trabajo exclusiva para administradores con credenciales autorizadas.</li>
              <li>Reanuda solo después de que un administrador complete la renovación de sesión.</li>
            </ol>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardDescription>Historial de corridas</CardDescription>
              <CardTitle>Corridas recientes de extracción</CardTitle>
            </div>
            <Badge variant="secondary" className="gap-1.5">
              <Clock className="h-3 w-3" aria-hidden />
              Más recientes primero
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
              title="Aún no se registran corridas de extracción"
              description="Cuando se conecte una cuenta bancaria y el planificador esté activo, las corridas aparecerán aquí."
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
                <span className="font-medium text-foreground">{bankDisplayName(run.bankId)}</span>
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
            <RunStat label="Iniciada" value={formatRelative(run.startedAt)} absolute={formatAbsolute(run.startedAt)} />
            <RunStat label="Finalizada" value={formatRelative(run.endedAt)} absolute={formatAbsolute(run.endedAt)} />
            <RunStat
              label="Insertadas"
              value={String(run.insertedCount)}
              mono
              tone={run.status === "succeeded" && run.insertedCount === 0 ? "muted" : "success"}
              note={run.status === "succeeded" && run.insertedCount === 0 ? "Sin transacciones nuevas" : undefined}
            />
            <RunStat
              label="Omitidas"
              value={String(run.skippedCount)}
              mono
              tone="muted"
            />
          </dl>
        </div>
        <div className="border-t border-border/60 bg-muted/20 px-5 py-3">
          <RunActionAffordances runId={run.id} bankId={run.bankId} status={run.status} />
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
  note?: string;
}

function RunStat({ label, value, absolute, mono, tone = "default", note }: RunStatProps) {
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
      {note ? <p className="text-[10px] text-amber-400">{note}</p> : null}
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
        label: scrapeRunStatusLabel(status),
        icon: <CheckCircle2 className="h-3 w-3" aria-hidden />,
      };
    case "failed":
      return {
        variant: "destructive",
        label: scrapeRunStatusLabel(status),
        icon: <ShieldAlert className="h-3 w-3" aria-hidden />,
      };
    case "needs_admin_action":
      return {
        variant: "warning",
        label: scrapeRunStatusLabel(status),
        icon: <AlertTriangle className="h-3 w-3" aria-hidden />,
      };
    case "running":
      return {
        variant: "secondary",
        label: scrapeRunStatusLabel(status),
        icon: <Activity className="h-3 w-3 animate-pulse" aria-hidden />,
      };
    case "queued":
    default:
      return {
        variant: "outline",
        label: scrapeRunStatusLabel(status),
        icon: <Clock className="h-3 w-3" aria-hidden />,
      };
  }
}

function formatAbsolute(value: string | null): string {
  if (!value) return "Sin registrar";
  return new Intl.DateTimeFormat("es-DO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: BANKING_TIMEZONE,
  }).format(new Date(value));
}

function formatRelative(value: string | null): string {
  if (!value) return "Sin registrar";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = date.getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  if (Math.abs(diffMin) < 60) return new Intl.RelativeTimeFormat("es-DO", { numeric: "auto" }).format(diffMin, "minute");
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) return new Intl.RelativeTimeFormat("es-DO", { numeric: "auto" }).format(diffHour, "hour");
  const diffDay = Math.round(diffHour / 24);
  return new Intl.RelativeTimeFormat("es-DO", { numeric: "auto" }).format(diffDay, "day");
}
