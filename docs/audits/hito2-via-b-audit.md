# Hito 2 — Via B Scraper & Session Monitoring: Audit Dossier

> **Audience:** an independent expert agent/reviewer auditing the work on branch
> `codex/hito2-run-now-ingestion-alerts`.
> **Purpose:** every claim below is meant to be verified against the code and tests.
> File references use `path:line` where stable; otherwise they name the function.
> **Generated:** 2026-06-13. **Author:** implementing agent (Claude).

---

## 0. How to use this document

This dossier maps each unit of work to **what changed, why, where, how it was
verified, and what to scrutinize**. Section 9 is a concrete audit checklist.
Do not trust the prose — re-run the commands in §2 and read the cited files.

The branch is **green at the time of writing**: `pnpm test` → 332 passed (52
files), `pnpm typecheck` → clean, `pnpm lint` → clean.

---

## 1. Product model (read this first — it explains every design choice)

RD-Sync is a **private, read-only** bank-transaction visibility dashboard.
Hito 2 connects it to **Banco Popular Dominicano** (`ib.bpd.com.do`).

**"Via B" attach model (the central decision):** Banco Popular sits behind
Imperva bot protection that blocks browsers *launched* by automation at login.
The validated approach instead is:

1. A human admin launches Brave with `--remote-debugging-port=9222` and logs in
   manually (including MFA).
2. RD-Sync **attaches** to that already-authenticated session over the Chrome
   DevTools Protocol (CDP) and only **reads**.
3. If the session is unavailable or expired, every operation degrades to
   `needs_admin_action` and an email alert — it never attempts a login and
   never stores credentials.

Consequences that the auditor should hold as invariants:

