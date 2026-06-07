# Tasks: Transaction Dashboard MVP

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 4,000-7,000 including scaffold, lockfile, Prisma schema, app, worker, and tests |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 scaffold/schema/test runner -> PR 2 auth/audit/transactions API -> PR 3 worker/admin ops -> PR 4 E2E/security hardening |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

Strict TDD is not active until the stack and test runner are scaffolded; after 1.1, use RED/GREEN/REFACTOR where practical.

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Next.js/TS, Prisma schema, seed roles, test tooling | PR 1 | Lockfile may need review exception; enables TDD. |
| 2 | RBAC, audit, transaction domain/API/dashboard | PR 2 | Employee-safe read path. |
| 3 | BullMQ worker, Playwright adapter, admin ops | PR 3 | Admin-only bank session boundary. |
| 4 | E2E, monitoring checks, docs | PR 4 | Full MVP verification. |

## Phase 1: Foundation

- [ ] 1.1 Create `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, and `playwright.config.ts` with runnable unit/e2e commands.
- [ ] 1.2 Create `prisma/schema.prisma` for users, roles, transactions, scrape runs, audit events, and encrypted session refs with unique `sourceHash`.
- [ ] 1.3 Create `prisma/seed.ts` for `admin`, `reviewer`, and `viewer` roles.

## Phase 2: Domain, RBAC, Audit

- [ ] 2.1 RED: add Vitest tests for `src/modules/transactions/` normalization, source hashing, optional fields, and idempotent persistence.
- [ ] 2.2 GREEN: implement `src/modules/transactions/` domain types, normalizer, repository, and filter DTOs.
- [ ] 2.3 RED/GREEN: test and implement `src/modules/auth/` RBAC plus `src/modules/audit/` redacted audit events and denied employee bank actions.

## Phase 3: Dashboard and API

- [ ] 3.1 RED/GREEN: test and implement `src/app/api/transactions/route.ts` filters, newest-first ordering, data minimization, and audit writes.
- [ ] 3.2 RED/GREEN: test and implement `src/app/api/transactions/[id]/review/route.ts` reviewer-only state updates.
- [ ] 3.3 Create `src/app/(private)/transactions/page.tsx` with empty state, filters, transaction list, and no scraper controls.

## Phase 4: Worker and Operations

- [ ] 4.1 RED/GREEN: test and implement `src/worker/scraper/` Playwright read-only adapter, MFA pause, and redacted diagnostics.
- [ ] 4.2 RED/GREEN: test and implement `src/worker/queues/` BullMQ ingestion, retries, scrape-run transitions, and idempotent upserts.
- [ ] 4.3 Create `src/app/admin/scrape-runs/page.tsx` for admin-only health, failure summaries, and MFA/session intervention.

## Phase 5: Verification and Docs

- [ ] 5.1 Add Playwright E2E tests for viewer dashboard, unauthorized denial, reviewer state, and admin MFA path.
- [ ] 5.2 Update `README.md` or ops notes with setup, safe scraping boundaries, verification commands, and out-of-scope ERP/reconciliation.

