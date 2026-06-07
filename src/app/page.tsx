import Link from "next/link";

export default function HomePage() {
  return (
    <main className="shell">
      <section className="panel" aria-labelledby="page-title">
        <p className="eyebrow">RD-Sync</p>
        <h1 id="page-title">Transaction dashboard MVP</h1>
        <p className="lede">
          Private, employee-safe visibility into recent bank movements. Use the flows below to preview
          the current MVP screens without giving employees access to bank portals or MFA handling.
        </p>
        <div className="flow-grid" aria-label="MVP preview flows">
          <Link className="flow-card" href="/transactions">
            <span className="card-kicker">Employee flow</span>
            <strong>View recent transactions</strong>
            <span>Open filters and the empty-state transaction dashboard.</span>
          </Link>
          <Link className="flow-card" href="/admin/scrape-runs?previewRole=admin">
            <span className="card-kicker">Admin demo flow</span>
            <strong>Review scrape run operations</strong>
            <span>Preview MFA/session intervention and safe run summaries.</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
