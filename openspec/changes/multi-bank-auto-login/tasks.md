<!-- Compatibility mirror: canonical SDD artifacts live in Engram under sdd/multi-bank-auto-login/*. This file exists only to satisfy Gentle AI v1.42.0 native dispatcher until Engram status support is released. -->

# Tasks: Multi-Bank Auto-Login

## Review Workload Forecast

| Field | Value |
| ------- | ------- |
| Estimated changed lines | ~2400-3000 across 6 PRs |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR1 -> PR2 -> PR3 -> PR4 -> PR5 -> PR6 |
| Delivery strategy | auto-chain (force-chained) |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

Tracker branch `feature/multi-bank-auto-login` (base = current/main per repo convention; draft no-merge tracker PR). Child PR #N targets PR #(N-1) branch so each diff shows only its work unit; only the tracker merges to main. Retarget/rebase if a child diff shows prior PRs.

| Unit | Goal | PR | Base boundary |
| ------ | ------ | ---- | ------ |
| 1 | BankAdapter + registry + Popular migration (no behavior change) | PR1 | tracker branch |
| 2 | Per-bank browser/CDP isolation + loopback + backpressure + Popular portal config only | PR2 | PR1 branch |
| 3 | Credential model + AES-GCM envelope + admin API + audit (no auto-login) | PR3 | PR2 branch |
| 4 | Auto-login orchestration + Redis lock/fencing + breaker + Popular auto-login | PR4 | PR3 branch |
| 5 | Banreservas/BHD read-only adapters + portal drift fixtures (no auto-login) | PR5 | PR4 branch |
| 6 | Banreservas/BHD auto-login enablement | PR6 | PR5 branch |

## PR1: Adapter registry + Popular migration

- [x] 1.1 `prisma/schema.prisma`: `Bank.code` already has `@unique` in the baseline schema — no migration needed. Verified existing constraint satisfies the adapter registry routing requirement.
- [x] 1.2 Create `src/modules/bank-adapters/registry.ts`: `BankAdapter` + `BankAdapterRegistry` keyed by `bankCode`.
- [x] 1.3 Modify `src/modules/bank-adapters/popular.ts`: expose Popular as `BankAdapter` (`bankCode:"popular"`); `createAutoLoginStrategy` stub (not-implemented).
- [x] 1.4 Modify `src/app/api/scrape-runs/consumer-defaults.ts`: `resolveDefaultScraper`->registry routing by `bankCode`; explicit unknown worker jobs fail closed as `needs_admin_action`; absent/empty->default Popular.
- [x] 1.5 Modify `src/app/api/scrape-runs/run-now.ts` + `src/lib/banks.ts`: bankCode-aware defaults, HTTP 400 on unsupported run-now requests; `SUPPORTED_RUN_NOW_BANK_CODES` is a client-safe mirrored whitelist guarded by registry parity tests (rename from `_IDS`).
- [x] 1.6 Tests: route by bankCode; unknown fails closed (400+audit); absent->Popular; Popular path unchanged.
- Gate: full gates; maintainer-approved `size:exception` for PR1 foundation slice; no behavior change.

## PR2A: CDP loopback + Popular bank-aware launcher slice

- [x] 2A.1 Modify `src/worker/scraper/browser-runtime.ts`: `assertCdpLoopback` rejects non-loopback/bad-protocol/malformed before CDP fetch/ensure paths; keep redacted safe summaries.
- [x] 2A.2 Wire Popular to bank-aware CDP env resolution: `RD_SYNC_BANK_POPULAR_CDP_URL` takes precedence over legacy `RD_SYNC_CDP_URL` in scraper/session checker construction.
- [x] 2A.3 Fix production auto-launch: `createEnsureBrowserForBank("popular", env)` injects `BANK_CODE=popular` without shell command concatenation, so the launcher resolves the same per-bank env as the worker polls/connects.
- [x] 2A.4 Modify `scripts/launch-bank-browser.sh`: optional bank code resolves per-bank profile/CDP/start-url with global fallback; CDP URL is the GENUINE single source of truth for the debug port (no `DEBUG_PORT` knob — removed). When no CDP URL is configured, the launcher and worker share ONE default (`DEFAULT_CDP_URL` = `http://127.0.0.1:9222`, port enforced equal by a parity test). A GLOBAL `RD_SYNC_BANK_BROWSER_PROFILE_DIR` is bank-scoped (`/<bank>` appended) so two banks never collide; a per-bank `*_PROFILE_DIR` is verbatim (MEDIUM-1). Per-bank/global CDP URLs must be origin-only HTTP loopback URLs.
- [x] 2A.5 Tests: loopback/origin-only rejection before fetch/connect/launch; Popular per-bank CDP precedence; auto-launch injects `BANK_CODE=popular` and polls the same `RD_SYNC_BANK_POPULAR_CDP_URL`; launcher/worker default-port parity + DEBUG_PORT removed; global profile dir bank-scoped vs per-bank verbatim; registry fails closed when two banks share a CDP port (MEDIUM-2); unknown bank routing still fails closed.
- Gate: targeted tests + full gate if feasible; <=400 changed-line target; no backpressure, metrics, credentials, or auto-login logic.

## PR2B: Browser capacity/backpressure + metrics (deferred)

- [x] 2B.1 Add and wire browser semaphore/backpressure into the production Popular CDP scraper path (`RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY`, bounded queue, acquire timeout, safe throttled result, release in `finally`).
- [x] 2B.2 Capacity metrics exporter/alert wiring: poll-based `BrowserCapacityMonitor` (`src/modules/observability/browser-capacity-monitor.ts`) samples the real shared `BrowserSemaphore` and alerts/audits via the existing `AdminAlertSink`/`AuditSink` (no Prometheus/statsd/external exporter — no metrics backend exists in this codebase, by explicit user decision). Capacity is reported host-wide, not per-bank, because the underlying semaphore is a process-global singleton shared across all banks.
- [x] 2B.3 Add deterministic throttle/capacity tests for scraper backpressure. No HTTP 503/Retry-After surface is implemented in this worker-only slice.
- [x] 2B.4 Keep Banreservas/BHD placeholder portal configs deferred to PR5; no production-looking placeholder selectors in PR2B unless real read-only adapters land.
- Gate: full gates; <=400 changed-line target; no credential vault or auto-login logic.

## PR3: Credential model + AES-GCM envelope + admin API + audit (NO auto-login) [HIGH RISK]

### PR3A: Credential vault core (schema + crypto + tests)

- [x] 3.1 `prisma/schema.prisma`: add `BankCredential` (two full envelopes `encryptedUsernameEnvelope`/`encryptedPasswordEnvelope`, `keyVersion`, `isActive`, `lastRotatedAt`; `bankCode` unique FK->`Bank.code`) plus committed Prisma migration `20260629000000_add_bank_credentials`. Prisma schema validation is in the gate; generated output remains outside this PR slice.
- [x] 3.2 Create `src/modules/bank-credentials/crypto.ts`: AES-256-GCM `encryptCredentialField`/`decryptCredentialField`, full envelope per field, fresh 12-byte IV each, `keyResolver` injectable (not env-coupled); `AesGcmEnvelope` type exported.
- [x] 3.5a Crypto tests (TDD): compact suite preserving round-trip (normal/empty/unicode/long), IV uniqueness, wrong-key, tampered-tag/ciphertext, unknown keyVersion, malformed envelope including strict canonical base64 rejection, explicit `ciphertext` envelope field, ciphertext no-plaintext-leak, default/explicit keyVersion, and envelope shape/iv/tag lengths.

### PR3B: Admin API + audit + repo

**PR3B1 (foundation, complete):**

- [x] 3.4 Modify `src/modules/audit/index.ts`: add `username/credential/plaintext/envelope` to `sensitiveKeys`.
- [x] Create `src/modules/bank-credentials/key-resolver.ts`: AES-256 key resolver from `RD_SYNC_BANK_CREDENTIAL_KEY` env (base64/hex, 32 bytes, safe errors, no key material logging).
- [x] Create `src/modules/bank-credentials/repository.ts`: Prisma access for `BankCredential` (find/upsert/metadata-only; no ciphertext in metadata reads).
- [x] Create `src/modules/bank-credentials/service.ts`: Business logic for set/rotate/test with canonical audit actions (`bank_credential.set|rotate|test`); plaintext never logged or echoed.
- [x] Tests: compact key-resolver + service coverage for base64/hex/safe errors, set/rotate/test outcomes, audit safety, and metadata delegation — 394 total changed lines in slice.

**PR3B2A (admin route metadata slice):**

- [x] 3.3a Create `src/app/api/bank-credentials/route.ts` + `defaults.ts`: GET metadata only; `requireRole(principal, ["admin"])` (no capability system exists — uses existing RBAC pattern); safe error masking (401/403/400/404/503); never returns plaintext, ciphertext, envelopes, key material, or audit internals.
- [x] 3.5b-a Admin API tests (TDD): focused GET tests covering authz (401/403), metadata success, no secret fields, missing metadata (404), and safe error masking (503).
- [x] 3.6 Create `src/modules/audit/bank-actions.ts`: canonical audit action constants for bank credential/auto-login/breaker/killswitch/adapter/session domains.

**PR3B2B (admin route mutation/test slice):**

- [x] 3.3b Add POST set/rotate route with `InMemoryRateLimiter` 10/min, `requireRole(principal, ["admin"])`, safe errors, credential mutation through `BankCredentialService.setOrRotate`, and Spanish success message: "Credenciales actualizadas".
- [x] 3.3c Add action-based POST test path (`POST /api/bank-credentials` with `action: "test"`) with `InMemoryRateLimiter` 10/min, `requireRole(principal, ["admin"])`, dry decrypt via `validateStoredCredentialDecryption`, and no credential echo.
- [x] 3.5b-b Add POST tests for authz, validation, rate limit (429), set/rotate/test success paths, service error masking (503), no plaintext/ciphertext/envelope echo, and credential service call contracts.

Gate: full gates + FRESH 4R review + Judgment Day before merge; PR3B1 <=400 lines (merged); PR3B2A <=400 total changed lines; PR3B2B <=400 total changed lines; NO auto-login, NO decrypt_use outside test.

## PR4: Auto-login orchestration + Redis lock/fencing + breaker + Popular auto-login [HIGH RISK]

- [x] 4.1a Create `src/modules/bank-auto-login-lock/index.ts`: lock contract + `AutoLoginLock` interface + `LockStore` abstraction + `createAutoLoginLock` factory with bounded TTL, CAS-guarded fencing tokens, input validation, and comprehensive unit tests (no Redis adapter yet — see 4.1b).
- [x] 4.1b Redis-backed `LockStore` adapter: atomic Lua scripts for `acquireSlot`/`releaseIfOwner`/`renewIfOwner` with TTL-bound CAS, fencing-token increment, and expired-key semantics matching Redis native expiry.
- [x] 4.1c Wire `LockStore` Redis adapter into production `createAutoLoginLock` calls via DI/config.
- [x] 4.2 `prisma/schema.prisma`: add `BankAutoLoginConfig` (`autoLoginEnabled` default false; breaker `closed|open` only, NO half_open) + `BankAdapterConfig` (`scrapingEnabled` default true); migration.
- [x] 4.3 Create `src/modules/bank-auto-login-config/` + `src/modules/bank-adapter-config/`: repos + conservative breaker policy (3 failures/30min->open, NO half-open, manual admin reset only clears window, alert on open + <=every 30min).
- [x] 4.4 Create `src/worker/scraper/auto-login.ts`: `BankAutoLoginStrategy` state machine + `LoginMutationGuard` (HTTPS + exact origin + login-path allowlist, re-check before fill AND submit, `assertCompatiblePreSubmit`).
- [ ] 4.5 Wire scrape-time canonical trigger: expired->assert `adapter.bankCode===credential.bankCode`->`assertCdpLoopback`->acquire lock (or skip->manual)->ensureBrowser (or throttled)->login->detect(dashboard|mfa|unknown|redirect|incompatible)->success|needs_admin_action->owner release.
- [x] 4.6 B1 completed: durable `BankSessionExpiryEpisode` identity, atomic winner election, canonical exactly-once expiry/restoration audits, identity-safe close/retry, and a production-dormant monitor. Winner notifications are best-effort attempts only, not durable or exactly-once delivery.
- [ ] 4.7 Enable Popular: register `createAutoLoginStrategy`, set `autoLoginEnabled=true` (gated); Popular portal-drift fixture (incompatible pre-submit asserts NO fill/submit + post-submit unknown).
- [ ] 4.8 Admin endpoints: `PATCH .../auto-login` ("Auto-login desactivado"), `POST .../reset-breaker`, `PATCH .../adapter` ("Adaptador desactivado"), and authenticated-admin manual-recovery resolution invoking the PR4p2b2a1 domain command; audit `bank_autologin.*`/`bank_breaker.*`/`bank_killswitch.*`/`bank_adapter.*`/`bank_credential.decrypt_use`; extend `bank-metrics.ts` with auto-login failure rate/latency/launch-failures/backlog + CONCRETE alert thresholds.
- [ ] 4.9 Tests (TDD): lock acquire/owner-only-release/renew/stale-release-fails/fencing-CAS; distinct expired events distinct locks; concurrent same-event->only holder submits; breaker open (no half-open)/manual-reset/alert-rate-limit; LoginMutationGuard HTTPS/origin/allowlist/redirect-reject/incompatible-pre-submit; MFA stop; read-only block holds off login page; kill-switch disables auto-login not scraping; adapter toggle disables scraping safely; throttled run.
- Gate: full gates + FRESH 4R review + Judgment Day before merge; <=400 lines.

## Slice B1: Durable expiry episode source (completed predecessor child PR)

- [x] B1.1 Persist one `BankSessionExpiryEpisode` per bank with `getOrCreate` winner election, durable audit acknowledgement, and identity-safe close.
- [x] B1.2 Emit exactly one deterministic expiry audit and one deterministic restoration audit. The creation winner makes one best-effort expiry-notification attempt; the identity-safe close winner makes one best-effort restoration-notification attempt. Notification delivery and retry are neither durable nor exactly-once. Keep the monitor production-dormant. If PostgreSQL is unavailable and the process is lost before persistence, B1 cannot recover that observation.
- [x] B1.3 Remove all DB-to-queue publication, scrape-run claim/lease, consumer payload, and publication-test behavior from the active slice.
- [x] B1.4 Isolate the PostgreSQL expiry-episode contract per test and run the complete contract file twice.
- Gate: full gates; approved `size:exception` for this atomic B1 child because durable identity, election, audit acknowledgement, retry/close safety, PostgreSQL contracts, and documentation must be reviewed together. B2 publication/outbox/queue/consumer work is explicitly excluded and remains unchecked; target PR #35 head `feature/multi-bank-auto-login-pr4l-throttled-deferred`.

## Slice B2a: Durable expiry publication (completed predecessor child PR)

- [x] B2.1 Add the outbox state machine `pending -> publishing(token) -> published/cancelled` with compare-and-set transitions.
- [x] B2.2 Add deterministic real-PostgreSQL two-connection tests that hold one transaction mid-flight and force both interleavings: restoration wins so the publisher cannot enqueue; publication wins so restoration waits then closes.
- [ ] B2.3 Consumer revalidation and attempt policy: each job carries `bankCode + expiredEventId + token + runId`; the consumer rereads PostgreSQL, treats the queue as a hint, and defines durable post-claim throttled/crash/manual behavior.
  - [x] PR4p1: pre-claim eligibility foundation validates the untrusted queue hint, rereads and fully matches the durable envelope on every delivery, and returns only `eligible_for_claim` (never mutation authorization). Safe pre-claim throttling rejects retryably without terminal cancellation.
  - [x] PR4p2a1: durable repository claim primitive with atomic PostgreSQL CAS over the exact published envelope, a nonblank persisted claim token, and independent in-memory/PostgreSQL predicate, constraint, and overlap proof. It grants no public consumer result or credential-mutation authority.
  - [x] PR4p2a2: integrate the repository primitive into consumer acquisition and classify stale-versus-duplicate deliveries before any credential mutation.
  - [x] PR4p2b1: persist `reserved -> mutation_started -> manual_recovery_required -> resolved` recovery state with exact-envelope/token CAS, restoration preservation rules, migration constraints/backfill, and in-memory/real-PostgreSQL proof. The existing monitor retains unresolved `mutation_started`/`manual_recovery_required` evidence, while `resolved` closes normally and restores the normal alert flow; this is runtime persistence impact only, not credential-mutation/live-consumer wiring. Deploy migration before application code; rollback is safe only while all durable claims remain null (later-state evidence is intentionally retained).
  - [x] PR4p2b2a1: current child immediately after PR #42 and before b2a2; add the admin/rate-limited domain resolution command, discriminated outcome/category validation, canonical recovery-audit constants, and behavior proof. This policy-only child persists no resolution, outbox row, replay, or delivery; final R2/R3-remediated budget: 289 changed lines.
  - [ ] PR4p2b2a2: add immutable resolution schema plus exact-CAS PostgreSQL transaction that writes resolved state and one pending idempotent resolution-audit outbox row together; include in-memory parity and real-PostgreSQL rollback/interleaving proof. No async delivery or replay creation.
  - [ ] PR4p2b2b: deliver pending recovery-audit outbox rows and authorize one replay only for `safe_to_retry`, using a wholly new episode identity/token/attempt budget while preserving the original resolution.
  - [ ] PR4p2b3: define terminal-failure reconciliation and published-observe rejection signals.
- [x] B2.4 Scheduler provider: deduplicate jobs by exact episode `runId`; configure three total attempts (initial attempt plus two automatic retries) with exponential backoff (30s), retained failures (10), and bounded completed history (100); return observed normal/resolved-race/thrown-race BullMQ states, leaving terminal failures retained without manual retry. A published monitor tick observes the exact retained job or `missing`; it never creates a replacement attempt budget. After a successful `add`, an observation failure propagates as the observation error itself without entering duplicate-add recovery.
- [ ] B2.5 Prove two-replica disabled/config-missing behavior: one episode, one expiry audit, and one restoration audit.
- [ ] B2.6 Run fresh 4R and Judgment Day before review.
- Gate: ≤400 changed lines; no B2 implementation in B1.
- B2a predecessor owns B2.1-B2.2, including active-session pending-candidate clearing before restoration/retry; its behavior remains unchanged.
- PR4o is the current B2.4 scheduler-provider slice only: shared publication envelope, separate create/reconcile and published-state observation callbacks, and published-but-unconsumed monitor reconciliation. It does not claim consumer, restored, or terminal-failure recovery behavior.
- PR4p owns B2.3: consumer revalidation, claim/attempt policy, post-claim throttled/crash durable state, manual outcomes, audits, and replay semantics.
- PR4q owns runtime wiring and B2.5 two-replica proof. B2.6 remains the final fresh 4R and Judgment Day gate.

## PR5: Banreservas/BHD read-only adapters + portal drift fixtures (NO auto-login)

- [ ] 5.1 Create `src/modules/bank-adapters/banreservas.ts` + `bhd.ts`: read-only `createScraper`+`createSessionChecker`+pure parsers; `createAutoLoginStrategy` stub (not enabled); portal configs from recon (open Q).
- [ ] 5.2 Register banreservas/bhd in registry; add to `SUPPORTED_RUN_NOW_BANK_CODES` for read-only run-now (auto-login still gated off).
- [ ] 5.3 Expand `src/worker/scraper/auto-login.portal-drift.test.ts`: Banreservas+BHD pre-submit incompatible-flow fixtures (assert NO fill/submit) + post-submit unknown-flow fixtures.
- [ ] 5.4 Tests: route by banreservas/bhd bankCode; read-only scrape parity; unknown fails closed ("Este banco aún no está disponible para actualización automática"); portal-drift incompatible pre-submit blocks fill; per-bank adapter kill switch.
- Gate: full gates; <=400 lines; NO auto-login enablement.

## PR6: Banreservas/BHD auto-login enablement

- [ ] 6.1 Implement banreservas/bhd `createAutoLoginStrategy` (username/password-only; safe fallback->`needs_admin_action` on corporate/token/incompatible flow).
- [ ] 6.2 Set `autoLoginEnabled=true` for banreservas+bhd in `BankAutoLoginConfig` (gated); wire scrape-time trigger for both banks.
- [ ] 6.3 Tests: expired banreservas/bhd session auto-logs in read-only + scrapes; MFA->needs_admin_action ("Se requiere acción del administrador"); breaker open->manual scraping + `skipped` audit; kill-switch revert (`autoLoginEnabled=false`).
- Gate: full gates; <=400 lines.

## Full merge gates (every PR)

`pnpm test && pnpm lint && pnpm typecheck && git diff --check`; clean diff (only current work unit — retarget/rebase if polluted); <=400 changed lines; tests+docs with the unit; dependency diagram marking current PR; tracker PR stays draft/no-merge until all children integrated; HIGH-RISK PR3 & PR4 require fresh 4R review + Judgment Day before merge.
