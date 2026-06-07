export default function HomePage() {
  return (
    <main className="shell">
      <section className="panel" aria-labelledby="page-title">
        <p className="eyebrow">RD-Sync</p>
        <h1 id="page-title">Transaction dashboard scaffold</h1>
        <p className="lede">
          PR 1 only establishes the application, database, and test foundation. The employee dashboard,
          scraper worker, and admin operations screens are intentionally implemented in later slices.
        </p>
      </section>
    </main>
  );
}
