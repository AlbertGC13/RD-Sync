# RD-Sync Scraper Completion Roadmap (PR4.3 → PR6)

> Planning date: 2026-07-02 · Branch context: tracker `feature/multi-bank-auto-login`; PR #22 / PR4.2 merged after fresh 4R + Judgment Day approval · Method: CodeGraph structural analysis + OpenSpec artifacts (`openspec/changes/multi-bank-auto-login/{design,tasks,spec}`) + Engram session history.
>
> Companion artifact: `docs/fable5-audit-roadmap.md` (audit era, PR1–PR9 of the previous cycle — do NOT confuse its PR numbers with this document's). This roadmap covers ONLY the remaining `multi-bank-auto-login` slices: PR4.3–PR4.9, PR5 unblockers, PR6.
>
> This is a documentation-only plan. It does not change product code, and it never proposes bypassing authentication, MFA, CAPTCHA, step-up challenges, security questions, or third-party protection layers. Every flow that meets a protected step MUST stop safely (`needs_admin_action`) and wait for operator/admin action.

---

## 1. Executive Summary

**Where we are.** The foundation for multi-bank auto-login is merged and verified:

- **PR4A1–PR4A3 (merged):** `AutoLoginLock` contract with bounded TTL, fencing tokens, CAS semantics (`src/modules/bank-auto-login-lock/index.ts`); Redis `LockStore` adapter with atomic Lua scripts (`redis-store.ts`); production wiring via `defaultAutoLoginLock` singleton with fail-closed Redis policy — bounded retries, 5s timeouts, `null` (→ manual-only) when `RD_SYNC_REDIS_URL` is unset (`defaults.ts`).
- **PR4.2 / PR #22 (merged, 4R + Judgment Day approved):** Prisma models `BankAutoLoginConfig` (`autoLoginEnabled` default **false**, breaker `closed|open` only — NO half_open) and `BankAdapterConfig` (`scrapingEnabled` default **true**), migration `20260702000000_add_bank_auto_login_and_adapter_config`, schema contract tests.
- **Earlier PRs (merged):** adapter registry with fail-closed unknown-bank routing, per-bank CDP loopback enforcement (`assertCdpLoopback`), browser semaphore/backpressure, AES-256-GCM credential vault + admin API + rate limiting, canonical audit action constants (`src/modules/audit/bank-actions.ts` — already includes every `bank_autologin.*`, `bank_breaker.*`, `bank_killswitch.*`, `bank_adapter.*`, `bank_session.*` action PR4.8 needs), session health checker for Popular, poll-based `BrowserCapacityMonitor` (no external metrics backend, by explicit decision).

**What remains.** Config repositories + conservative breaker (PR4.3), the session-recovery state machine + `LoginMutationGuard` (PR4.4), stable `expiredEventId` (PR4.6), scrape-time trigger wiring (PR4.5), Popular enablement + portal-drift fixture (PR4.7), admin endpoints + metrics/alerts (PR4.8), the cross-cutting PR4 test suite (PR4.9), three PR5 unblockers, and finally Banreservas/BHD enablement (PR6).

**One material sequencing correction.** The numbered list places PR4.5 (trigger wiring) before PR4.6 (stable `expiredEventId`), but the lock is keyed by `bankCode + expiredEventId` — the trigger cannot acquire a correct lock until a stable event identity exists. This roadmap keeps the PR *names* but recommends executing **4.6 before 4.5** (see §3 and Open Questions).

**Safety posture preserved throughout:** auto-login stays disabled by default (`autoLoginEnabled=false` at the DB level); MFA/challenge/unknown/incompatible flows STOP and surface `needs_admin_action`; unknown explicit bank codes fail closed with no Popular fallback; no secrets/Redis URLs/DB URLs/internal errors ever reach browser responses or operator-facing copy; Spanish operator copy stays professional and fixed-string (no interpolated diagnostics).

---

## 2. Recommended PR Sequence

| Order | Slice | Name | Risk | Gate |
|---|---|---|---|---|
| 0 | PR4.2 | (pre-req) Merge PR #22 after Judgment Day | HIGH | fresh 4R ✅ + JD pending |
| 1 | PR4.3 | Config repositories + conservative breaker policy | HIGH | fresh 4R + JD |
| 2 | PR4.4a | `LoginMutationGuard` + pre-submit compatibility guard (pure) | HIGH | fresh 4R + JD |
| 3 | PR4.4b | Auto-login state machine core (pure, injected deps) | HIGH | fresh 4R + JD |
| 4 | PR4.6 | Stable `expiredEventId` in bank sessions | HIGH | fresh 4R + JD |
| 5 | PR4.5 | Scrape-time expired-session trigger wiring | HIGH | fresh 4R + JD |
| 6 | PR4.7 | Popular enablement + portal-drift fixture | HIGH | fresh 4R + JD |
| 7 | PR4.8a | Admin endpoints (auto-login toggle, breaker reset, adapter toggle) + audit | HIGH | fresh 4R + JD |
| 8 | PR4.8b | `bank-metrics.ts` + concrete alert thresholds | HIGH | fresh 4R + JD |
| 9 | PR4.9 | Cross-cutting PR4 integration test suite | HIGH | fresh 4R + JD |
| 10 | PR5-U1 | Per-bank adapter kill-switch enforcement in scrape path | Med | full gates |
| 11 | PR5-U2 | Incompatible pre-submit blocks (multi-bank fixture harness) | Med | full gates |
| 12 | PR5-U3 | Portal drift tests for Banreservas/BHD (read-only recon fixtures) | Med | full gates |
| 13 | PR5 | Banreservas/BHD read-only adapters (existing tasks 5.1–5.4) | Med | full gates |
| 14 | PR6 | Banreservas/BHD auto-login enablement | Med | full gates |

Every PR: `pnpm test && pnpm lint && pnpm typecheck && git diff --check`, clean child diff against its base branch (feature-branch-chain: child PR targets the previous child's branch; only the tracker merges to main), ≤400 changed lines unless `size:exception`, tests + docs inside the same work unit. All PR4.x slices are HIGH RISK → fresh 4R review + Judgment Day before merge, no exceptions.

---

## 3. Why PR4.6 must execute before PR4.5

The canonical design (design.md, "Lock key identity" decision) keys the lock on `bankCode + expiredEventId`, where `expiredEventId` is *stable per expired transition and retained until restore*. That stability is what de-duplicates login attempts across retries, concurrent workers, and consecutive runs. If PR4.5 ships first, the trigger would have to fabricate a per-run event id, which silently re-arms an attempt on every run — exactly the double-submit class the lock exists to prevent (breaker `maxAttemptsPerEvent: 1` also keys off the event).

Two acceptable resolutions (pick one, record it in the PR description):

1. **Recommended: reorder.** Land PR4.6 (event identity) first, then PR4.5 consumes it. No throwaway code.
2. **If order must be kept:** PR4.5 lands fully wired but *behaviorally inert* — the trigger requires a non-null `expiredEventId` from the session layer and skips to manual (`bank_autologin.skipped`, reason `no_event_id`) when absent. PR4.6 then activates it. This is safe (fail-closed) but ships dead-ish code for one PR.

Do **not** merge PR4.5 and PR4.6 into one PR to "solve" this — they touch different modules (`worker/scraper` + consumer vs `modules/bank-sessions`) and each needs its own focused 4R.

---

## 4. Slice Specifications

### PR4.3 — Config repositories + conservative breaker policy

1. **Purpose.** Give the runtime read/write access to the PR4.2 models and encode the conservative circuit-breaker policy as a pure, testable module. Nothing consumes them yet — this is plumbing with zero behavior change.
2. **Exact scope.**
   - `src/modules/bank-auto-login-config/repository.ts`: Prisma repo for `BankAutoLoginConfig` — `getByBankCode`, `upsertDefaults` (row auto-provisioning mirroring `upsertBankByCode`), `recordFailure` (increment count / set window start), `openBreaker`, `resetBreaker` (manual reset: state→closed, count→0, window cleared, `breakerLastResetAt`, `updatedBy`), `setAutoLoginEnabled`.
   - `src/modules/bank-adapter-config/repository.ts`: `getByBankCode`, `setScrapingEnabled` (+ `updatedBy`).
   - `src/modules/bank-auto-login-config/breaker-policy.ts`: pure policy — export the design constants verbatim (`maxAttemptsPerEvent: 1`, `failureWindowMs: 30*60*1000`, `openThreshold: 3`, `halfOpenProbes: 0`, `manualResetOnly: true`, `alertRepeatIntervalMs: 30*60*1000`) plus pure functions `shouldOpen(state, now)`, `canAttempt(state, now)`, `nextStateOnFailure(state, now)`. NO half-open, NO auto-close, ever.
   - In-memory repo fakes + contract test suites following `src/modules/persistence/contracts/*.contract.ts` pattern.
3. **Out of scope.** No wiring into the scrape path, no admin endpoints, no alerts (the "alert on open + ≤every 30min" emission belongs to PR4.8b; the policy module only exposes `alertRepeatIntervalMs`), no state machine.
4. **Files.** Create the two module dirs above + tests; possibly `src/modules/persistence/contracts/` additions. Inspect: `prisma/schema.prisma:207-231`, `src/modules/bank-credentials/repository.ts` (repo pattern to mirror), `src/modules/persistence/prisma-client.ts` (`upsertBankByCode`).
5. **Contracts.** Repos speak domain `bankCode` (`Bank.code`), never Prisma `Bank.id`. Breaker state is the string union `"closed" | "open"` — reject any other value at the repo boundary. All timestamps UTC `DateTime`. Reset requires an `updatedBy` actor id.
6. **Safety invariants.** `autoLoginEnabled` defaults false and this PR never flips it; manual reset is the ONLY transition open→closed; repos must not log row contents (rows contain no secrets, but keep the discipline); unknown bankCode → `null`/no-op, never auto-fallback.
7. **Test plan.** Contract suite over in-memory + Prisma implementations: default provisioning; failure accrual inside/outside the 30-min window (window restart on stale window); open at 3rd failure; `canAttempt` false while open regardless of elapsed time (no auto-close); manual reset clears window and count; `updatedBy` persisted. Pure policy: property-style edge cases around window boundaries with injected clock.
8. **Review risks.** Off-by-one on `openThreshold` (open at 3rd failure *within* window); window-restart semantics; accidental half-open creep ("retry after cooldown" is forbidden); Prisma optimistic-concurrency gaps on concurrent `recordFailure` (see Open Questions Q4).
9. **Dependencies.** PR4.2 merged (models + migration).
10. **Estimate.** ~350–430 lines. Fits under 400 if the contract suite is compact; if it overflows, split `bank-adapter-config` (trivial, ~80 lines) into a follow-up micro-PR rather than requesting an exception.
11. **Acceptance.** Both repos pass their contract suite against in-memory and Prisma backends; policy functions are pure (injected clock, no `Date.now()` inside logic); zero call sites in production code paths (verified by CodeGraph blast radius: only tests reference the new modules).

### PR4.4a — `LoginMutationGuard` + pre-submit compatibility guard

1. **Purpose.** Build the mutation firewall: the only component allowed to authorize a fill or submit on a bank page, plus the incompatible-flow detector that blocks before any credential touches the DOM.
2. **Exact scope.**
   - `src/worker/scraper/login-mutation-guard.ts`: `BankPortalConfig` interface (per design.md: `bankCode`, `baseUrl`, `loginPathAllowlist`, selectors incl. optional `mfaIndicatorSelector` / `incompatibleFlowSelector`, `dashboardPathIndicator`); `LoginMutationGuard` with `assertLoginPage` (parsed URL: HTTPS only, **exact origin** equality — no prefix/substring matching, path in allowlist), `beforeFill`, `beforeSubmit` (both re-check — navigation between fill and submit must be caught), `assertCompatiblePreSubmit` (if `incompatibleFlowSelector` matches → throw a typed error mapping to `needs_admin_action`; NO fill, NO submit).
   - Typed guard errors carrying only safe, fixed summaries (reuse the `safeErrorSummary` convention from `src/worker/scraper`).
3. **Out of scope.** State machine, lock usage, decryption, wiring, Popular's real `BankPortalConfig` values (that's PR4.7).
4. **Files.** Create guard + test. Inspect: `src/worker/scraper/index.ts` (`assertSafeReadSelector`, redaction conventions), `src/worker/scraper/browser-runtime.ts` (`assertCdpLoopback` style — this guard is its sibling for page URLs), design.md Interfaces block.
5. **Contracts.** Guard takes a `CdpPageLike`-narrow structural interface (only `currentUrl()` + selector-presence probe) so tests inject fakes with no Playwright. Guard NEVER performs the fill/submit itself — it only authorizes; the state machine (4.4b) owns actions.
6. **Safety invariants.** HTTPS mandatory (reject `http:` even on loopback — bank portals are remote); exact-origin equality defeats lookalike domains and open-redirect landings; re-check before fill AND submit; incompatible pre-submit means zero mutation. A guard failure is terminal for the attempt → `needs_admin_action`, never retry-into-submit.
7. **Test plan.** URL matrix: http rejected, subdomain lookalike rejected (`ib.bpd.com.do.evil.com`), userinfo trick rejected (`https://ib.bpd.com.do@evil.com`), port mismatch rejected, path outside allowlist rejected, redirect-after-fill caught by `beforeSubmit`; incompatible selector present → typed error and a spy proves no fill/submit callback ran; malformed URL → safe error (no raw URL echoed).
8. **Review risks.** URL parsing subtleties (userinfo, default ports, trailing slashes, case sensitivity of hostnames); allowlist matching must be exact-path or explicit-prefix — document which and test both sides of the boundary.
9. **Dependencies.** None beyond merged foundation. Parallelizable with PR4.3.
10. **Estimate.** ~230–300 lines. Fits.
11. **Acceptance.** 100% of the URL matrix green; mutation-spy tests prove the no-fill/no-submit property; no production call sites yet.

### PR4.4b — Auto-login state machine core

1. **Purpose.** Implement the orchestration skeleton from design.md as a pure module with every dependency injected — the machine that PR4.5 wires into the run flow.
2. **Exact scope.** `src/worker/scraper/auto-login.ts`: `runAutoLoginAttempt(deps, ctx)` implementing exactly: check `scrapingEnabled` → check breaker closed + `autoLoginEnabled` → `assertCdpLoopback` → `acquire(bankCode, expiredEventId)` (null → skip to manual, audit `bank_autologin.skipped`) → `ensureBrowser` (throttled → safe throttled outcome, release nothing acquired) → goto login page → `guard.beforeFill` → `assertCompatiblePreSubmit` → assert `adapter.bankCode === credential.bankCode` → decrypt (audit `bank_credential.decrypt_use`) → fill → `guard.beforeSubmit` → submit → detect outcome (`dashboard | mfa | unknown | redirect | incompatible`) → `succeeded` or `needs_admin_action` → **owner-only release in `finally`**. Failure paths feed `recordFailure`/`shouldOpen` from PR4.3. All state writes carry the `fencingToken` in audit metadata.
3. **Out of scope.** Wiring into consumer/worker (PR4.5), real portal config (PR4.7), admin endpoints, metrics emission beyond audit events.
4. **Files.** Create `auto-login.ts` + test. Inspect: `src/modules/bank-auto-login-lock/index.ts` (lock API), `src/modules/bank-credentials/service.ts` + `crypto.ts` (decrypt seam), `src/modules/audit/bank-actions.ts` (canonical actions — use these constants, never string literals), `src/worker/queues/index.ts` (`AdminAlertSink`, audit emission style with never-throw wrapper).
5. **Contracts.** `deps`: `{ lock: AutoLoginLock | null, autoLoginConfigRepo, adapterConfigRepo, credentials, guard, browser, auditSink?, alertSink?, clock }`. `lock === null` (Redis not configured) → skip to manual, `bank_autologin.skipped` with reason `lock_unavailable` — fail closed, never attempt without a lock. Outcome union: `{ kind: "succeeded" | "skipped" | "needs_admin_action" | "throttled", safeSummary }` — fixed strings only.
6. **Safety invariants.** MFA/challenge/unknown/redirect/incompatible → STOP, `needs_admin_action`, no retry, no alternative path — the machine must have NO branch that re-attempts a protected step; decrypt happens strictly after all guards pass and the plaintext never appears in errors, audits, or outcomes; single attempt per event (`maxAttemptsPerEvent: 1`); release only with the owned `leaseToken`; every early exit audits its reason with a canonical action.
7. **Test plan.** Table-driven path coverage: each gate short-circuits with the right audit action and NO downstream calls (spies on decrypt/fill/submit); lock-busy → skip; throttled → throttled; MFA detection → `needs_admin_action` + `bank_autologin.needs_admin_action`; success → `bank_autologin.succeeded` + release called with correct token; thrown mid-flight → release still called (finally) + `bank_autologin.failed`; breaker interaction: 3rd failure opens + `bank_breaker.opened`; fencing token present in guarded-write audit metadata.
8. **Review risks.** This is the highest-blast-radius file of the whole change: ordering of gates (config checks BEFORE lock acquisition to avoid burning lock TTL on disabled banks), release-on-all-paths, audit-never-throws (`try/catch` swallow, mirroring `emitAuditEvent` in `queues/index.ts`), plaintext lifetime (decrypt as late as possible, no intermediate storage).
9. **Dependencies.** PR4.3 (repos + policy), PR4.4a (guard).
10. **Estimate.** ~350–420 lines incl. tests. Tight — if it can't fit, move the outcome-detection helpers (`detectPostSubmitState`) into PR4.4a or a shared file within 4.4a's budget instead of taking an exception.
11. **Acceptance.** Path table fully green; mutation spies prove ordering; CodeGraph blast radius still shows zero production callers (wiring is 4.5).

### PR4.6 — Stable `expiredEventId` handling in bank sessions *(execute before PR4.5 — see §3)*

1. **Purpose.** Give each expired-session episode a single stable identity (UUID) that persists from the expired transition until the session is restored, so locks and breaker attempts de-duplicate across runs, retries, and processes.
2. **Exact scope.**
   - `src/modules/bank-sessions/expiry-episodes.ts`: a durable per-bank PostgreSQL episode record with stable expiry/run identity, idempotent audit-delivery markers, and identity-safe close.
   - No DB-to-queue publication, scrape-run claim, or consumer work belongs in this slice.
3. **Out of scope.** The scrape-time trigger itself (PR4.5), any auto-login invocation, and producer startup. The API process remains dormant.
4. **Files.** `src/modules/bank-sessions/index.ts`, `src/modules/persistence/prisma-bank-session-expiry-episode-repository.ts`, and PostgreSQL contract tests.
5. **Contracts.** `getOrCreate` elects one durable expiry-episode creation winner; canonical expiry/restoration audits use deterministic episode IDs and are acknowledged durably before restoration close. The creation winner makes one best-effort expiry-notification attempt, while the identity-safe close winner makes one best-effort restoration-notification attempt. Notification delivery and retry are not durable or exactly-once.
6. **Safety invariants.** Identity-safe close cannot remove a replacement episode. The episode identity is not caller-supplied.
7. **Test plan.** In-memory replica and retry contracts plus PostgreSQL winner, audit acknowledgement, identity-safe close, and cleanup/repeatability coverage.
8. **Review risks.** The monitor remains dormant until a dedicated lifecycle owner exists; publication is explicitly deferred. If PostgreSQL is unavailable and the process is lost before an episode is persisted, B1 cannot recover that observation; no publication or outbox mechanism is added to close this limit.
9. **Dependencies.** None on 4.3/4.4 (parallelizable), but PR4.5 depends on it.
10. **Estimate.** ~220–320 lines. Fits.
11. **Acceptance.** The completed B1 store contract is green on in-memory and PostgreSQL implementations; the monitor emits canonical session audit actions with stable ids; `browser_unavailable` does not clear an active event id. B2 publication/outbox/queue/consumer work remains explicitly deferred and unchecked.

**B1 review-unit note.** B1 is an approved size exception because the durable episode schema, atomic election, canonical audit acknowledgement, identity-safe retry/close behavior, PostgreSQL isolation evidence, and dormant composition form one correctness boundary. Splitting those pieces would prevent a reviewer from validating the exactly-once audit guarantee end to end. Its actual impact is limited to durable audit source state; it does not publish, enqueue, claim, lease, or consume work. Notifications remain best-effort winner attempts. B2 owns every publication/outbox/queue/consumer concern and is excluded from B1.

### PR4.5 — Expired-session trigger wiring during bank sync runs

1. **Purpose.** Connect the pieces: when a scrape run detects an expired session, invoke the PR4.4b state machine exactly once through the canonical scrape-time trigger, then continue or stop the run based on the outcome.
2. **Exact scope.**
   - `src/app/api/scrape-runs/consumer-defaults.ts` + the Popular CDP scraper path in `src/worker/scraper/`: when collection reports the session-expired condition, resolve `expiredEventId` via the PR4.6 store, call `runAutoLoginAttempt` with production deps (`defaultAutoLoginLock`, Prisma repos, credential service, guard with the adapter's portal config — inert until PR4.7 provides it), on `succeeded` retry collection ONCE within the same run; on any other outcome mark the run `needs_admin_action` with the existing safe summary conventions.
   - Default dependency assembly (a `defaults.ts` in the auto-login module or extension of consumer-defaults) following the `globalThis` env-switch singleton pattern.
3. **Out of scope.** Enabling Popular (config row stays `autoLoginEnabled=false`, so in production this wiring is dormant until PR4.7); UI changes; admin endpoints; run-now HTTP surface changes (throttle 503/Retry-After already specified for the sync path — verify nothing new leaks).
4. **Files.** Modify `src/app/api/scrape-runs/consumer-defaults.ts`, `src/worker/scraper/popular-cdp.*` (or wherever `collect()` surfaces the expired state), maybe `src/worker/queues/index.ts` (processor outcome plumbing). Inspect first with CodeGraph: `createPopularCdpScraper`, `ScrapeCollectionResult`, `resolveDefaultScraper` — confirm where "expired" is currently detectable inside a run.
5. **Contracts.** Trigger fires ONLY inside a run context (never from the monitor, never from HTTP); one auto-login attempt per run maximum; retry-after-success is a single bounded re-collection, not a loop. Job payload continues to carry `bankId` (canonical code) — `expiredEventId` is resolved server-side from the store, never from the job payload.
6. **Safety invariants.** All PR4.4b invariants inherited; additionally: a failed auto-login must not fail the whole run with a raw error — it degrades to `needs_admin_action` with the existing fixed Spanish-safe summaries; no new information in browser-facing responses (run status endpoint already projects a safe shape — keep `toSafeScrapeRunStatus` untouched or extend the projection test).
7. **Test plan.** Integration-style with injected fakes: expired → attempt → success → re-collect → run `succeeded`; expired → skip (lock busy / disabled / no event id) → run `needs_admin_action` + `bank_autologin.skipped`; expired → MFA → `needs_admin_action`, no retry; attempt throws → run fails safe, lock released; assert exactly ONE attempt per run even when re-collection reports expired again.
8. **Review risks.** Double-trigger (collection retry seeing expired again must NOT re-attempt); interaction with the browser semaphore (auto-login and collection share the bounded browser — ensure acquire/release pairing doesn't deadlock the semaphore: acquire once for the run, reuse the page); status conflation between `failed` and `needs_admin_action`.
9. **Dependencies.** PR4.3, PR4.4a, PR4.4b, PR4.6.
10. **Estimate.** ~260–360 lines. Fits.
11. **Acceptance.** With `autoLoginEnabled=false` (production default) behavior is byte-identical to today except a `bank_autologin.skipped(reason: disabled)` audit trail; the one-attempt-per-run property is test-enforced.

### PR4.7 — Popular session-recovery enablement + portal drift fixture

1. **Purpose.** Turn the machinery on for exactly one bank (Popular) behind the DB gate, and lock the portal contract with a drift fixture so silent portal changes fail safe instead of misbehaving.
2. **Exact scope.**
   - `src/modules/bank-adapters/popular.ts`: real `createAutoLoginStrategy()` returning Popular's `BankPortalConfig` (base URL `https://ib.bpd.com.do`, login path allowlist, username/password/submit selectors, MFA indicator, incompatible-flow selector, dashboard indicator `Producto`/`/dashboard` consistent with `checkPopularSessionHealth`); registry keeps the stub for other banks.
   - `src/worker/scraper/auto-login.portal-drift.test.ts`: Popular fixtures — pre-submit incompatible flow (assert NO fill/submit occurred) and post-submit unknown flow (assert `needs_admin_action`).
   - Enablement is OPERATIONAL, not code: document (runbook section in the PR) that an admin sets `autoLoginEnabled=true` for `popular` via the PR4.8 endpoint (or a guarded seed/script if 4.8 hasn't merged — see Dependencies).
3. **Out of scope.** Banreservas/BHD anything; admin endpoints; changing `SUPPORTED_RUN_NOW_BANK_CODES` (Popular is already there); metrics.
4. **Files.** Modify `popular.ts`, `registry.ts` (only if the adapter interface needs the `portalConfig` field added — add it as optional to avoid touching other adapters); create the drift test. Inspect: `src/modules/bank-sessions/index.ts` (selector/indicator parity with the session checker), `docs/recon/` if Popular selector notes exist.
5. **Contracts.** `BankPortalConfig` for Popular is THE single source of portal truth for guard + strategy + drift fixture — the fixture imports the same config object the runtime uses (no duplicated selectors that can drift apart).
6. **Safety invariants.** The PR merges with `autoLoginEnabled` still false everywhere (migration default) — enablement is a post-merge operator action with its own audit trail; drift fixture proves the incompatible path never mutates; selectors must not encode credentials or account data.
7. **Test plan.** Drift fixtures as above; config-parity test (guard accepts the strategy's own login URL; dashboard indicator matches the session checker's); registry still fails closed for unknown codes; `createAutoLoginStrategy` for OTHER registered banks still throws not-implemented.
8. **Review risks.** Selector fragility (document the recon source and date per selector); accidental enablement in a seed script (grep the diff for `autoLoginEnabled: true` — must appear ONLY in tests); parity between session-checker heuristics and portal-config indicators.
9. **Dependencies.** PR4.4a/b, PR4.5, PR4.6. Can merge before PR4.8; first production enablement then waits for 4.8's endpoint (recommended) — flipping the row by hand in the DB is the documented break-glass alternative, audited manually.
10. **Estimate.** ~240–340 lines. Fits.
11. **Acceptance.** All drift fixtures green; a full-chain test (fixture portal, fake lock, fake credentials) walks expired → auto-login → re-collect → success for Popular with `autoLoginEnabled=true` ONLY inside the test.

### PR4.8a — Admin endpoints + audit

1. **Purpose.** Give operators the safety controls: per-bank auto-login kill switch, breaker reset, and adapter (scraping) kill switch — each audited with canonical actions.
2. **Exact scope.**
   - `PATCH /api/bank-credentials/[bankCode]/auto-login` — body `{ enabled: boolean }` → `setAutoLoginEnabled`; audit `bank_killswitch.auto_login_enabled|auto_login_disabled`; success copy: "Auto-login desactivado" / "Auto-login activado".
   - `POST /api/bank-credentials/[bankCode]/reset-breaker` — manual reset; audit `bank_breaker.reset`; copy: "Interruptor restablecido" (confirm exact copy with product; keep fixed-string).
   - `PATCH /api/bank-credentials/[bankCode]/adapter` — body `{ enabled: boolean }` → `setScrapingEnabled`; audit `bank_adapter.enabled|disabled`; copy: "Adaptador desactivado" / "Adaptador activado".
   - All: `requireRole(principal, ["admin"])` (the codebase uses RBAC, not the capability system design.md mentions — follow the existing `bank-credentials/route.ts` pattern), `InMemoryRateLimiter` 10/min, safe error categorization 401/403/400/404/429/503, unknown bankCode → 404 fail closed (registry lookup — no row auto-creation for unknown banks).
3. **Out of scope.** Metrics/alerts (4.8b), UI pages/buttons (affordances can come later — backend is the boundary), GET/list endpoints beyond what the UI already uses.
4. **Files.** Create three `route.ts` under `src/app/api/bank-credentials/[bankCode]/…` + `defaults.ts` wiring + tests. Inspect: `src/app/api/bank-credentials/route.ts` (auth/rate-limit/error-masking conventions to mirror exactly).
5. **Contracts.** Responses return only `{ bankCode, autoLoginEnabled | scrapingEnabled | breakerState }` snapshots — no timestamps of internal windows, no Redis/queue diagnostics, no internal error text; `updatedBy` = authenticated admin id.
6. **Safety invariants.** Backend authz is the boundary (UI checks are affordances); every mutation audited BEFORE returning success, with never-throw audit wrapping consistent with the credential service; disabling is always allowed even when subsystems are down (kill switches must work during incidents — if the DB write fails return 503 with safe copy, never partial success).
7. **Test plan.** Per endpoint: 401/403 matrix, 404 unknown bank, 429 rate limit, happy path + audit action asserted by constant reference, DB-failure masking (503, generic body), no-echo property (response contains no envelope/plaintext/internal fields), breaker reset actually closes an open breaker (repo integration).
8. **Review risks.** Copy leaking state details; audit action mismatches (use `bank-actions.ts` constants — reviewers should reject string literals); rate-limiter instance sharing across the three routes (per-route instances following the existing pattern).
9. **Dependencies.** PR4.3 (repos). Independent of 4.4–4.7 (can be built in parallel after 4.3).
10. **Estimate.** ~320–390 lines (three thin routes + shared tests). Fits, tightly — if over, split the adapter-toggle route into a micro-PR.
11. **Acceptance.** Full authz/error matrix green; every mutation observable in the audit trail with canonical actions; manual smoke: toggling auto-login off mid-flight results in the next run skipping with `bank_autologin.skipped`.

### PR4.8b — Per-bank metrics + concrete alert thresholds

1. **Purpose.** Operational visibility for auto-login without introducing a metrics backend: a poll-based monitor in the style of `BrowserCapacityMonitor` that evaluates concrete thresholds and alerts through the existing sinks.
2. **Exact scope.** `src/modules/observability/bank-metrics.ts`: per-bank counters fed by the state machine/trigger (failure rate, latency ms, launch failures, `needs_admin_action` backlog, breaker-open flag) + threshold evaluation exactly per design.md Observability (15-min rolling window; failure rate >1% warning / >2% high / >5% or ≥3 banks critical; latency p95 >30s warning / >60s high; launch failures >10%/>25%; breaker open → alert on open + repeat ≤ every 30 min; backlog >5 warning / >10 or oldest >24h high; capacity queue >2× max sustained 5 min). Alerts flow through `AdminAlertSink` (extend with an optional `notifyAutoLoginAttention?` method so existing implementers keep compiling — same trick as `notifyCapacityAttention`); audit via existing sink.
3. **Out of scope.** Prometheus/statsd/external exporters (explicitly rejected by prior decision); dashboards; changing alert channels.
4. **Files.** Create `bank-metrics.ts` + tests; small touch in `src/worker/queues/index.ts` (`AdminAlertSink` optional method); wire counter emission from `auto-login.ts` via an injected `metrics?` dep (one-line calls). Inspect: `src/modules/observability/browser-capacity-monitor.ts` (the pattern to clone).
5. **Contracts.** Metric payloads are strictly numeric + bankCode + status strings — never URLs, never credential-adjacent fields; alert repeat limited by `alertRepeatIntervalMs` per (bank, alert-kind).
6. **Safety invariants.** Metrics/alerts failures never disrupt runs (never-throw wrappers); no operator-facing message includes counts of other banks' internals beyond the multi-bank critical rule.
7. **Test plan.** Injected clock threshold tests per rule (both sides of each boundary); repeat-suppression window; multi-bank ≥3 rule; sink-throw swallowed.
8. **Review risks.** Rolling-window bookkeeping (ring buffer vs timestamps — keep it simple, timestamps + prune); p95 with tiny samples (define behavior for n<20: skip alert, don't fake precision).
9. **Dependencies.** PR4.4b (emission points), PR4.3 (breaker state reads). Merge after 4.8a for coherent review, but technically parallel.
10. **Estimate.** ~280–360 lines. Fits.
11. **Acceptance.** Every threshold in design.md has a named test; a simulated breaker-open produces exactly one alert + suppressed repeats inside 30 min.

### PR4.9 — Complete PR4 test suite (cross-cutting integration)

1. **Purpose.** Close task 4.9: the scenarios that span slices and can only be tested once everything exists. Unit coverage already shipped inside each slice — this PR adds ONLY the cross-cutting matrix.
2. **Exact scope (tests only, no production code changes except test seams if strictly needed).**
   - Concurrency: two workers, same `expiredEventId` → only the lock holder submits (fake Redis with deterministic interleaving); distinct events → distinct locks.
   - Lifecycle: lock renew during long login; stale lease cannot release/overwrite (fencing CAS).
   - Policy: breaker opens on 3rd failure → subsequent runs skip with `bank_autologin.skipped` + manual scraping still works; manual reset re-enables.
   - Kill switches: auto-login off ≠ scraping off; adapter off → safe unavailable outcome, other banks unaffected.
   - Guards end-to-end: MFA stop; read-only mutation block still enforced on non-login pages (`unsafeBankMutationPattern` holds); throttled run outcome.
   - Leak sweep: run every failure path and assert responses/audits/alerts contain no Redis URL, DB URL, credential material, or stack text.
3. **Out of scope.** New features; E2E against real portals (explicitly deferred — manual + fixture parity).
4. **Files.** New test files under `src/worker/scraper/` and `src/modules/bank-auto-login-*/`; inspect `tests/` root conventions and the fake-Redis helper scope note from PR4A3 (`docs`/commit b791ba6).
5. **Contracts.** Tests consume only public module surfaces — if a test needs a private hook, that's a design smell to fix in a follow-up, not with `@ts-expect-error`.
6. **Safety invariants.** The suite IS the invariant enforcement: every safety claim in this roadmap's slices gets at least one adversarial test here if not already covered.
7. **Test plan.** Itself. Target: the tasks.md 4.9 checklist maps 1:1 to named tests.
8. **Review risks.** Overclaiming (a PR4.2 review warning was exactly this — static/no-op tests): reviewers must verify each test can actually fail (mutation-test spot checks: temporarily invert a guard locally).
9. **Dependencies.** PR4.3–PR4.8 merged.
10. **Estimate.** ~300–400 lines. Fits (tests compress well; if over, split concurrency suite from leak-sweep suite).
11. **Acceptance.** tasks.md 4.9 items all check off; `pnpm test` green; fresh 4R confirms no no-op tests.

### PR5 Unblockers

Three small slices that de-risk PR5 before the adapters land. Each ≤300 lines, standard gates (Med risk — 4R still recommended given proximity to auto-login surfaces).

**PR5-U1 — Per-bank adapter kill-switch enforcement in the scrape path.**
- *Purpose:* `BankAdapterConfig.scrapingEnabled=false` must actually stop scraping for that bank (today only the model + repo + endpoint exist; enforcement is unwired).
- *Scope:* `src/app/api/scrape-runs/consumer-defaults.ts` (resolve → check config → safe unavailable outcome, audit `bank_adapter.disabled` context on skip) and `run-now.ts` (disabled bank → 409/400-class safe refusal with fixed Spanish copy — pick one status and document it; do NOT leak "kill switch" terminology to operators, prefer "El banco no está disponible temporalmente para sincronización.").
- *Safety:* disabling one bank must not affect others; unknown bank still 400 fail-closed; run-now UI whitelist untouched (backend is the boundary).
- *Tests:* disabled → run-now refused + worker job for already-queued run degrades safe; enable → restored; audit trail.
- *Dependencies:* PR4.3 (repo), PR4.8a (toggle endpoint) merged. *Estimate:* ~180–260 lines.

**PR5-U2 — Incompatible pre-submit block harness (multi-bank).**
- *Purpose:* generalize PR4.7's Popular drift fixture into a reusable per-bank fixture harness so PR5/PR6 add banks by dropping in fixtures, not new test code.
- *Scope:* refactor `auto-login.portal-drift.test.ts` into a parameterized `runPortalDriftContract(bankCode, portalConfig, fixtures)`; Popular migrates onto it; assert the NO-fill/NO-submit property via injected mutation spies.
- *Safety:* the harness must fail (not skip) when a bank registers an auto-login strategy without drift fixtures — a registry-parity test enforces "strategy ⇒ fixtures exist".
- *Dependencies:* PR4.7. *Estimate:* ~150–250 lines.

**PR5-U3 — Portal drift tests for Banreservas/BHD (read-only recon fixtures).**
- *Purpose:* encode the recon knowledge (`docs/recon/banreservas.md`, `docs/recon/bhd.md`) as failing-safe fixtures BEFORE the adapters exist, so PR5 implements against a fixed contract (TDD at the portal boundary).
- *Scope:* fixture HTML/state snapshots per recon docs; drift-contract runs marked appropriately until PR5 registers the banks (e.g., contract asserts "unregistered bank code fails closed" today and flips to full assertions in PR5).
- *Safety:* fixtures contain NO real account data, NO real credentials, sanitized markup only; recon docs are the single provenance source, cited per fixture.
- *Open item:* if recon selectors are incomplete, this PR shrinks to whatever recon supports and the gap goes to Open Questions — do not invent selectors.
- *Dependencies:* PR5-U2. *Estimate:* ~150–250 lines.

### PR6 — Banreservas/BHD auto-login enablement (after PR4 safety complete + PR5 merged)

1. **Purpose.** Extend session recovery to the two remaining banks, reusing every PR4 mechanism unchanged.
2. **Exact scope.** Implement `createAutoLoginStrategy` for `banreservas` and `bhd` (username/password only; corporate/token/OTP/incompatible flows → `needs_admin_action` — never handled, never bypassed); portal configs from verified recon; wire the scrape-time trigger for both; drift fixtures via the PR5-U2 harness; operational enablement per bank via the PR4.8a endpoint (code merges with `autoLoginEnabled=false`).
3. **Out of scope.** Any new mechanism. If either bank's flow needs machinery PR4 doesn't have (e.g., a mandatory device-binding step), that bank STOPS at `needs_admin_action` permanently and the gap is escalated as a product decision — do not extend the state machine inside PR6.
4. **Files.** `src/modules/bank-adapters/banreservas.ts`, `bhd.ts`, registry, drift fixtures, `SUPPORTED_RUN_NOW_BANK_CODES` parity (done in PR5), tests per tasks 6.1–6.3.
5. **Contracts.** Same `BankPortalConfig`/strategy/guard contracts; per-bank CDP env isolation already enforced (distinct loopback ports, registry fails closed on collision).
6. **Safety invariants.** All PR4 invariants per bank; MFA copy: "Se requiere acción del administrador"; breaker/kill-switch/lock all per-bank independent; enabling BHD must not change Popular behavior (isolation test).
7. **Test plan.** tasks.md 6.3 verbatim: expired → auto-login → read-only scrape per bank; MFA stop; breaker open → manual + `skipped` audit; kill-switch revert.
8. **Review risks.** Selector confidence (recon freshness — re-verify dates before implementing); multi-portal brands (`bankCode` identifies a PORTAL, not a brand; no hyphens in `bankCode` — prior session discovery).
9. **Dependencies.** ALL of PR4.x + PR5 + unblockers merged; PR4 safety suite (4.9) green is a hard precondition.
10. **Estimate.** ~300–400 lines (two adapters sharing parser/guard scaffolding). Fits; split per bank if recon complexity differs.
11. **Acceptance.** Both banks pass the drift contract; full-chain fixture test per bank; enablement runbook updated.

---

## 5. Global Risks

1. **Redis and PostgreSQL correctness boundaries.** Redis remains the auto-login lock backing store. Expiry episode identity and audit acknowledgement live in PostgreSQL, so monitor replicas do not rely on Redis or process memory for those facts. Current lock keys are NOT Redis-Cluster-safe (documented in `defaults.ts` — `key` and `key:fence` need shared hash tags before any cluster migration).
2. **Design/code interface drift.** design.md's `BankAdapter` includes `portalConfig` + `createSessionChecker`; the shipped interface (`registry.ts`) has neither. PR4.7 must reconcile additively (optional field) — reviewers should reject any slice that rewrites the adapter interface broadly.
3. **Monitor vs worker process split.** The session monitor and the ingestion worker may run in different processes; any state they share (event ids, breaker views) must go through Redis/DB, never module-level memory. This bit PR4.6/4.5 hardest.
4. **Test overclaim recurrence.** PR4.2's 4R flagged partially no-op static tests. Every PR4.x reviewer should spot-check that new tests can fail.
5. **400-line budget pressure.** PR4.4b and PR4.8a are structurally tight. The split points are pre-planned above — use them instead of `size:exception`.
6. **Whitelist parity.** `SUPPORTED_RUN_NOW_BANK_CODES` is a hardcoded client-safe mirror guarded by parity tests; PR5 must extend it and its parity test in the same commit or the UI and backend disagree.
7. **Copy discipline.** Operator-facing strings are fixed Spanish sentences; the biggest leak vector in this phase is a helpful developer interpolating a diagnostic into a toast. The PR4.9 leak sweep is the backstop; reviews are the front line.

## 6. Open Questions (decision needed — owner: maintainer)

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | PR4.5/PR4.6 order | (a) reorder 4.6 first; (b) 4.5 inert-first | (a) — see §3 |
| Q2 | `expiredEventId` persistence | (a) Redis key per bank; (b) Prisma episode table | Resolved as (b): PostgreSQL episode rows preserve identity and audit delivery acknowledgement. |
| Q3 | Lock TTL default (5 min) + renewal cadence vs real login duration | keep 5 min / renew at half-life; or raise default | Keep 5 min, renew at ~50% TTL from the state machine; measure p95 login latency via PR4.8b before changing. |
| Q4 | Fencing on Prisma breaker writes — models have no `fencingToken` column | (a) optimistic concurrency (conditional `updateMany` on expected count/window) + fencing token in audit metadata; (b) add column | (a): matches "state writes carry fencingToken/CAS" intent without schema churn; document in PR4.3. |
| Q5 | Breaker-reset success copy | "Interruptor restablecido" vs product-approved alternative | Confirm with product before PR4.8a; keep fixed-string either way. |
| Q6 | Banreservas/BHD recon completeness (selectors, MFA indicator, incompatibleFlowSelector) | proceed / re-recon | Verify `docs/recon/*.md` freshness before PR5-U3; if incomplete, re-recon is a prerequisite, not a blocker for PR4.x. |
| Q7 | Per-bank CDP port allocation scheme | env per bank vs derived range | Already env-per-bank in practice (`RD_SYNC_BANK_<CODE>_CDP_URL`); confirm ops is fine adding two more envs in PR5. |

## 7. Suggested Execution Order for the Next 3 PRs

1. **PR4.3 — Config repositories + breaker policy.** Zero behavior change, unblocks everything, and its review teaches the reviewers the breaker semantics before they review the state machine.
2. **PR4.4a — LoginMutationGuard.** Pure, adversarially testable, and the security-critical review is best done on a small diff in isolation.
3. **PR4.4b — State machine core.** With 4.3's policy and 4.4a's guard reviewed, this review can focus purely on ordering, release-on-all-paths, and audit coverage.

(PR4.6 is the natural #4 and can be built in parallel with 4.4a/b by a second executor since it touches disjoint modules.)

## 8. How the Executor Should Use This Roadmap

1. **One slice per branch/PR**, chained per the feature-branch-chain convention: child PR targets the previous child's branch; only the tracker `feature/multi-bank-auto-login` merges to main. Verify PR4.2 (PR #22) is merged before starting PR4.3.
2. **Before writing code for a slice:** run CodeGraph (`codegraph_explore`) on the symbols named in that slice's "Files" section to confirm current shape and blast radius — this roadmap was accurate on 2026-07-02; re-verify, don't trust.
3. **Contracts win.** If this roadmap disagrees with `openspec/changes/multi-bank-auto-login/design.md` or `spec.md`, the OpenSpec artifacts win; if code disagrees with both, stop and surface it — do not improvise.
4. **TDD per slice** (Strict TDD Mode is active): the "Test plan" section of each slice is the RED list — write those tests first.
5. **Respect the budget:** ≤400 changed lines; the pre-planned split points are in each slice's estimate row. Splitting further is always acceptable; merging slices is not (in particular, never merge PR4.3 with PR4.4).
6. **Gates:** every PR4.x slice ends with full gates + fresh 4R + Judgment Day before merge. Stop after each slice and show the result before continuing.
7. **Never** implement anything that automates or works around MFA, CAPTCHA, OneSpan, Imperva challenges, or security questions. Any flow reaching such a step returns `needs_admin_action` and stops. If a task appears to require otherwise, it's a misreading — stop and escalate.
8. **Audit constants only:** all audit actions come from `src/modules/audit/bank-actions.ts`; string literals in audit calls are a review-blocking defect.
9. **Language:** code/tests/docs/commits in English; operator-facing UI copy in professional Spanish, fixed strings only.
