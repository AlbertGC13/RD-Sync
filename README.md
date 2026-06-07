# RD-Sync Transaction Dashboard MVP

RD-Sync is a private dashboard MVP for viewing recent Dominican bank transactions without giving employees direct bank-portal access. The current build focuses on safe transaction visibility, role boundaries, audit-friendly APIs, scraper/worker scaffolding, and operations visibility. ERP integration and full reconciliation are intentionally deferred.

## Quick path

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Copy local configuration:

   ```bash
   cp .env.example .env
   ```

3. Prepare Prisma when a local PostgreSQL database is available:

   ```bash
   pnpm prisma:generate
   pnpm db:push
   pnpm prisma:seed
   ```

4. Start the dashboard:

   ```bash
   pnpm dev
   ```

5. Open the MVP screens:

   - Employee dashboard: `http://127.0.0.1:3000/transactions`
   - Admin operations: `http://127.0.0.1:3000/admin/scrape-runs`
   - Local demo home: `http://127.0.0.1:3000/`

6. Read the operator flow guide before testing scraping assumptions:

   - Bank scraping operational guide: [`docs/guia-operativa-scraper-bancario.md`](docs/guia-operativa-scraper-bancario.md)

For local manual testing only, start the dev server with `RD_SYNC_DEV_PREVIEW=enabled` and use the **Admin demo** link from the home page. Without that variable, the admin route requires a trusted admin principal and direct browser access will show the restricted state.

## What employees can see

| Role | Allowed | Not allowed |
|------|---------|-------------|
| `viewer` | View minimized transaction data and filters. | Review-state updates, scraper controls, bank sessions, credentials, MFA. |
| `reviewer` | View transactions and mark review state. | Bank sessions, credentials, MFA, scraper control. |
| `admin` | View operational scrape-run health and handle session/MFA intervention. | Money movement and transfer/payment flows remain out of scope. |

The employee dashboard must not expose balances, credentials, raw bank screenshots, cookies, session tokens, or bank-portal controls.

## Safe scraping boundaries

RD-Sync treats bank scraping as a high-risk integration boundary. The MVP code follows these guardrails:

- Scraper code is read-only: it extracts transaction rows and rejects unsafe action selectors.
- MFA/session renewal is admin-only and should happen outside employee workflows.
- Failed scraping runs store safe summaries only; diagnostics must redact credentials, cookies, tokens, raw HTML, screenshots, and unrelated account details.
- Ingestion must be idempotent through `sourceHash` so reruns do not duplicate transactions.
- Bank credentials and sessions should be stored only as encrypted secret references, never as plain values in the app database or logs.

For the full end-to-end bank-login, MFA, extraction, and employee-dashboard flow, read [`docs/guia-operativa-scraper-bancario.md`](docs/guia-operativa-scraper-bancario.md).

## Verification commands

Run the checks before handing a slice to review:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:e2e -- tests/e2e/rd-sync-flows.spec.ts --project=chromium --reporter=list
```

If Playwright browsers are missing, install Chromium once:

```bash
pnpm exec playwright install chromium
```

Playwright uses `127.0.0.1:3100` by default to avoid colliding with a manually running Next.js dev server on port `3000`. E2E fixture data is enabled only through `RD_SYNC_E2E_FIXTURES=enabled` in `playwright.config.ts`.

## Local auth note

The MVP currently resolves users from trusted headers:

- `x-rd-sync-user-id`
- `x-rd-sync-role`

This is acceptable only behind a trusted authentication gateway or in local tests. Before production exposure, replace or wrap this with a real identity provider/session layer and ensure headers cannot be spoofed from the public internet.

`RD_SYNC_DEV_PREVIEW=enabled` only enables the local `?previewRole=admin` demo path. Do not enable it in production.

## Out of scope for this MVP

- ERP integration.
- Automated reconciliation against invoices/accounts receivable.
- Payment initiation, transfers, approvals, or any money-movement workflow.
- Public multi-tenant SaaS onboarding.
- Fully resilient bank-specific scraping flows for Banreservas, BHD, and Popular.
- Production secret rotation, alert delivery, and incident runbooks.

## Next operational checklist

- [ ] Confirm the first target bank and account permissions.
- [ ] Configure a real secret provider for bank-session references.
- [ ] Put the dashboard behind trusted authentication.
- [ ] Wire the admin alert sink to a real external channel for `needs_admin_action` scrape runs.
- [ ] Replace in-memory repositories with Prisma-backed runtime repositories.
