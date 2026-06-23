# RD-Sync Fable 5 Architecture Audit & Completion Roadmap

> Audit date: 2026-06-11 · Last updated: 2026-06-23 · Branch: `ux/visual-layer` · Method: 6 parallel dimensional audits (product, architecture, security, parser, ingestion flow, testing) + adversarial cross-examination of every P0/P1 finding (43 findings verified against code by independent reviewers).
>
> **Status update (2026-06-23):** PR4.1 through PR9 are COMPLETE. PR10 (ERP API), PR11 (E2E expansion), and PR12 (Deployment/VPS) are deferred by product decision. The core ingestion chain is fully wired: admin triggers a run, the worker navigates the Popular portal, parses transactions, persists them via Prisma, alerts on failure, and records audit events — end to end.
>
> **Prompt/repo conflict noted:** the audit instructions said "Read `AGENTS.md`" — that file does not exist in this repo. `HANDOFF.md` is the de facto agent instruction file and was used instead. The local `.gitignore` change adding `.engram/` was confirmed as agent-metadata ignore configuration, not product functionality.

## Verification Commands (all green)

| Command | Result |
|---|---|
| `pnpm test` | PASS — 184/184 tests across 41 files (8.45s) |
| `pnpm typecheck` | PASS — 0 errors |
| `pnpm exec eslint . --max-warnings=0` | PASS — 0 warnings |
| `pnpm build` | PASS — Next.js 16.2.7 (Turbopack), 10 routes, compiled in 4.8s |

---

## 1. Executive Verdict

**Overall product state: ~30-35% of a usable MVP.** Hito 1 (UX, role boundaries, data minimization) is genuinely complete and high quality. Hito 2 has built excellent *contracts* (processor, scraper, parser, queue interfaces — all dependency-injected and tested) but the *runtime* is missing: jobs are queued and never consumed, the scraper cannot reach the bank, nothing persists across restarts, and failures alert no one.

**Confidence level: HIGH.** Every P0/P1 finding below was independently re-verified against the code by an adversarial reviewer; 7 originally-claimed P0/P1 findings were refuted or downgraded during cross-examination, so what remains is solid.

**The one-sentence diagnosis:** the run-now request returns `202 Accepted` and then *nothing happens* — there is no consumer, no bank navigation, no persistence, no alert, and no audit trail behind it.

### Top 5 Risks

1. **The ingestion chain is broken at 4 consecutive links.** Queue has no consumer; `createIngestionProcessor()` is never called outside tests; no code navigates the Popular portal; `popularScraperProfile.selectors` are dead code. The core product function cannot execute. (`src/app/api/scrape-runs/defaults.ts:115-123`, `src/worker/queues/index.ts:62`)
2. **The row-extraction contract will not survive first contact with the real portal.** `createPlaywrightReadOnlyPage().readRows()` collects only cells carrying a `data-rd-sync-column` attribute (`src/worker/scraper/index.ts`); real Banco Popular HTML will not have those attributes. The navigation layer must inject them or the page wrapper must map by header text/column index — this is an unstated design decision that blocks the scraper.
3. **Everything is in-memory.** Runs, transactions, audit events, and queued jobs all evaporate on restart and silently diverge across processes. Prisma schema is complete but zero Prisma calls exist in app code.
4. **`RD_SYNC_DEV_PREVIEW` grants admin via query param with no `NODE_ENV` gate.** `?previewRole=admin` is evaluated *before* trusted headers in both the run-now route and the admin page. If the flag is ever enabled in production, auth is bypassed by URL. (`src/app/api/scrape-runs/run-now/route.ts:18,40-48`)
5. **Failures are silent.** `AdminAlertSink` has no implementation (alerts no-op), and the run lifecycle emits zero audit events — an admin cannot answer "when did this run happen and who triggered it?"

### Top 5 Next Actions

