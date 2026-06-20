# RD-Sync Fable 5 Architecture Audit & Completion Roadmap

> Audit date: 2026-06-11 · Branch: `codex/hito2-run-now-ingestion-alerts` · Method: 6 parallel dimensional audits (product, architecture, security, parser, ingestion flow, testing) + adversarial cross-examination of every P0/P1 finding (43 findings verified against code by independent reviewers).
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

| Severity | Finding | Evidence | Recommended Fix |
|---|---|---|---|
| P0 | Queue has no consumer — jobs are enqueued and never processed | `InMemoryScheduledIngestionQueue` (`src/app/api/scrape-runs/defaults.ts:115-123`) is an append-only array; `createIngestionProcessor()` (`src/worker/queues/index.ts:62`) is never called outside tests; no worker script in `package.json` | Add an in-process consumer for dev (PR4.4), then a real worker entrypoint with BullMQ+Redis (PR8) |
| P0 | Bank navigation/session layer does not exist — scraper expects a pre-loaded results page | `ReadOnlyBankScraper.collect(page)` (`src/worker/scraper/index.ts:46-76`) only reads; `popularScraperProfile.selectors` (`src/modules/bank-adapters/popular.ts:31-39`) are declared but used by zero code; no login/MFA/date-filter/Buscar logic anywhere | Create `src/worker/scraper/navigation/popular.ts` (navigator) + session restore contract; wire as the concrete `IngestionScraper` (PR5/PR6) |
| P0 | `runId` collides at second precision | `now.toISOString().replace(...).slice(0, 14)` (`src/app/api/scrape-runs/run-now.ts:47`); two clicks in the same second → `createQueued` throws "Scrape run already exists" → confusing 403 | Extend to millisecond precision or add a random suffix; add a collision test (PR4.1) |
| P0 | `RD_SYNC_DEV_PREVIEW` admin bypass has no production guard | `resolveApiPreviewPrincipal(url.searchParams) ?? resolvePrincipalFromTrustedHeaders(...)` — preview path wins *first*, works with zero headers (`run-now/route.ts:18`, `admin/scrape-runs/page.tsx:49-51`); no `NODE_ENV` check | Gate preview on `NODE_ENV !== 'production'` and fail loudly if the flag is set in prod; log preview usage to audit (PR4.1) |
| P0 | No audit events for the run lifecycle | `IngestionProcessorDependencies` has no audit sink; `markRunning/markSucceeded/markFailed/markNeedsAdminAction` and the run-now POST emit nothing (`src/worker/queues/index.ts:48-100`) | Inject `AuditSink` into processor deps; emit `scrape_run_scheduled/started/completed/attention_needed` (PR4.2) |
| P0 | Prisma runtime never connected — all state is process-memory | Zero `PrismaClient` instantiations in `src/` (verified by grep); `defaults.ts` files hardcode in-memory repos; data lost on every restart | `PrismaScrapeRunRepository`, `PrismaTransactionRepository`, `PrismaAuditSink` behind the existing interfaces; env-based wiring (PR7) |

### P1 — must fix before production

| Severity | Finding | Evidence | Recommended Fix |
|---|---|---|---|
| P1 | `AdminAlertSink` unimplemented — failures and MFA events alert no one | Interface only (`src/worker/queues/index.ts:39-46`); `adminAlerts?` optional and always `undefined`; HANDOFF.md documents the no-op | Email sink (Nodemailer/SMTP) + console sink for dev; inject into processor (PR4.3) |
| P1 | Row extraction depends on `data-rd-sync-column` attributes real bank HTML won't have | `createPlaywrightReadOnlyPage().readRows()` collects only attributed cells (`src/worker/scraper/index.ts:79-105`) | Decide extraction strategy for real portals: header-text/column-index mapping in the page wrapper, or DOM attribute injection during navigation; validate against an HTML snapshot fixture (PR5) |
| P1 | `QueueLike.add()` signature mismatch — implementations silently drop `options` | Interface requires 3 params (`src/worker/queues/index.ts:57`); `InMemoryScheduledIngestionQueue.add()` and both test fakes accept 2 (`defaults.ts:118`) | Align signatures now so BullMQ options (attempts: 3, backoff) are not silently lost later (PR4.1) |
| P1 | Queued jobs lost on server restart | Module-scope singleton queue (`defaults.ts:123`), no persistence | Acceptable for local dev if documented; BullMQ+Redis before production (PR8) |
| P1 (was P0) | Module-scope mutable singletons break multi-instance deployment | `defaultScrapeRunRepository` etc. are per-process; API instance A's run is invisible to worker instance B | Resolved automatically by PR7 (Prisma) + PR8 (Redis queue); documented and intentional for now |
| P1 (was P0) | Redaction regex misses keywords that can appear in visible error text | `credentialPattern` (`src/worker/scraper/index.ts:50`) lacks `jsessionid`, `csrf`, `apikey`, `pin`; cross-examiner refuted the HTML/Set-Cookie claims (textContent never captures those) but confirmed the keyword gaps | Extend the keyword list; add a length cap on `safeErrorSummary` (~500 chars) |
| P1 | Trusted-header auth is pre-production by design | `resolvePrincipalFromTrustedHeaders` reads `x-rd-sync-user-id`/`x-rd-sync-role` raw; README documents the constraint | Before any non-local exposure: real identity layer or a gateway that strips/injects those headers |
| P1 | `/admin/audit` page has no auth gate at all | `src/app/admin/audit/page.tsx` renders without resolving a principal (only route in the app missing the check — found during cross-examination of a broader claim) | Add the same `assertCanAccessBankSession` gate as sibling admin pages when wiring the data feed (PR9) |

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

