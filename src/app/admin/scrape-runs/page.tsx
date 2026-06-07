import { headers } from "next/headers";

import { assertCanAccessBankSession, resolvePrincipalFromTrustedHeaders, type Principal } from "../../../modules/auth";
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
];

export default async function AdminScrapeRunsPage() {
  const principal = resolvePrincipalFromTrustedHeaders(await headers());

  return <AdminScrapeRunsDashboard principal={principal} runs={previewRuns} />;
}

export function AdminScrapeRunsDashboard({ principal, runs }: AdminScrapeRunsDashboardProps) {
  try {
    assertCanAccessBankSession(principal);
  } catch {
    return (
      <main className="dashboard-shell admin-ops-shell">
        <section className="access-denied" role="alert" aria-labelledby="admin-access-required-title">
          <p className="eyebrow">Restricted operations</p>
          <h1 id="admin-access-required-title">Admin access required</h1>
          <p className="lede">
            Only admins can view scraping health or handle MFA/session intervention.
          </p>
        </section>
      </main>
    );
  }

  const summary = summarizeScrapeRuns(runs);
  const attentionRuns = runs.filter((run) => run.status === "needs_admin_action" || run.status === "failed");

  return (
    <main className="dashboard-shell admin-ops-shell">
      <header className="dashboard-header">
        <p className="eyebrow">Admin operations</p>
        <h1>Scrape run operations</h1>
        <p className="lede">
          Monitor bank ingestion health, review safe failure summaries, and keep MFA/session work restricted to admins.
        </p>
      </header>

      <section className="admin-metrics" aria-label="Scrape run health summary">
        <MetricCard label="Total runs" value={summary.total} detail={`${summary.inserted} inserted`} />
        <MetricCard label="Successful runs" value={summary.succeeded} detail={`${summary.skipped} skipped duplicates`} />
        <MetricCard label="Runs needing admin action" value={summary.needsAdminAction} detail="MFA or session renewal" />
        <MetricCard label="Failed runs" value={summary.failed} detail="Safe summaries only" />
      </section>

      <section className="ops-grid" aria-label="Scraping operations details">
        <article className="ops-card">
          <div>
            <p className="card-kicker">Intervention queue</p>
            <h2>Admin intervention required</h2>
          </div>
          {attentionRuns.length > 0 ? (
            <div className="run-list">
              {attentionRuns.map((run) => (
                <ScrapeRunCard key={run.id} run={run} />
              ))}
            </div>
          ) : (
            <p className="empty-state">No scrape runs currently require admin intervention.</p>
          )}
        </article>

        <article className="ops-card">
          <div>
            <p className="card-kicker">Safe recovery checklist</p>
            <h2>MFA/session handling</h2>
          </div>
          <ol className="intervention-list">
            <li>Confirm the alert contains no credentials, cookies, or raw bank session data.</li>
            <li>Renew the bank session using an admin-only workstation and authorized credentials.</li>
            <li>Resume only after session renewal is completed by an admin.</li>
          </ol>
        </article>
      </section>

      <section className="ops-card" aria-label="Recent scrape run history">
        <div>
          <p className="card-kicker">Run history</p>
          <h2>Recent scrape runs</h2>
        </div>
        <div className="run-list">
          {runs.map((run) => (
            <ScrapeRunCard key={run.id} run={run} />
          ))}
        </div>
      </section>
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
    <article className="metric-card">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function ScrapeRunCard({ run }: { run: AdminScrapeRun }) {
  return (
    <article className="run-card">
      <div>
        <p className="card-kicker">{formatBankName(run.bankId)}</p>
        <h3>{formatRunStatus(run.status)}</h3>
        <p>{run.safeErrorSummary ?? "No safe failure summary recorded."}</p>
      </div>
      <dl>
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt>Ended</dt>
          <dd>{formatDateTime(run.endedAt)}</dd>
        </div>
        <div>
          <dt>Transactions</dt>
          <dd>
            {run.insertedCount} inserted / {run.skippedCount} skipped
          </dd>
        </div>
      </dl>
    </article>
  );
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