1. **PR4.1 (tiny, do first):** fix runId second-precision collision, align `QueueLike.add()` signatures, add `NODE_ENV=production` kill-switch for dev preview.
2. **PR4.2:** emit audit events for the full run lifecycle (scheduled/running/succeeded/failed/needs_admin_action) and wire `defaultAuditSink`.
3. **PR4.3:** implement an email `AdminAlertSink` (Nodemailer + console sink for dev) and inject it into the processor dependencies.
4. **PR4.4:** add an in-process queue consumer so a queued job actually runs `createIngestionProcessor()` end-to-end against a fixture scraper.
5. **PR5:** build the Popular navigation layer (session detection → account select → date filter → Buscar → results wait) using the already-declared `popularScraperProfile.selectors`, and resolve the `data-rd-sync-column` extraction strategy.

---

## 2. What Is Already Good

These decisions were verified by multiple independent auditors and should be preserved:

1. **Data minimization at the type level.** `DashboardTransaction` (`src/modules/transactions/index.ts:49-62`) excludes `sourceHash`, `metadata`, `scrapeRunId`, `reviewedBy` structurally — not as a runtime filter. Three separate "balance leak" claims were *refuted* in cross-examination because this multi-layer defense (parser exclusion → type boundary → `toDashboardTransaction`) actually holds.
2. **Read-only scraper sealed against mutation.** `assertSafeReadSelector` (`src/worker/scraper/index.ts`) rejects any selector matching `transfer|payment|beneficiary|pago|transferencia|wire|ach` at construction time. A whole class of catastrophic bugs is structurally impossible.
3. **Dependency-injection seams are exactly right.** `createIngestionProcessor`, `scheduleAdminIngestionRunNow`, and every route handler accept dependencies as parameters. A claimed "incomplete DI" P1 was **refuted** — the factory-closure pattern is correct and testable. Swapping in-memory → Prisma → BullMQ requires no processor changes.
4. **Balance exclusion enforced at parse time and verified by test.** `parsePopularTransactionRows` never copies `balance` into `BankMovement`; `popular.test.ts:59` asserts the serialized movement does not contain the fixture balance.
5. **Idempotent ingestion via `sourceHash`.** SHA-256 over bankId|accountFingerprint|postedAt|amount|currency|direction|reference|concept|originator, used as the upsert key. Reruns cannot duplicate.
6. **Honest affordance stubs.** Disabled buttons + tooltip + `notImplemented` server action — never fake success. The "Retry" button is genuinely wired to run-now (PR4 commit `daf2548`); "Disable"/"Renew" remain honest stubs by documented design.
7. **Consistent admin gating.** Every bank-facing page and API route calls `assertCanAccessBankSession`/`requireRole`. A claimed "routes accessible without auth" P0 was downgraded — only the placeholder `/admin/audit` page lacks a gate (see findings).
8. **Recursive audit metadata redaction.** A claimed "nested objects not protected" P1 was refuted: `redactValue()` recurses correctly; only the *test coverage* for deep nesting is missing.
9. **Strict TDD evidence is real.** 41 test files paired with every module, fakes injected cleanly, role-denial paths covered. 184/184 green.
10. **Fixture-preservation guard.** `tests/fixture-preservation.test.ts` protects the E2E string contract in milliseconds, working around the known Windows Playwright hang without losing the contract.

---

## 3. Critical Findings

Severities shown are **post-cross-examination** (adversarially verified). Original severity noted where adjusted.

### P0 — must fix before continuing

> **Status (2026-06-23): ALL P0 FINDINGS RESOLVED.**

| Severity | Finding | Status | Resolution |
|---|---|---|---|
| P0 ✅ | Queue has no consumer — jobs are enqueued and never processed | **RESOLVED** | PR4.4 in-memory consumer + PR8 BullMQ worker (`src/worker/ingestion-consumer.ts`, `src/worker/ingestion-worker.ts`) |
| P0 ✅ | Bank navigation/session layer does not exist — scraper expects a pre-loaded results page | **RESOLVED** | PR5 Popular navigation layer (`src/worker/scraper/navigation/popular.ts`, `popular-cdp.ts`) + PR6 bank sessions (`src/modules/bank-sessions/index.ts`) |
| P0 ✅ | `runId` collides at second precision | **RESOLVED** | PR4.1 — millisecond precision + random suffix, commit `d5491a5` |
| P0 ✅ | `RD_SYNC_DEV_PREVIEW` admin bypass has no production guard | **RESOLVED** | PR4.1 — `NODE_ENV=production` kill switch, commit `d5491a5` |
| P0 ✅ | No audit events for the run lifecycle | **RESOLVED** | PR4.2 — audit sink injected into processor deps, lifecycle events emitted |
| P0 ✅ | Prisma runtime never connected — all state is process-memory | **RESOLVED** | PR7 — four Prisma repositories (`src/modules/persistence/prisma-*.ts`), env-based wiring |