## 7. Recommended Roadmap

All PRs start from `codex/hito2-run-now-ingestion-alerts` and follow stacked-to-main, strict TDD, <400 changed lines each. Roadmap item "Connect admin UI to Run Now scheduling" is **already done** (`daf2548`) and only needs the E2E journey in PR11.

| PR | Goal | Files Likely Touched | Tests Required | Acceptance Criteria |
|---|---|---|---|---|
| **PR4.1** | Safety micro-fixes: runId ms-precision + suffix, `QueueLike.add()` signature alignment, `NODE_ENV` gate on dev preview | `src/app/api/scrape-runs/run-now.ts`, `defaults.ts`, `run-now/route.ts`, `admin/scrape-runs/page.tsx`, both test files | RED: collision test (two calls same second → distinct ids); preview-in-production test → denied | Rapid double-click never 403s; preview path inert when `NODE_ENV=production`; all fakes match interface |
| **PR4.2** | Audit events for run lifecycle | `src/worker/queues/index.ts` (add optional `audit` dep), `run-now.ts`, `defaults.ts`, `queues.test.ts` | RED: full run emits scheduled→started→completed events; failure emits attention event with redacted summary | Every state transition + the POST itself produce audit events through `redactAuditMetadata` |
| **PR4.3** | Email `AdminAlertSink` | new `src/worker/alerts/email-alert-sink.ts` + test; `.env.example`; wire in defaults | RED: mock transport receives redacted body on failed/needs_admin_action; sink throwing never crashes processor | MFA/failure produces an email (console sink in dev); payload contains no credentials/account/balance |
| **PR4.4** | In-process queue consumer (dev mode) | new `src/worker/ingestion-worker.ts`; `package.json` script `worker`; `defaults.ts` | RED: enqueued job → processor runs with fixture scraper → run transitions queued→running→succeeded, transactions upserted | `POST run-now` followed by consumer tick yields a succeeded run visible in `/admin/scrape-runs` and rows in `/transactions` (fixture data) |
| **PR5** | Popular navigation layer + extraction strategy | new `src/worker/scraper/navigation/popular.ts` + test; `src/worker/scraper/index.ts` (header/index column mapping); HTML snapshot fixture | RED: navigator fills `sDate`/`eDate`, clicks Buscar, waits for results table against a mock page; readRows works on snapshot HTML without `data-rd-sync-column` | `popularScraperProfile.selectors` are consumed by real code; MFA indicator → `needs_admin_action`; extraction proven against realistic HTML |
| **PR6** | Session restore + secret provider contract | new `src/modules/bank-sessions/` (SecretProvider interface, local encrypted impl), session page wiring | RED: secretRef round-trip; expired/absent session → `needs_admin_action`, never a login attempt | Worker restores an admin-established session; no plaintext secrets in DB or logs |
| **PR7** | Prisma persistence (may split 7a repos / 7b wiring) | new `src/modules/persistence/` (3 Prisma repos); `defaults.ts` files env-switch; migrations | RED: contract tests run against both in-memory and Prisma impls; `sourceHash` unique constraint dedup test | `DATABASE_URL` set → data survives restart; tests green without DB (fallback) |
| **PR8** | BullMQ + Redis real queue + worker entrypoint | `src/worker/ingestion-worker.ts`, `defaults.ts`, docker-compose for redis | RED: in-memory mode still works; BullMQ options (3 attempts, backoff) applied | Jobs survive restart; API and worker are separate processes sharing Redis |
| **PR9** | `/admin/audit` data feed + auth gate | `src/app/admin/audit/page.tsx`, audit API or server load | RED: non-admin denied; events render paginated | Placeholder replaced; the only ungated admin route is fixed |
| **PR10** | ERP API contract (v1, read-only) | new `src/app/api/erp/v1/transactions/route.ts`, token auth, `docs/erp-api.md` | RED: token required; pagination; same `DashboardTransaction` minimization | Documented, versioned, read-only endpoint suitable for the future ERP |
| **PR11** | E2E expansion + employee verification | `tests/e2e/rd-sync-flows.spec.ts` | Admin run-now journey; reviewer persistence journey; employee sees imported Popular transactions, zero balances/secrets in HTML | The five highest-value journeys from the testing audit pass on a working sandbox/CI |
| **PR12** | Deployment/VPS readiness | `Dockerfile` (app+worker, Playwright/Chromium), `docker-compose.yml`, systemd unit, `docs/runbooks/` | Build verification; healthcheck smoke | One-command local stack; documented VPS migration path |

