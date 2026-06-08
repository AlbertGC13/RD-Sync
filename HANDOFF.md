# RD-Sync — Handoff for the next agent

This document is the single source of truth for any agent (or human) that
picks up RD-Sync after the Hito 1 UX polish chain lands. Read it before
touching anything.

## TL;DR

- **Stack:** Next.js App Router + TypeScript + Tailwind v4 (CSS-first) +
  shadcn/ui (New York) + Sonner toasts + lucide-react + Radix primitives
  + Vitest + Playwright.
- **Code location:** `C:\Dev\RD-Sync` (Windows), tracked in git, remote
  at `https://github.com/AlbertGC13/RD-Sync.git` (origin = main).
- **Branch model:** stacked-to-main, 800-line PR budget. Each change has
  one feature branch off main; the orchestrator merges to main on green.
- **Last completed change:** `hito1-ux-polish` (4 PRs: A DS baseline, B
  transactions page + critical wiring fix, C admin scrape-runs + FR-012
  affordances + audit page placeholder, D E2E preservation + a11y
  smoke). All 4 merged to main.
- **Next planned change:** `hito2-real-bank-connection` (Banco Popular
  first). See "Hito 2 kickoff" below.

## What was actually built in Hito 1 (and what was NOT)

### Built and verified
- **Design system:** shadcn/ui + Tailwind v4 with a full `@theme` token
  set in `src/app/globals.css`. No raw hex outside the token block
  (enforced by a flat-config ESLint rule).
- **13 base components** under `src/components/ui/` (Button, Card, Badge,
  Skeleton, Input, Select, Tooltip, Toast, Dialog, Drawer, EmptyState,
  ErrorState, PageHeader). Each has a paired Vitest test.
- **Transactions page** (`src/app/(private)/transactions/page.tsx`):
  - **Critical fix:** wired to `listTransactionsForPage(filters)` from
    `src/app/api/transactions/defaults.ts`. Before this fix the page
    rendered a hard-coded `transactions={[]}` so the polished UI was
    invisible — that is what the user perceived as "the dashboard is
    broken".
  - **FR-010 filter set:** bankId, amount, query, currency,
    accountFingerprint, dateFrom, dateTo (all server-side, all reflected
    in the URL).
  - **Per-row visual contract:** postedAt formatted in user locale, plus
    a `Credit` / `Debit` badge with success/warning variant and
    explicit +/− symbol (color is never the only signal).
  - **FR-011 reviewer affordances:** visible only to reviewers/admins,
    all five review states shown, every action disabled with a Radix
    Tooltip ("Available in upcoming change") and a Sonner toast on
    click. The `notImplemented` server action is the single source of
    truth and is reused by the admin run affordances.
  - **Empty state** with a "Clear filters" link when filters are active.
  - **Data minimization:** the `DashboardTransaction` type excludes
    `sourceHash`, `metadata`, `scrapeRunId`, and `reviewedBy`, so the
    guarantee is enforced at the type level.
- **Admin scrape-runs page** (`src/app/admin/scrape-runs/page.tsx`):
  - 4 metric cards (Total, Successful, Needs admin action, Failed).
  - Run history with per-run status badge, transaction counts, started /
    ended timestamps.
  - **FR-012 affordances:** Retry / Disable connection / Renew session,
    all disabled with a Tooltip ("Available in Hito 2"), all routed
    through `notImplemented`.
  - **Admin denial:** non-admin principals see a clear "Admin access
    required" page; no run details leak.
- **Admin audit page placeholder** (`src/app/admin/audit/page.tsx`):
  reachable from the admin nav, shows an honest "No events yet" empty
  state. Data feed lands in a follow-up change.
- **E2E fixture preservation test** (`tests/fixture-preservation.test.ts`):
  guards the 8 literal text strings the Playwright suite asserts on. If
  any redesign removes one of them, the unit test fails in milliseconds
  before the slower browser suite ever runs.
- **A11y smoke test** (`tests/a11y-smoke.test.ts`): asserts on focus
  rings, landmarks, `aria-disabled` on the stub affordances, and the
  no-raw-hex rule.

### NOT built (out of scope, intentional)
- Real bank connection (Hito 2). The `previewRuns` in admin scrape-runs
  is hard-coded and only switches on the dev preview flag.
- Real ScrapeRunRepository (Hito 2). The interface exists in
  `src/worker/queues/index.ts`; the in-memory implementation does not.
- Replacing in-memory repos with Prisma runtime (separate production
  hardening change — the Prisma schema lives at `prisma/schema.prisma`).
- Real `AdminAlertSink` external channel (the contract and tests exist;
  the sink is a no-op by default).
- Light mode (the `@theme` block ships dark only; light-mode slots are
  placeholders for a follow-up).
- Email parser fallback (Hito 5) and ERP connector (Hito 6).

## How to run it

```powershell
cd C:\Dev\RD-Sync
pnpm install
pnpm test          # 154/154 passing
pnpm typecheck     # exit 0
pnpm lint          # exit 0
pnpm build         # exit 0
pnpm dev           # http://127.0.0.1:3000
```