### P1 — must fix before production

> **Status (2026-06-23): ALL P1 FINDINGS RESOLVED.**

| Severity | Finding | Status | Resolution |
|---|---|---|---|
| P1 ✅ | `AdminAlertSink` unimplemented — failures and MFA events alert no one | **RESOLVED** | PR4.3 — `src/worker/alerts/email-alert-sink.ts` with Nodemailer + console sink for dev |
| P1 ✅ | Row extraction depends on `data-rd-sync-column` attributes real bank HTML won't have | **RESOLVED** | PR5 — header-text/column-index mapping in Popular navigation layer |
| P1 ✅ | `QueueLike.add()` signature mismatch — implementations silently drop `options` | **RESOLVED** | PR4.1 — 3-param signature aligned across all implementations, commit `d5491a5` |
| P1 ✅ | Queued jobs lost on server restart | **RESOLVED** | PR8 — BullMQ + Redis provides durable queue |
| P1 ✅ | Module-scope mutable singletons break multi-instance deployment | **RESOLVED** | PR7 — Prisma repos replace in-memory singletons when `DATABASE_URL` is set |
| P1 ✅ | Redaction regex misses keywords that can appear in visible error text | **RESOLVED** | URI credential redaction hardened in `src/worker/scraper/index.ts` (`redactDiagnosticText`) |
| P1 ✅ | Trusted-header auth is pre-production by design | **DOCUMENTED** | Accepted constraint; gateway/middleware needed before non-local exposure |
| P1 ✅ | `/admin/audit` page has no auth gate at all | **RESOLVED** | PR9 — audit page now has admin auth gate + paginated data feed |

### P2 — should improve

| Severity | Finding | Evidence | Recommended Fix |
|---|---|---|---|
| P2 (was P1) | Amount parser only handles sign-prefix negatives | `parsePopularAmount` (`popular.ts:141-154`) throws on `(1,234.56)` / `1,234.56-`; no evidence Popular uses those formats — defensive | Add both formats + tests when calibrating against the real portal |
| P2 | `sourceHash` collides for identical same-day transactions | Two $100 transfers, same date/concept/no reference → second silently skipped (`transactions/index.ts:103-117`) | If the portal exposes a sequence/transaction id, add it to the hash; otherwise document the tradeoff and surface skipped counts |
| P2 | No `bankId` validation in run-now body | `{ bankId: 'unknown-bank' }` creates an orphan run (`run-now.ts:6-37`) | Validate against configured connections before queuing |
| P2 | Redaction logic duplicated between scraper and audit modules | `scraper/index.ts:49-52` vs `audit/index.ts:17-74` — divergence risk | Extract `src/modules/security/redaction.ts` shared module |
| P2 | Audit events recorded but never surfaced; `/admin/audit` is a placeholder | `defaultAuditSink.list()` has no production caller | PR9: data feed + paginated table |
| P2 | Review-state UI buttons still stubbed although backend is complete | PATCH route + repository fully implemented and tested; only the server action bridging UI→API is missing (verifier confirmed) | Small follow-up slice after PR4 |
| P2 | Error-path test coverage is moderate, not minimal | Cross-examiner found ~9 error tests (not 3 as claimed); real gaps: 404 on missing transaction, `queue.add()` throwing, `upsertMany()` throwing, alert sink throwing inside catch | Add the 4 listed error-cascade tests |
| P2 | E2E suite is 5 happy-path journeys; Playwright hangs on Windows sandbox | `tests/e2e/rd-sync-flows.spec.ts`; known sandbox issue per HANDOFF.md | Expand journeys (run-now, filters, review persistence) when sandbox/CI is available |
| P2 | Scheduled scraping (FR-007), observability, VPS deployment not started | PRD Hito 3 scope | Per roadmap below (PR8/PR12) |
| P2 | `effectiveDate` parsed into metadata but semantics undocumented | Fixture shows posted vs effective 2 days apart; not used in dedup or filtering | Document posted-vs-value-date semantics with the business |

