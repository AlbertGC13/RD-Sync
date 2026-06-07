## Exploration: RD-Sync Transaction Dashboard MVP

### Current State
RD-Sync is a new workspace with SDD/OpenSpec scaffolding only. No application stack, runtime, database, tests, or deployment target exists yet. The product scope is clear: build a private dashboard that shows recent bank transactions collected through controlled scraping, with filters for designated employees. ERP integration, reconciliation, payments, transfers, and direct employee bank access are out of scope for MVP.

### Affected Areas
- `openspec/config.yaml` — defines current SDD context, strict TDD status, and MVP boundaries.
- `openspec/changes/build-transaction-dashboard-mvp/` — will contain proposal, specs, design, tasks, and verification artifacts for this change.
- Future `app/dashboard` or equivalent — employee-facing transaction list and filters.
- Future `worker/scraper` or equivalent — Playwright-based bank session and transaction extraction.
- Future `database` or equivalent — transaction, scrape run, user, role, and audit persistence.

### Approaches
1. **MVP modular monolith plus worker** — One application boundary for dashboard/API, with a separate background worker process for Playwright scraping, backed by PostgreSQL and a small queue.
   - Pros: fastest safe path, simple deployment, clear separation between UI/API and scraper, easy to evolve toward ERP integration later.
   - Cons: requires discipline to keep scraper, domain, and UI modules separated.
   - Effort: Medium

2. **Separate services from day one** — Independent dashboard API, scraper service, normalization service, queue, and audit service.
   - Pros: stronger isolation and scaling model.
   - Cons: too much operational overhead before the product proves value; slower delivery.
   - Effort: High

3. **Managed workflow-first architecture** — Use Temporal or equivalent to model login, MFA, scraping, retries, and review flows.
   - Pros: excellent for long-running human-in-the-loop flows and retries.
   - Cons: heavier learning and infrastructure burden for a first MVP.
   - Effort: High

4. **Single local/VPS script plus dashboard** — Run scraper on one controlled machine and expose a private dashboard.
   - Pros: cheapest and quickest for validation.
   - Cons: weaker resilience, harder auditability, greater risk of ad-hoc shortcuts.
   - Effort: Low

### Recommendation
Use **Approach 1: MVP modular monolith plus worker**. It gives enough structure to enforce security boundaries without overengineering. The architecture should include: dashboard/API, Playwright scraper worker, PostgreSQL, queue/retry mechanism, encrypted session/secret handling, audit log, and alerting. Employees must only access normalized transaction records through the dashboard. The bank portal session and MFA flow must remain admin-only.

### Risks
- Bank UI changes can break selectors and stop ingestion.
- Bank terms, security controls, MFA, or WAF behavior can block or restrict scraping.
- Storing bank credentials or browser session state incorrectly can create account-compromise risk.
- Employees may infer sensitive information if the dashboard exposes balances, account metadata, screenshots, or unrelated movements.
- MFA human-in-the-loop can become a phishing surface if implemented through chat or weak internal screens.
- Lack of app stack/tests means Strict TDD is unavailable until scaffolding introduces a test runner.

### Ready for Proposal
Yes. The proposal should scope the MVP around transaction visibility only: dashboard, filters, controlled scraping, least-privilege access, auditability, operational alerts, and future ERP extension points without implementing ERP integration.