The Playwright E2E suite is configured to run on port 3100 with a
disposable webServer. It is **known to hang in the current Windows
sandbox** (`pnpm test:e2e`); the design preserves the literal text
strings the suite asserts on, so a future sandbox fix will not require
code changes. Until then, rely on the `tests/fixture-preservation.test.ts`
unit test as the contract.

## Hito 2 kickoff

The next change is `hito2-real-bank-connection`, focused on Banco
Popular. Suggested scope (in priority order):

1. **Real `ScrapeRunRepository` + admin scrape-runs reads from it.**
   Define the interface in `src/modules/scrape-runs/` (mirroring
   `src/modules/transactions/`), add an in-memory implementation, expose
   `listScrapeRunsForPage(filters)` from
   `src/app/admin/scrape-runs/_actions/`, and switch the page to use
   it.
2. **Bank Connection CRUD.** `BankConnection` table is already in
   `prisma/schema.prisma`; build the admin UI at
   `/admin/bank-connections/new` per FR-002.
3. **Admin session renewal flow.** Replace the stubbed
   `notImplemented('renew')` call with a real server action that
   records the renewal in the audit log.
4. **Run retry.** Replace `notImplemented('retry')` with a real action
   that re-enqueues a `bank-transaction-ingestion` job via
   `scheduleIngestionJob`.
5. **Disable connection.** Replace `notImplemented('disable')` with a
   real action that flips `BankConnection.status` to `disabled` and
   emits an audit event.
6. **Selector calibration profile.** Add `src/worker/scraper/profile/`
   with the Banco Popular selectors, a fixture-based selector test, and
   a runbook for the safe-failure taxonomy.

Follow the same SDD pattern (sdd-new → explore → propose → spec →
design → tasks → apply → verify → archive), with chained PRs under
800 lines each. The decisions locked for Hito 1 carry over:

- artifact store: engram
- pace: auto
- chain strategy: stacked-to-main
- strict TDD: on
- branch from a fast-forward-merged main (this repo's convention)

## Conventions to keep

- **No raw hex outside the token block** (`src/app/globals.css`). The
  ESLint rule enforces it for `src/components/**/*.{ts,tsx}` and
  `src/app/**/page.tsx`; test fixtures are exempt.
- **Use the design tokens, not arbitrary values.** `bg-primary`,
  `text-foreground`, `border-border`, etc. The Badge variant for status
  is `success` (credit, succeeded) / `warning` (debit, running) /
  `destructive` (failed, needs_admin_action) / `secondary` (queued).
- **Stub affordances are honest.** Disabled with a Tooltip, routed
  through `notImplemented` server action, never fake-success. Extend
  the `NotImplementedFeature` union in
  `src/app/(private)/transactions/_actions/not-implemented.ts` when you
  need a new stub.
- **Data minimization at the type level.** When adding a new entity to
  the dashboard, define a `DashboardX` shape that excludes admin-only
  fields. The page receives only the dashboard shape, never the raw
  record.
- **Preserve the E2E fixture strings.** If you rename a literal that
  the Playwright suite asserts on, update both `tests/e2e/rd-sync-flows.spec.ts`
  and `tests/fixture-preservation.test.ts` in the same commit.
- **Conventional commits**, no AI attribution, no `Co-Authored-By:`.
- **The orchestrator pattern still applies.** Delegate to sub-agents for
  exploration, multi-file writes, and verification. Keep the
  orchestrator's context thin.

## Key files to read first

- `docs/prd-rd-sync-producto-final.md` — the full product PRD (sections
  6, 7, 10, 12, 13 are the most actionable).
- `docs/design-system.md` — the design system baseline (tokens,
  components, lint rule, a11y, theme).
- `openspec/specs/transaction-dashboard/spec.md`,
  `openspec/specs/operations-monitoring/spec.md`,
  `openspec/specs/access-control-audit/spec.md` — the canonical
  capability boundaries. New changes layer on top via "ADDED
  Requirements" delta specs.
- `src/app/api/transactions/defaults.ts` — the page-facing repository
  pattern. Reuse this shape for the ScrapeRunRepository.
- `src/app/(private)/transactions/_actions/not-implemented.ts` — the
  single source of truth for "Available in Hito 2" affordances.
- `src/worker/queues/index.ts` — the ingestion processor and the
  `ScrapeRunRepository` interface to implement.

## Open questions for the next session

These are not blocking code, but the answers will shape Hito 2:

1. Which bank goes first — Popular, BHD, or Banreservas? (PRD section
   18 question 1.)
2. Does the bank account have a read-only user, or only full-permission
   users? (PRD section 18 question 2.)
3. What alert channel first — email, WhatsApp, Slack, or SMS? (PRD
   section 18 question 3.)
4. Where does the worker with the headless browser run — local admin
   machine, VPS, or cloud? (PRD section 18 question 4.)
5. What scraping window does the business actually need? (PRD section
   18 question 5.)

The defaults assumed in this change are Popular first, read-only user
preferred, dev console + log for now, business hours scraping. The
first change in Hito 2 should confirm or override these.