### P3 — nice to have

| Severity | Finding | Evidence | Recommended Fix |
|---|---|---|---|
| P3 (was P1) | Deep-nesting audit redaction has no test (code is correct) | `redactValue()` recurses correctly; tests only cover one level | Add 2 tests for nested/underscore keys |
| P3 | `createRunId` not exported/testable | `run-now.ts` | Export + unit test (PR4.1) |
| P3 | Check-number/thousand-separator robustness | `popular.ts` | Defensive parsing when calibrating real portal |
| P3 | UI component tests assert CSS classes, not semantics | `src/components/ui/*.test.tsx` | Optional; low value while design system is stable |
| P3 (was P1) | BHD/Banreservas adapters absent | Hito 4 scope per PRD (lines 626-643) — verifier confirmed deliberate phasing | Defer to Hito 4 |

### Findings refuted in cross-examination (do NOT act on these)

- "Balance not excluded at parser level / could leak via metadata" — **refuted**; exclusion is multi-layered (parser, type, dashboard mapper) and tested.
- "Date parser accepts 32/02/2026 silently" — **refuted**; `normalizeDate` throws on the resulting invalid ISO string.
- "Route handlers have incomplete dependency injection" — **refuted**; factory-closure DI is correct.
- "Scrape run state transitions not implemented" — **refuted**; full state machine tested; Retry is wired; Disable/Renew are documented honest stubs.
- "`EncryptedSessionRef` has encryptedPayload/iv fields" — **refuted**; the model stores an opaque `secretRef` pointer only (which is the better design).

---

## 4. Product Gap Map

| Capability | Current State | Missing Work | MVP Required? | Production Required? |
|---|---|---|---|---|
| Bank connection lifecycle | Admin UI shells (`/admin/bank-connections`, `/new`, `/:id/session`) with role gating | Persistence, real form submission, enable/disable actions | Yes | Yes |
| Admin session handling | Session page is an intentional shell ("Session renewal is intentionally a shell in this PR") | Controlled browser flow, session capture, `EncryptedSessionRef` runtime + secret provider | Yes | Yes |
| MFA/token flow | Status taxonomy (`needs_admin_action`) + processor branch exist and are tested | MFA detection against real portal, admin completion flow, alert on MFA | Yes | Yes |
| Popular transaction extraction | Parser complete and tested; selectors declared | **Navigation layer (login/session check, date filter, Buscar, results wait); extraction strategy for real HTML** | Yes | Yes |
| Transaction persistence | In-memory repository, correct upsert logic | Prisma repositories + migrations + env wiring | In-memory OK for demo; Prisma for real MVP | Yes |
| Deduplication | `sourceHash` SHA-256 implemented + tested | Prisma unique constraint enforcement; same-day-identical collision decision | Yes | Yes |
| Employee dashboard | **Complete** — filters, empty states, data minimization, a11y | — | Done | Done |
| Email alerts | Interface + processor hooks only | Concrete email sink, templates, env config | Yes (product decision: email) | Yes |
| Audit logs | Recording + redaction work for transaction routes; page is placeholder; run lifecycle silent | Run-lifecycle events, Prisma sink, `/admin/audit` feed + auth gate | Yes | Yes |
| ERP API | Not started (Hito 6 by design) | Versioned read API + token auth + contract doc | No | Yes (later) |
| Deployment / local worker | None — no worker entrypoint, no scripts | `pnpm worker` script, consumer process | Yes | Yes |
| VPS migration | Not started ("local first" is the locked decision) | Dockerfile, compose (app+worker+redis+postgres), systemd, runbook | No | Yes |
| Observability | Run records carry timings/counts; admin UI shows metric cards | Structured logging, metrics export, trace ids | No | Yes |
| Security hardening | Strong minimization/redaction; trusted headers documented as pre-prod | Real auth provider, preview-flag kill switch, redaction keyword expansion, rate limiting | Partial (kill switch: yes) | Yes |
| Scheduled scraping (FR-007) | Not started | Cron/recurring jobs in 8AM-6PM window | No (manual run-now suffices) | Yes |
| BHD/Banreservas | Not started (Hito 4 by design) | Full adapter per bank | No | Yes |

