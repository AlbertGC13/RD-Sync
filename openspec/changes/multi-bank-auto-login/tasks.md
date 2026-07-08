<!-- Compatibility mirror: canonical SDD artifacts live in Engram under sdd/multi-bank-auto-login/*. This file exists only to satisfy Gentle AI v1.42.0 native dispatcher until Engram status support is released. -->

# Tasks: Multi-Bank Auto-Login

## Review Workload Forecast

| Field | Value |
|-------|-------|
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
|------|------|----|------|
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
- [ ] 4.6 Modify `src/modules/bank-sessions/index.ts`: `expired` assigns/retains `expiredEventId` (UUID until restore), records/alerts/schedules only (NO credential submission).
- [ ] 4.7 Enable Popular: register `createAutoLoginStrategy`, set `autoLoginEnabled=true` (gated); Popular portal-drift fixture (incompatible pre-submit asserts NO fill/submit + post-submit unknown).
- [ ] 4.8 Admin endpoints: `PATCH .../auto-login` ("Auto-login desactivado"), `POST .../reset-breaker`, `PATCH .../adapter` ("Adaptador desactivado"); audit `bank_autologin.*`/`bank_breaker.*`/`bank_killswitch.*`/`bank_adapter.*`/`bank_credential.decrypt_use`; extend `bank-metrics.ts` with auto-login failure rate/latency/launch-failures/backlog + CONCRETE alert thresholds.
- [ ] 4.9 Tests (TDD): lock acquire/owner-only-release/renew/stale-release-fails/fencing-CAS; distinct expired events distinct locks; concurrent same-event->only holder submits; breaker open (no half-open)/manual-reset/alert-rate-limit; LoginMutationGuard HTTPS/origin/allowlist/redirect-reject/incompatible-pre-submit; MFA stop; read-only block holds off login page; kill-switch disables auto-login not scraping; adapter toggle disables scraping safely; throttled run.
- Gate: full gates + FRESH 4R review + Judgment Day before merge; <=400 lines.

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
