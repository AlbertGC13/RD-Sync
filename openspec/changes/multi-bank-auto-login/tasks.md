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
| 2 | Per-bank browser/CDP isolation + loopback + backpressure + portal configs only | PR2 | PR1 branch |
| 3 | Credential model + AES-GCM envelope + admin API + audit (no auto-login) | PR3 | PR2 branch |
| 4 | Auto-login orchestration + Redis lock/fencing + breaker + Popular auto-login | PR4 | PR3 branch |
| 5 | Banreservas/BHD read-only adapters + portal drift fixtures (no auto-login) | PR5 | PR4 branch |
| 6 | Banreservas/BHD auto-login enablement | PR6 | PR5 branch |

## PR1: Adapter registry + Popular migration

- [ ] 1.1 `prisma/schema.prisma`: add `@unique` on `Bank.code`; migration (no data change).
- [ ] 1.2 Create `src/modules/bank-adapters/registry.ts`: `BankAdapter` + `BankAdapterRegistry` keyed by `bankCode`.
- [ ] 1.3 Modify `src/modules/bank-adapters/popular.ts`: expose Popular as `BankAdapter` (`bankCode:"popular"`); `createAutoLoginStrategy` stub (not-implemented).
- [ ] 1.4 Modify `src/app/api/scrape-runs/consumer-defaults.ts`: `resolveDefaultScraper`->registry routing by `bankCode`; explicit unknown->400 fail-closed; absent/empty->default Popular.
- [ ] 1.5 Modify `src/app/api/scrape-runs/run-now.ts` + `src/lib/banks.ts`: bankCode-aware defaults, 400 on unsupported; `SUPPORTED_RUN_NOW_BANK_CODES` derived from registry presence (rename from `_IDS`).
- [ ] 1.6 Tests: route by bankCode; unknown fails closed (400+audit); absent->Popular; Popular path unchanged.
- Gate: full gates; <=400 lines; no behavior change.

## PR2: Per-bank browser/CDP isolation + loopback + backpressure + portal configs

- [ ] 2.1 Modify `src/worker/scraper/browser-runtime.ts`: per-port mutex (not global), per-bank env factory (`RD_SYNC_BANK_<BANK>_CDP_URL`/profile/start-url), `assertCdpLoopback` (reject non-loopback/bad-protocol/malformed before ANY CDP use), semaphore `RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY=2`, safe `throttled` outcome, redacted error summaries.
- [ ] 2.2 Create `src/modules/observability/bank-metrics.ts`: capacity metrics (active/queueDepth/throttleEvents) per bank.
- [ ] 2.3 Add Banreservas/BHD `BankPortalConfig` config objects (env+selector placeholders from recon) — configs only, NO scraping logic.
- [ ] 2.4 Modify `scripts/launch-bank-browser.sh`: per-bank profile/port/start-url parameterization (loopback binding; runtime still validates).
- [ ] 2.5 Tests: `assertCdpLoopback` rejections; isolated concurrent banks use distinct profile+port; over-capacity->throttled (503/Retry-After where sync); error redacts command.
- Gate: full gates; <=400 lines; no scraping/auto-login logic.

## PR3: Credential model + AES-GCM envelope + admin API + audit (NO auto-login) [HIGH RISK]

- [ ] 3.1 `prisma/schema.prisma`: add `BankCredential` (two full envelopes `encryptedUsernameEnvelope`/`encryptedPasswordEnvelope`, `keyVersion`, `isActive`, `lastRotatedAt`; `bankCode` unique FK->`Bank.code`); migration.
- [ ] 3.2 Create `src/modules/bank-credentials/`: AES-256-GCM `encryptCredentialField`/`decryptCredentialField`, full envelope per field, fresh 12-byte IV each, `keyResolver` from `RD_SYNC_BANK_CREDENTIAL_KEY`; repo binding by `bankCode`.
- [ ] 3.3 Create `src/app/api/bank-credentials/route.ts`: POST set/rotate (overwrite+audit), POST test (dry decrypt+probe, never echoes), GET `{bankCode,isActive,keyVersion,lastRotatedAt}`; `requireCapability('bankCredentials.manage')`; rate-limit 10/min; UI "Credenciales actualizadas".
- [ ] 3.4 Modify `src/modules/audit/index.ts`: add `username/credential/plaintext/envelope` to `sensitiveKeys`; `bank_credential.set|rotate|test` canonical action constants; structural redaction (no value).
- [ ] 3.5 Tests (TDD): round-trip; IV uniqueness across encrypts; wrong-key/tampered-tag/unknown-keyVersion/malformed-envelope fail; no-plaintext-leak in stored ct; 403/400/429/503; GET no ciphertext; set/rotate audit (bankCode+keyVersion, never value).
- Gate: full gates + FRESH 4R review + Judgment Day before merge; <=400 lines; NO auto-login, NO decrypt_use outside test.

## PR4: Auto-login orchestration + Redis lock/fencing + breaker + Popular auto-login [HIGH RISK]

- [ ] 4.1 Create `src/modules/bank-auto-login-lock/index.ts`: Redis-backed `AutoLoginLock` — `acquire(bankCode,expiredEventId)`->`{leaseToken,fencingToken,expiresAt}|null`; owner-only `release`/`renew`; key `autologin:lock:{bankCode}:{expiredEventId}`; bounded TTL; CAS-guarded state writes carry fencingToken (stale lease cannot unlock/overwrite).
- [ ] 4.2 `prisma/schema.prisma`: add `BankAutoLoginConfig` (`autoLoginEnabled` default false; breaker `closed|open` only, NO half_open) + `BankAdapterConfig` (`scrapingEnabled` default true); migration.
- [ ] 4.3 Create `src/modules/bank-auto-login-config/` + `src/modules/bank-adapter-config/`: repos + conservative breaker policy (3 failures/30min->open, NO half-open, manual admin reset only clears window, alert on open + <=every 30min).
- [ ] 4.4 Create `src/worker/scraper/auto-login.ts`: `BankAutoLoginStrategy` state machine + `LoginMutationGuard` (HTTPS + exact origin + login-path allowlist, re-check before fill AND submit, `assertCompatiblePreSubmit`).
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