Dependency order: PR4.1 → PR4.2 → PR4.3 → PR4.4 → PR5 → PR6 → PR7 → PR8; PR9-PR12 can interleave after PR7.

---

## 8. Next Best Task for Codex

**Task: PR4.1 — runId collision fix + queue contract alignment + dev-preview production guard.**

- **Objective:** Make the already-shipped run-now slice safe: (1) `createRunId` uses millisecond precision plus a 4-char random suffix and is exported for testing; (2) every `QueueLike` implementation accepts the 3-parameter `add(name, data, options)` signature; (3) `resolveApiPreviewPrincipal` and `resolvePreviewPrincipal` return `null` when `process.env.NODE_ENV === 'production'`, regardless of `RD_SYNC_DEV_PREVIEW`.
- **Files to edit:**
  - `src/app/api/scrape-runs/run-now.ts` (runId generation, export `createRunId`)
  - `src/app/api/scrape-runs/defaults.ts` (`InMemoryScheduledIngestionQueue.add` signature)
  - `src/app/api/scrape-runs/run-now/route.ts` (preview guard)
  - `src/app/admin/scrape-runs/page.tsx` (preview guard — keep E2E fixture strings intact)
  - `src/app/api/scrape-runs/run-now.test.ts`, `run-now.route.test.ts` (new RED tests + fake signature fix)
- **Tests to write first (RED):**
  1. `createRunId` called twice with timestamps 1ms apart → distinct ids; called twice with the *same* timestamp → still distinct (suffix).
  2. Two sequential `scheduleAdminIngestionRunNow` calls in the same second → both succeed, two queued runs.
  3. With `NODE_ENV=production` and `RD_SYNC_DEV_PREVIEW=enabled`, `?previewRole=admin` → 401/403, no run created.
  4. Fake queues implement the 3-param signature (compile-level check via `satisfies QueueLike`).
- **Commands:** `pnpm test`, `pnpm typecheck`, `pnpm exec eslint . --max-warnings=0`, `pnpm build` — all must stay green (184+ tests).
- **What NOT to touch:** the processor (`src/worker/queues/index.ts` logic), the scraper, the parser, any UI strings guarded by `tests/fixture-preservation.test.ts`, the disabled Disable/Renew stubs, `prisma/schema.prisma`.
- **Expected commit message:** `fix(scrape-runs): harden run-now ids, queue contract, and preview gating`

---

## 9. Open Questions

Real blockers only — each shapes an upcoming PR's design:

1. **Session acquisition model (blocks PR6):** when the admin completes login+MFA on Popular, does the worker reuse a browser profile/cookies on the same local machine, or does the admin perform token entry inside a worker-controlled browser session? This decides what `secretRef` points to (browser storage state file vs cookie jar) and where encryption happens.
2. **Real-portal row extraction (blocks PR5):** `readRows` currently requires `data-rd-sync-column` attributes that the real portal will not have. Decision needed: map by column header text ("Fecha posteo", "Monto"...), by column index from the profile, or inject attributes during navigation. Header-text mapping is recommended (resilient to column reorder) but needs a captured HTML snapshot of the real results table to validate.
3. **Same-day identical transactions (blocks PR7 dedup constraint):** does the Popular results table expose any per-row unique value (sequence, internal id, exact timestamp) beyond date/amount/description/reference? If yes, it must join the `sourceHash` inputs; if no, the business must accept that identical same-day rows deduplicate.
4. **Redis on the local server (blocks PR8):** is installing Redis on the current local server acceptable now, or should PR8 wait for the VPS? PR4.4's in-process consumer covers the interim either way.

---

## 10. Final Recommendation

**Continue as-is — do not refactor.** The architecture is sound; cross-examination *refuted* the claims that DI was broken, that balances could leak, or that the state machine was unimplemented. What's missing is runtime wiring, not redesign.

**Split PR4 further — yes.** The remaining PR4 scope ("run now + ingestion + email alerts") is 4 distinct concerns. Ship it as PR4.1 → PR4.4 micro-slices as specified above; each is independently green and reviewable under 400 lines.

**Do not change product decisions.** Popular-first, email alerts, local-server-first, date-based current-day extraction, account-number-visible/balance-hidden — all are correctly reflected in code and specs.

**Fastest safe path to MVP:** PR4.1 (hours) → PR4.2 + PR4.3 (a day) → PR4.4 (a day) → answer open questions 1-2 with a real-portal HTML capture session → PR5 + PR6 (the genuinely new engineering) → PR7. At that point the product does its job end-to-end on the local server: admin establishes a session, runs ingest on demand, transactions persist deduplicated, employees see them, failures email the admin, and everything is audited. Everything after (BullMQ, ERP API, VPS, 3 banks) is hardening and scale, not existence.