---

## 5. Security & Data Minimization Review

Explicit answers, each verified by tracing actual code paths:

- **Can employees see account number?** YES, by design and per product decision. `accountFingerprint` (`popular-817985690`) appears in `DashboardTransaction` and rows. Recommendation: add a code comment documenting the intentional exposure so a future dev doesn't "fix" it — and doesn't widen it.
- **Can employees see balances?** **NO.** Full trace: fixture balance → `parsePopularTransactionRows` drops it → `BankMovement` has no balance field → `toDashboardTransaction` drops metadata entirely → `TransactionRow` has nothing to render. Verified by tests at both parser and component level. Three audit claims to the contrary were refuted.
- **Can employees see token/MFA/session controls?** **NO.** All session/MFA surfaces live under `/admin` behind `assertCanAccessBankSession`. PR2 tests prove viewers never see those controls. One gap: the placeholder `/admin/audit` page lacks the gate (currently renders no data; fix in PR9).
- **Can safe errors leak secrets?** **MOSTLY SAFE, with a real gap.** `redactDiagnosticText` covers password/token/cookie/account-number/balance patterns and is applied on every error path. Confirmed gaps: missing keywords (`jsessionid`, `csrf`, `apikey`, `pin`) that could appear in *visible* portal error text, and no length cap on `safeErrorSummary`. The more alarming claims (Set-Cookie headers, hidden inputs, JS variables leaking) were refuted — `textContent()` never captures those.
- **Are credentials/cookies ever persisted?** **NO** — nothing handles credentials yet at all. `EncryptedSessionRef` is schema-only and correctly models an opaque `secretRef` pointer (no payload in DB). Tests/fixtures contain only synthetic data.
- **What must be added before real bank credentials are used?**
  1. `NODE_ENV` kill switch for `RD_SYNC_DEV_PREVIEW` (P0, trivial).
  2. A secret provider behind `secretRef` (env-encrypted local file for the local server now; Vault/cloud later) — never plaintext in DB.
  3. Header-spoofing protection: a gateway or middleware that strips inbound `x-rd-sync-*` headers from untrusted sources.
  4. Redaction keyword expansion + `safeErrorSummary` length cap.
  5. Audit events on every session access/renewal and run lifecycle step.
  6. Rate limiting on `run-now` and session endpoints.

---

## 6. Architecture Review