- **No credentials or session secrets are stored anywhere** (this supersedes
  the original roadmap's `SecretProvider`/encrypted-restore idea — see §6).
- **Read-only by construction:** the page seam exposes no click/type/fill/submit
  surface beyond a single whitelisted dashboard account-row click; navigation is
  URL-only.
- **Data minimization:** account balances are never extracted, normalized, or
  rendered; the employee view shows movements without balances or full account
  numbers.

---

## 2. Branch & verification snapshot

```bash
git rev-parse --abbrev-ref HEAD     # codex/hito2-run-now-ingestion-alerts
git log --oneline main..HEAD        # 19 commits (see §3)
pnpm test                            # 332 passed (52 files)
pnpm typecheck                       # tsc --noEmit, exit 0
pnpm lint                            # eslint . --max-warnings=0, exit 0
git diff --stat main...HEAD          # 49 files, ~6306 insertions / 165 deletions
```

Stack: Next.js 16 (App Router, Turbopack) + React, TypeScript strict ESM
(`"type": "module"`), pnpm, vitest, Node 24. Runtime dep added for the scraper:
`playwright-core` (no browser download).

Working tree at audit time: `next-env.d.ts` modified (Next-generated churn,
not committed); `docs/fable5-audit-roadmap.md` untracked (the original roadmap,
intentionally not committed yet). This dossier adds `docs/audits/`.

---

## 3. Commit map (19 commits, oldest → newest)

**Foundation — PR4.x (run-now → ingestion → alerts), built in prior sessions:**

| Commit | Summary |
|--------|---------|
| `53aceea` | feat(scrape-runs): schedule admin run now |
| `32d905a` | feat(scrape-runs): expose run now endpoint |
| `daf2548` | feat(scrape-runs): wire retry run action |
| `ba12a78` | chore(gitignore): ignore local engram metadata |
| `d5491a5` | fix(scrape-runs): harden run-now ids, queue contract, and preview gating (PR4.1) |
| `a2aa5ed` | feat(scrape-runs): add run lifecycle audit events (PR4.2) |
| `0c647e5` | chore(gitignore): ignore local bank portal captures |
| `720f45b` | feat(worker): add email admin alert sink (PR4.3) |
| `3f35dff` | feat(worker): consume queued ingestion jobs in process (PR4.4) |

**PR5 — Popular CDP scraper (Via B):**

| Commit | Summary |
|--------|---------|
| `f991e0c` | feat(scraper): add popular portal navigation and header-mapped extraction |
| `d1db049` | feat(scraper): wire cdp-attached popular scraper behind env flag |
| `d4ba141` | fix(bank-adapters): strip real account identifiers and balance from committed code |
| `c8277d3` | feat(scraper): warm up account context and settle table reads (live-calibration amendment) |

**PR6 — Bank session health monitoring:**

| Commit | Summary |
|--------|---------|
| `b9cedb0` | feat(alerts): add session attention to admin alert sink |
| `60e7b91` | feat(bank-sessions): add session health check and expiry monitor |
| `02fac50` | feat(bank-sessions): expose status api, monitor wiring, and browser runbook |
| `5a6ac0a` | test(alerts): cover session attention email shape |

**Cross-cutting fixes (this session):**

| Commit | Summary |
|--------|---------|
| `8db1eac` | fix(api): share in-memory defaults across dev module graphs |
| `71cedcc` | fix(transactions): derive id from source hash to avoid collisions |

---

## 4. Data flow (end-to-end)

```
POST /api/scrape-runs/run-now            (admin, trusted headers)
  → scheduleAdminIngestionRunNow         (creates queued run, audit: scheduled)
  → InMemoryScheduledIngestionQueue      (jobId = runId)
  → InMemoryIngestionConsumer.drainPending (fire-and-forget after 202)
  → createIngestionProcessor             (markRunning, audit: started)
      → IngestionScraper.collect()        ← resolveDefaultScraper() picks impl
          (popular-cdp): connectOverCDP → contexts()[0].newPage()
            → collectPopularPortalRows: dashboard warm-up click → transactions URL
              → settle reads → header-whitelist extraction → PopularTransactionRow[]
            → parsePopularTransactionRows → BankMovement[]
      → status "collected"  → transactions.upsertMany (dedup by sourceHash)
                            → markSucceeded, audit: succeeded
      → status "needs_admin_action" → markNeedsAdminAction, alert email, audit
      → thrown error → markFailed (redacted), alert email, audit
GET /api/transactions  /  /transactions (page)  → read normalized movements
GET /api/bank-sessions/status            → live session probe + monitor state
Background: createBankSessionMonitor.tick() every N ms → transition-only alerts
```

The scraper contract is `IngestionScraper { collect(): Promise<ScrapeCollectionResult> }`
(zero-arg; everything closure-captured). `ScrapeCollectionResult.status` is
`"collected" | "needs_admin_action"`; hard failures throw and the processor
redacts + marks failed.

---

## 5. Per-unit audit

### 5.1 PR5 — Popular CDP scraper

**Files:** `src/worker/scraper/navigation/popular.ts` (+ `.test.ts`),
`src/worker/scraper/navigation/popular-cdp.ts` (+ `.test.ts`),
`src/app/api/scrape-runs/consumer-defaults.ts`,
`src/modules/bank-adapters/popular.ts` (+ `.test.ts`).

**Key pieces:**

- `buildPopularTransactionsUrl` / `formatPopularPortalDate`: builds
  `/accountdetails/transactions?...` with dates `dd/mm/yyyy` URL-encoded `%2F`,
  computed in `America/Santo_Domingo` (fixed UTC-04:00, no DST). ISO dates
  render the portal error page — this was empirically confirmed.
- `PopularPortalPage` seam: `goto / currentUrl / waitForVisibleText /
  readResultsTable / openDashboardAccount / pause`. **No type/fill/submit.**
- `collectPopularPortalRows`: warm-up (dashboard → account-row click) → per-page
  loop (navigate, login-redirect detection, settle read, paginate while
  `rowCount === itemsPerPage`, `maxPages` cap).
- `HEADER_WHITELIST` (popular.ts): maps header **text** → field. **"Balance" is
  deliberately absent**, making balance extraction structurally impossible. The
  header scan uses `thead tr > *` (both `th` and `td`) because the last two
  headers ("Ver imagen"/"Detalle") are `td[scope=col]` — a `th`-only scan
  silently misaligns columns.
- `createPopularCdpScraper`: lazy `await import("playwright-core")` **inside**
  `collect()` (never at module load — vitest/build safety); page created from
  `browser.contexts()[0].newPage()` (the human session) with `browser.newPage()`
  fallback; cleanup in `finally` (page, then browser handle — detaches without
  closing the human's windows); connect failure → `needs_admin_action`
  (returned, not thrown).
- Env wiring (`consumer-defaults.ts`): `RD_SYNC_SCRAPER === "popular-cdp"` wins
  over `RD_SYNC_DEV_PREVIEW`.

**Privacy hardening (`d4ba141`):** the original committed `popularPortalFixture`
contained **real** account data. It was sanitized: account number →
`0000000000`, fingerprint → `popular-0000000000`, fully synthetic rows, the
`balance` field **removed from the `PopularTransactionRow` interface**, and
parser error messages no longer interpolate raw cell values.
⚠️ The real account number **remains in git history** from earlier commits
(history was not rewritten — private repo; user's decision).

**Verify:** read the two `.test.ts` files; confirm the th/td quirk has a real
regression test via `extractResultsTableFromDocument` (pure DOM function,
exported for unit testing — not a tautology over a hand-built constant).

**Scrutinize:** `extractResultsTableFromDocument` (pure, unit-tested) and the
inline `page.evaluate` body in `CdpPopularPortalPage.readResultsTable` duplicate
the extraction logic and must stay in sync (a comment says so — there is no
compile-time guarantee). This is the highest-value thing to challenge.

### 5.2 PR5 live-calibration amendment (`c8277d3`)

Three changes proven against the live portal (via a temporary read-only CDP
probe, since deleted):

1. **Warm-up required:** cold URL navigation always renders "Algo salió mal".
   The SPA account context is in-memory only; it is established by clicking the
   dashboard row where `Producto === "Corriente"` **and** `Moneda === "RD$"`
   (exact match — substring matching hits the savings alias "Ahorros o
   Corriente" and selects the wrong account). `openDashboardAccount` scopes to
   `table.w-full` and passes values as `evaluate` args (no string interpolation).
2. **Settle reads:** the portal renders the header and "Mostrando 0 resultados"
   ~4.5s *before* data arrives. `collectPopularPortalRows` polls until the row
   count stabilizes; a **zero** result is accepted only after a floor (default
   ~8s), with a cap (default ~25s, re-checked after the pause). This fixes a
   false-empty-day bug that the first PR5 cut would have shipped.
3. **`itemsPerPage` default 20 → 100** (proven honored: a May query returned 49
   rows in one page); pagination remains a fallback.

**Scrutinize:** the settle-loop timing tests. The judge in review flagged that
the zero-floor test relies on wall-clock spin rather than an injected clock —
the timestamp uses an injectable `clock`, but the floor elapsed-time check uses
real `Date.now()`. Confirm this is acceptable (tests pass fast in practice) or
flag it for a clock-injection refactor.

### 5.3 PR6 — Bank session health monitoring

**Files:** `src/modules/bank-sessions/index.ts` (+ `.test.ts`),
`src/app/api/bank-sessions/defaults.ts` (+ `.test.ts`),
`src/app/api/bank-sessions/status/route.ts` (+ `.test.ts`),
`src/worker/alerts/email-alert-sink.ts`, `src/worker/queues/index.ts`
(AdminAlertSink interface), `scripts/launch-bank-browser.ps1`,
`docs/runbooks/bank-session.md`.

**Key pieces:**

- `BankSessionStatus = "active" | "expired" | "browser_unavailable"`.
- `BankSessionCheckResult.safeSummary` is one of **exactly three fixed strings**
  (`index.ts:38-40`) — no URL/account/error interpolation ever.
- `checkPopularSessionHealth(page: SessionProbePage, ...)`: `SessionProbePage`
  is a **narrower** read-only interface (`goto/currentUrl/waitForVisibleText`
  only — no read/click/pause). Logic: dashboard goto → redirect ⇒ `expired`;
  "Producto" not visible ⇒ `expired`; else `active`.
- `createCdpSessionChecker`: mirrors the scraper's connect/cleanup lifecycle;
  connect failure ⇒ `browser_unavailable` (never throws).
- `createBankSessionMonitor`: **transition-only alerting** — alerts fire only
  entering a bad state from `null`/`active` (the `wasBad` guard prevents both
  sustained-bad re-alerts and bad↔different-bad flapping spam), and on recovery
  to `active`. Audit events on transitions only
  (`bank_session.expired/unavailable/restored`, actor `system:session-monitor`).
  Alert/audit failures never break `tick`. Injectable scheduler + clock so tests
  never wait real time; `start` idempotent; `stop` clears.
- `GET /api/bank-sessions/status`: same auth as run-now (see §6); returns a live
  check + monitor state. Env: `RD_SYNC_SESSION_MONITOR=enabled`,
  `RD_SYNC_SESSION_CHECK_INTERVAL_MS` (default 300000, clamped min 60000).

**Live-validated:** `401` without auth; with admin headers, returned
`{"session":{"status":"expired"/"active",...},"monitor":{"enabled":true,...}}`
truthfully across an expire→re-login cycle.

**Scrutinize:** the transition matrix in `bank-sessions.test.ts` (null-initial,
flapping, recovery). Confirm `wasBad` actually blocks bad→different-bad
re-alerting. Also confirm the PowerShell launcher quotes `--user-data-dir`
against spaces in `%LOCALAPPDATA%` (a real bug the reviewer caught and fixed).

### 5.4 Dev module-graph singleton fix (`8db1eac`)

**Problem (verified live):** Next dev (Turbopack) compiles RSC pages and API
route handlers into **separate module graphs**, duplicating module-level
in-memory singletons. The `/transactions` page rendered empty while
`/api/transactions` held the data; two graphs could also start two
session-monitor interval timers (→ duplicate alert emails).

**Fix:** anchor every in-memory default on `globalThis` (`__rdSync*` keys) —
the standard Next dev-singleton pattern. Files:
`src/app/api/{transactions,scrape-runs,audit,bank-sessions}/defaults.ts`,
`consumer-defaults.ts`. The session monitor uses an `in` sentinel (not `??=`)
because `null` (disabled) is a valid stored value. New test:
`src/app/api/defaults-global-sharing.test.ts` (uses `vi.resetModules` +
dynamic import to simulate two graphs).

**Scrutinize:** confirm no public export names/signatures changed, only
construction. Note: this is a **dev-ergonomics** fix; production (`next start`)
has a single graph. PR7 (Prisma) supersedes it for data durability but the
monitor/consumer anchors stay valuable (single-timer guarantee).

### 5.5 Transaction id collision fix (`71cedcc`)

**Problem:** `createSyntheticId` hashed only
`bankId|accountFingerprint|postedAt|amount`. Two same-day movements of equal
amount (real case 2026-06-12: a credit and a debit of 5424.00) produced the
**same id** but distinct `sourceHash`es. Symptoms: React duplicate-key warning
in `/transactions`; and worse, `updateReviewState` (matches by id,
first-match-wins) could mutate the **wrong** record.

**Fix:** `normalizeBankMovement` now computes `sourceHash` first from an
`identity` object, then `id = options.id ?? createSyntheticId(sourceHash)`
(hex slice of the source hash, which already covers
direction/reference/concept/originator). `createSourceHash` does not depend on
`id`, so the reorder is safe.

**Verify:** `transactions.test.ts` — the `updateReviewState` test went RED
("expected debit, received credit") before the fix, proving the wrong-record
mutation. Ids are **in-memory only today**, so the derivation change carries
**zero migration cost** — this was intentionally landed before PR7.

---

## 6. Security & privacy properties (and where to verify each)

| Property | Where to verify | Status |
|----------|-----------------|--------|
| No credentials/secrets stored | grep repo for secret handling; no SecretProvider exists | ✅ by design |
| Read-only seam (no mutation surface) | `PopularPortalPage` / `SessionProbePage` interfaces | ✅ no type/fill/submit |
| Balance never extracted | `HEADER_WHITELIST` omits "Balance"; `PopularTransactionRow` has no `balance` | ✅ structural |
| Balance/account hidden in UI | `toDashboardTransaction`, `/transactions` page | ✅ |
| Fixed safe error strings (no interpolation) | `safeSummary` constants; `needs_admin_action` summaries | ✅ |
| Error redaction on failure path | processor `markFailed` → `redactDiagnosticText` | ✅ |
| Synthetic fixtures only in committed code | `popularPortalFixture` | ✅ (history caveat below) |
| `.captures/` (real HTML) gitignored | `.gitignore` | ✅ |

**Known security gaps (intentional, scoped to later PRs):**

1. **Trusted-header auth is unverified.** `resolvePrincipalFromTrustedHeaders`
   (`src/modules/auth/index.ts`) trusts `x-rd-sync-user-id` / `x-rd-sync-role`
   headers with no signature/verification. This is the planned **PR9** auth
   gate. Today it assumes a trusted reverse-proxy boundary that does not yet
   exist. **The `/transactions` page itself is currently ungated.**
2. **Real account number in git history** (pre-`d4ba141` commits). Not rewritten.
3. **Dev preview bypass** (`RD_SYNC_DEV_PREVIEW`) is gated on
   `NODE_ENV !== "production"` — confirm this gate holds on every route that
   honors it (run-now route + bank-sessions status route have explicit
   production-gate tests; the admin scrape-runs page uses the same pattern).

---

## 7. Configuration (environment variables)

Agents never edit `.env`; these are set by the operator. Names verified in code.

| Var | Effect | Default |
|-----|--------|---------|
| `RD_SYNC_SCRAPER` | `popular-cdp` selects the real CDP scraper | unset → stub `needs_admin_action` |
| `RD_SYNC_CDP_URL` | CDP endpoint of the human Brave session | `http://localhost:9222` |
| `RD_SYNC_DEV_PREVIEW` | `enabled` → fixture scraper + preview principal + seed (non-prod only) | `disabled` |
| `RD_SYNC_ALERT_SMTP_URL` | SMTP URL for the email alert sink | unset → console sink |
| `RD_SYNC_ADMIN_EMAIL` | alert recipient | unset → console sink |
| `RD_SYNC_SESSION_MONITOR` | `enabled` starts the background monitor | disabled |
| `RD_SYNC_SESSION_CHECK_INTERVAL_MS` | monitor poll interval | 300000 (min 60000) |
| `RD_SYNC_E2E_FIXTURES` | `enabled` seeds E2E transaction fixtures | disabled |
| `DATABASE_URL` | Prisma (schema exists; **not yet used at runtime** — PR7) | — |
| `NODE_ENV` | gates the dev preview bypass | — |

---

## 8. Live E2E verification (requires portal access)

For an auditor with the admin's machine + Brave session:

1. Launch the dedicated browser: `scripts/launch-bank-browser.ps1` (or Brave
   with `--remote-debugging-port=9222`), log in to Banco Popular (+MFA).
2. `pnpm dev` (restart after any code change — module singletons are not
   hot-reloaded).
3. **Check session first:** `GET /api/bank-sessions/status` with headers
   `x-rd-sync-user-id: admin-local`, `x-rd-sync-role: admin` → expect
   `status: "active"`. If `expired`/`browser_unavailable`, re-login before
   proceeding (do not iterate against a logged-out portal).
4. `POST /api/scrape-runs/run-now` with the same headers → `202`.
5. After ~50s: `GET /api/transactions` → movements of the day, **no `balance`
   field**, all `postedAt` = today. Re-run → 0 duplicates (sourceHash dedup).
6. Open `/transactions` → rows render; **no React duplicate-key warning** in the
   console (the `71cedcc` fix).

**Operational facts learned in live runs:** the portal session expires after a
short inactivity window (well under 30 min); a server restart wipes all
in-memory data (no persistence until PR7); each failed/needs-admin run with SMTP
configured sends a real alert email.

---

## 9. Audit checklist (concrete asks for the expert reviewer)

- [ ] **Extraction sync risk:** `extractResultsTableFromDocument` vs the inline
      `readResultsTable` `page.evaluate` body — can they drift? Propose a way to
      share one source of truth, or accept the documented-comment mitigation.
- [ ] **Settle loop:** confirm termination (cap respected after the post-pause
      re-check), no infinite loop, and that the floor only gates zero-row
      results. Decide if the wall-clock dependency in the zero-floor test is
      acceptable.
- [ ] **Transition alerting:** prove the `wasBad` guard blocks both
      sustained-bad and bad↔different-bad re-alerts; confirm recovery alerts fire.
- [ ] **CDP cleanup:** page-then-browser close in `finally` on every path
      (success, collectRows throw, parser throw, connect failure); confirm the
      human's existing pages are never closed.
- [ ] **Auth parity:** run-now and bank-sessions routes — 401 (no principal) vs
      403 (wrong role); preview bypass blocked when `NODE_ENV=production`.
- [ ] **Data minimization:** trace any path that could surface a balance or full
      account number to the employee view; confirm none exists.
- [ ] **Safe strings:** grep every `safeSummary`/`safeErrorSummary` producer for
      interpolation of URLs/accounts/exception text.
- [ ] **Dev-singleton fix:** confirm no public API changed; confirm the monitor
      cannot start two timers across module graphs.
- [ ] **id derivation:** confirm distinct ids for same-day same-amount opposite
      directions, and that `updateReviewState` targets the right record.
- [ ] **No `vi.mock` / ESM discipline / fakes-after-describes** conventions held
      in new tests; no existing test weakened.

---

## 10. Known limitations & what PR7+ addresses

- **Persistence:** all repositories are in-memory; a restart loses data.
  **PR7 (Prisma)** wires the three repos behind the existing interfaces with a
  `sourceHash` unique constraint. `prisma/schema.prisma` exists and the client
  generates to `src/generated/prisma/` (gitignored); **repos are not yet wired**.
  PR7 also removes the need for the dev-singleton data sharing.
- **Auth:** trusted headers are unverified — **PR9** auth gate.
- **Queue:** in-process consumer only — **PR8** BullMQ + Redis (separate worker).
- **History backfill:** the scraper extracts the current day; a date-range
  backfill is feasible (proven: 49 rows for May) but only worthwhile once
  persistence exists.
- **Roadmap pivot:** the original PR6 (`SecretProvider` + encrypted session
  restore) is **obsolete under Via B** — no secrets are stored. If the project
  ever moves to worker-controlled login (Via A), that design revives.

---

## 11. PR7 — Prisma persistence (addendum, added after §1–§10)

> This section supersedes the "not yet wired" claim in §10 and the 332-test
> count in §2. Commits: `519ecca` (schema), `20301d7` (repositories + wiring).
> Test count is now **358 passed + 25 skipped** (the 25 are the gated Prisma
> contract tests). **A migration against a live database has NOT been run yet —
> see "Pending" below.**

**Design decision (user-approved): relax the schema to the opaque-string domain.**
The schema modeled `bankId`/reviewer/audit-actor as FKs to `Bank`/`User`, but the
domain uses opaque strings with no populated Users. Chosen over (a) provisioning
fake Users for every reviewer/actor string, and (b) scoping PR7 to
Transaction+ScrapeRun only.

**Schema changes (`prisma/schema.prisma`, commit `519ecca`):**
- `Transaction`: dropped `reviewedById` + the `reviewedBy User?` relation; added
  a plain `reviewedBy String?` column.
- `AuditEvent`: dropped the `actor User?` relation (kept `actorId`/`actorRole`
  as plain `String?` scalars).
- Dropped the `EncryptedSessionRef` model entirely (dead under Via B) and the
  `Bank.sessions` back-reference.
- Removed the dangling `User.reviews` / `User.auditEvents` back-relations.
  `User`/`Role`/`UserRole` are **kept** (seeded roles, future PR9 auth).
- Kept the `Bank` FK on `Transaction`/`ScrapeRun`; repos auto-provision the Bank
  by `code`. `BankSessionStatus` enum kept (model-less) with an explanatory
  comment.

**New module `src/modules/persistence/` (commit `20301d7`):**
- `prisma-client.ts`: globalThis-anchored, **lazily** constructed `PrismaClient`
  (PrismaPg adapter, `DATABASE_URL` read at access time — never at import, so
  importing is always safe). Plus domain↔Prisma enum mappers and
  `upsertBankByCode` (Bank auto-provision).
- `prisma-transaction-repository.ts` / `prisma-scrape-run-repository.ts` /
  `prisma-audit-sink.ts`: implement the **exact existing interfaces**.
  - `bankId` round-trips via `Bank.code` (consumers never see the cuid).
  - `amount` ↔ `Decimal(18,2)`, returned via `toFixed(2)` to equal
    `normalizeAmount` output.
  - dedup via `createMany({ skipDuplicates: true })` on the `sourceHash @unique`
    constraint; `inserted = count`, `skipped = records.length - inserted`.
  - not-found semantics matched (`updateReviewState` → null; `createQueued`
    duplicate / `mark*` missing → throw, same messages as in-memory).
- Env-switch in `src/app/api/{transactions,scrape-runs,audit}/defaults.ts`:
  `DATABASE_URL` set → Prisma repo, else in-memory; both anchored on globalThis.

**Contract tests (`src/modules/persistence/contracts/*.contract.ts`):** one
shared suite per repo, run against the **in-memory** impls always
(`in-memory-contracts.test.ts`) and against **Prisma** only when
`RD_SYNC_TEST_DATABASE_URL` is set (`prisma-contracts.test.ts`,
`describe.skipIf`). Includes a `sourceHash` unique-constraint dedup test and the
same-day same-amount review-target test. Default `pnpm test` is **DB-free**
(the 25 Prisma cases skip).

**To exercise the Prisma side (developer command):**
```bash
# Use a THROWAWAY database, never the dev DATABASE_URL.
RD_SYNC_TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/rdsynctest" pnpm db:push
RD_SYNC_TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/rdsynctest" pnpm test
```
*(The contract test sets `DATABASE_URL = RD_SYNC_TEST_DATABASE_URL` in `beforeAll`
so the repos' `getPrismaClient()` targets the test DB; restored in `afterAll`.)*

**Scrutinize (highest value):**
- The Prisma repos have **only been verified to compile and pass typecheck/lint**
  — the 25 contract tests against a real Postgres **have not been executed**
  (the local DB was down at audit time). The repos' actual runtime behavior
  against Postgres is unverified. **This is the #1 thing to verify.**
- `list()` Prisma where/order must reproduce `filterTransactions` /
  `filterScrapeRuns` exactly — confirm against the contract.
- `scrapeRunId` is a nullable FK in Prisma but a free string in-memory: a
  non-existent `scrapeRunId` throws P2003 in Prisma but is silently stored
  in-memory (a known behavioral difference the judge flagged as low; documented,
  not yet covered by a contract test).
- The judge's two high findings were fixed (amount-filter `undefined` OR-branch;
  the test-DB env wiring). Re-confirm both.

**Pending (requires a running PostgreSQL):**
1. Run the initial migration (`prisma migrate dev` / `db push`) against the dev
   DB — **no migration history exists yet** (`prisma/migrations/` absent).
2. Execute the 25 gated Prisma contract tests against a throwaway test DB.
3. Live persistence proof: with `DATABASE_URL` set, do a real `run-now`, restart
   the server, confirm transactions survive (the acceptance criterion).

**Env var added:** `RD_SYNC_TEST_DATABASE_URL` (test-only; points at a throwaway
DB; never the dev `DATABASE_URL`).