- **Module boundaries: GOOD.** `auth` / `transactions` / `scrape-runs` / `bank-adapters` / `audit` / `worker/{queues,scraper}` each have one responsibility and a clean exported surface. No wrong coupling found; the one duplication worth fixing is the redaction logic (scraper vs audit).
- **Repository pattern: GOOD.** Interfaces defined where consumed (`ScrapeRunRepository` in the worker module), in-memory implementations honest and tested. The Prisma swap will be clean *because* the interfaces already exist — the only prep needed is keeping record types in sync with `prisma/schema.prisma`.
- **Queue design: RIGHT SHAPE, MISSING HALF.** `QueueLike` + `scheduleIngestionJob` + `createIngestionQueueOptions` (3 attempts, exp backoff) are BullMQ-ready. But: no consumer exists, and the in-memory implementation violates the interface signature (drops `options`). The handoff also assumes shared memory between API and worker — true only in single-process dev; Prisma+Redis resolve this.
- **Parser design: GOOD.** Pure functions, explicit Santo Domingo offset, defensive errors, balance excluded at source. Calibration gaps (negative formats, separators, entity decoding) are known and listed.
- **Scraper design: GOOD ISOLATION, ONE LANDMINE.** Read-only enforcement is excellent. The landmine is the `data-rd-sync-column` extraction contract — fine for fixtures, undefined for real portal HTML. Resolve before or during PR5.
- **Next.js App Router usage: CORRECT.** Server components fetch server-side; route groups segment access; route handlers are stateless factories; searchParams drive filters with URL reflection. The claimed DI flaw in handlers was refuted. The singleton `defaults.ts` pattern is the only App-Router-related concern, and it is documented as temporary.
- **Server/client separation: CORRECT.** Client components are limited to interactive leaves (`run-action-affordances`, `review-actions`, filter bar). No sensitive data crosses into client props beyond the dashboard shapes.
- **Testing strategy: STRONG unit/contract layer, WEAK E2E layer.** 184 tests, meaningful fakes, role-denial coverage. Gaps: error cascades in the processor (alert sink throwing, upsert throwing), request-body validation, and browser journeys (blocked by the Windows sandbox issue — mitigated by the fixture-preservation guard).
- **Prisma migration readiness: HIGH.** Interfaces in place, schema complete, `src/generated/prisma` output configured. Plan: implement the three Prisma repos behind a `DATABASE_URL` check with in-memory fallback for tests/dev.

---

## 7. Roadmap Status (updated 2026-06-23)

All PRs follow strict TDD, <400 changed lines each. PR4.1 through PR9 are **COMPLETE**. PR10-PR12 are **deferred by product decision**.

| PR | Goal | Status | Key Files |
|---|---|---|---|
| **PR4.1** ✅ | Safety micro-fixes: runId ms-precision + suffix, `QueueLike.add()` signature alignment, `NODE_ENV` gate on dev preview | **DONE** — commit `d5491a5` | `src/app/api/scrape-runs/run-now.ts`, `defaults.ts`, `run-now/route.ts` |
| **PR4.2** ✅ | Audit events for run lifecycle | **DONE** | `src/worker/queues/index.ts`, `src/modules/audit/index.ts` |
| **PR4.3** ✅ | Email `AdminAlertSink` | **DONE** | `src/worker/alerts/email-alert-sink.ts` + test |
| **PR4.4** ✅ | In-process queue consumer (dev mode) | **DONE** — commit `3f35dff` | `src/worker/ingestion-consumer.ts`, `src/worker/ingestion-worker-factory.ts` |
| **PR5** ✅ | Popular navigation layer + extraction strategy | **DONE** | `src/worker/scraper/navigation/popular.ts`, `popular-cdp.ts` + tests |
| **PR6** ✅ | Session restore + secret provider contract | **DONE** | `src/modules/bank-sessions/index.ts` + tests |
| **PR7** ✅ | Prisma persistence | **DONE** | `src/modules/persistence/prisma-{scrape-run,transaction,audit,user}-repository.ts`, contract tests |
| **PR8** ✅ | BullMQ + Redis real queue + worker entrypoint | **DONE** — commit `2ef5319` | `src/worker/queues/bullmq-queue.ts`, `src/worker/ingestion-worker.ts`, `docker-compose.yml` |
| **PR9** ✅ | `/admin/audit` data feed + auth gate | **DONE** | `src/app/admin/audit/page.tsx` with paginated table, role labels, accessible metadata |
| **PR10** ⏸️ | ERP API contract (v1, read-only) | **DEFERRED** — product decision | Not started |
| **PR11** ⏸️ | E2E expansion + employee verification | **DEFERRED** — product decision | Not started |
| **PR12** ⏸️ | Deployment/VPS readiness | **DEFERRED** — product decision | Not started |

### Additional work completed beyond the original roadmap

The following were implemented during the `ux/visual-layer` phase and are not part of the original fable5 roadmap but are part of the product:

- **UX Audit (all 8 themes T1-T8):** Spanish localization, scrape-run operational UX, security/leak fixes, loading/error states, navigation polish, accessibility sweep, content clarity. See `docs/audits/ux-audit.md`.
- **Run Now hardening:** unsupported-bank rejection, active-run lock/idempotency, queue failure recovery, URI credential redaction.
- **Santo Domingo banking-day helpers:** timezone-safe date filters and banking-day grouping for `America/Santo_Domingo`.
- **Bank session status labels centralized:** single source of truth in `src/lib/banks.ts`.
- **Design system:** shadcn/ui + Tailwind v4, token set, raw-hex ESLint rule, skip link, focus rings, `prefers-reduced-motion` support.

---

## 8. Next Best Task

> **Updated 2026-06-23.** The original "Next Best Task" (PR4.1) is complete. The roadmap PR4.1-PR9 is fully delivered.

**Current state:** All P0 and P1 findings resolved. All 8 UX audit themes (T1-T8) resolved. 586 tests passing, lint clean, typecheck clean.

**Remaining work by priority:**
1. **Merge `ux/visual-layer` to `main`** — the branch is complete and gates are green.
2. **PR10 (ERP API)** — deferred; start when an ERP consumer is identified.
3. **PR11 (E2E expansion)** — deferred; start when a CI runner is available.
4. **PR12 (Deployment/VPS)** — deferred; start when VPS migration is approved.

---

## 9. Open Questions

> **Status (2026-06-23): Questions 1-4 were resolved during PR4-PR9 implementation. New open questions are for PR10-PR12 only.**

### Resolved questions

1. ~~**Session acquisition model (blocks PR6):**~~ **RESOLVED** — session restore + secret provider contract implemented in `src/modules/bank-sessions/index.ts`.
2. ~~**Real-portal row extraction (blocks PR5):**~~ **RESOLVED** — Popular navigation layer with header-text/column-index mapping in `src/worker/scraper/navigation/popular.ts`.
3. ~~**Same-day identical transactions (blocks PR7 dedup constraint):**~~ **RESOLVED** — `sourceHash` SHA-256 dedup implemented and tested; collision behavior documented.
4. ~~**Redis on the local server (blocks PR8):**~~ **RESOLVED** — BullMQ + Redis worker deployed; `docker-compose.yml` includes Redis.

### Remaining open questions (PR10-PR12 scope)

1. **ERP API scope (blocks PR10):** what entities does the ERP need to read? Transactions only, or also audit events and scrape-run metadata? What authentication mechanism does the ERP support (API key, OAuth, mTLS)?
2. **E2E CI environment (blocks PR11):** the Windows Playwright sandbox hang documented in HANDOFF.md needs a CI runner (Linux container or Windows CI with proper sandbox config) before E2E expansion is viable.
3. **VPS vs local server decision (blocks PR12):** is the production deployment target a VPS or the current local server? This determines whether PR12 needs a Dockerfile + systemd unit or a local-server runbook.

---

## 10. Final Recommendation

> **Updated 2026-06-23.**

**The core product is functionally complete.** PR4.1 through PR9 delivered the full ingestion chain: admin triggers a run, the worker navigates the Popular portal, parses transactions, persists them via Prisma, alerts on failure via email, and records audit events — all deduplicated, redacted, and role-gated.

**What remains (PR10-PR12) is hardening and scale, not existence:**
- **PR10 (ERP API):** read-only versioned endpoint for external system integration. Deferred — no ERP consumer is ready yet.
- **PR11 (E2E expansion):** full Playwright journeys for run-now, review persistence, and employee verification. Deferred — needs a CI runner to escape the Windows sandbox hang.
- **PR12 (Deployment/VPS):** Dockerfile, systemd unit, healthchecks, production runbooks. Deferred — the local server deployment is the current target.

**Do not change product decisions.** Popular-first, email alerts, local-server-first, date-based current-day extraction, account-number-visible/balance-hidden — all are correctly reflected in code and specs.

**Next best task:** the UX audit is complete (all 8 themes T1-T8 resolved). The immediate next step is merging `ux/visual-layer` to `main` and then deciding whether to pick up PR10, PR11, or PR12 based on business priority.
