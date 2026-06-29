<!-- Compatibility mirror: canonical SDD artifacts live in Engram under sdd/multi-bank-auto-login/*. This file exists only to satisfy Gentle AI v1.42.0 native dispatcher until Engram status support is released. -->

# Design: Multi-Bank Auto-Login (remediation 2)

## Technical Approach

Introduce a `BankAdapter` interface + `BankAdapterRegistry` keyed by canonical `bankCode` (`Bank.code`, immutable domain code), refactoring the Popular-hardcoded `resolveDefaultScraper`/`run-now`/`bank-sessions` to route by `bankCode` from `IngestionJobData`. `Bank.id` (cuid) remains the internal DB PK for existing relations (`ScrapeRun`); `Bank.code` is the canonical adapter/job/API/credential identity. Each bank gets an isolated CDP port + profile dir (env-driven). `BankCredential` stores two self-contained AES-256-GCM envelopes (one per field, fresh 12-byte IV each), env master key, never DB. Auto-login has ONE canonical trigger: scrape-time/run-context expired detection within the scrape run, guarded by a Redis-backed deterministic `AutoLoginLock` keyed by `bankCode + expiredEventId` (fencing tokens + CAS). A `BankAutoLoginConfig` model holds the auto-login kill switch (`autoLoginEnabled`) + circuit-breaker state; a separate `BankAdapterConfig` model holds the read-only adapter kill switch (`scrapingEnabled`). `LoginMutationGuard` validates HTTPS + exact origin + login-path allowlist before every fill/submit. CDP loopback is validated at runtime before any CDP use. Browser concurrency is bounded (default 2) with safe `throttled` outcomes. MFA/challenge -> STOP -> `needs_admin_action` (NEVER bypassed). A `bankCredentials.manage` capability + rate-limited endpoints govern admin actions. Per-bank metrics/alerts use CONCRETE thresholds. Audit actions use a CANONICAL table (no ambiguous shorthand). Read-only/redaction/backend-authz guards preserved.

## Architecture Decisions

| Decision | Option | Tradeoff | Choice |
|---|---|---|---|
| Bank identity | `Bank.id` (cuid) vs `Bank.code` (domain) | cuid is internal FK; code is stable/meaningful | `Bank.code` canonical for adapter/job/API/credential; `Bank.id` internal PK only |
| Credential FK | FK on `id` vs `code` | `code` binds domain meaning directly | `BankCredential.bankCode` FK -> `Bank.code` (unique) |
| Unsupported bank | Fallback to Popular vs fail closed | Guessing risks wrong-account/lockout | Explicit unknown -> 400 fail closed; only absent bankCode defaults to Popular |
| Auto-login trigger | Monitor transition vs scrape-time | Two triggers = double-submit risk | ONE scrape-time/run-context trigger; monitor only records/schedules + assigns expiredEventId |
| Lock backing store | In-process vs DB lease vs Redis | Redis already exists for queues; in-process unsafe for multi-instance; DB lease adds contention | Redis-backed lock with fencing tokens + CAS |
| Lock key identity | runId vs expiredEventId | runId-per-run defeats de-dup | `bankCode + expiredEventId` (stable per expired transition, retained until restore) |
| Kill switch source | Credential.isActive vs dedicated model | Coupling kill switch to cred state is ambiguous | Dedicated `BankAutoLoginConfig.autoLoginEnabled` AND separate `BankAdapterConfig.scrapingEnabled` |
| Adapter toggle | Reuse autoLoginEnabled vs separate flag | Coupling scraping kill to auto-login is ambiguous | Separate `BankAdapterConfig.scrapingEnabled` (default true) |
| Crypto shape | Shared iv/tag columns vs full envelope per field | Shared IV is a GCM security violation | Full envelope per field, fresh 12-byte IV each |
| URL guard | Prefix match vs parsed exact origin | Lookalikes/redirects bypass prefix | Parsed HTTPS + exact origin + path allowlist, re-checked before fill & submit |
| CDP loopback | Launcher binding only vs runtime validation | Binding can drift; runtime is the last line | Runtime parse + reject non-loopback/unsupported-protocol before ANY CDP use |
| Browser concurrency | Unbounded vs bounded | Unbounded starves host; bounded needs backpressure | Bounded semaphore, default `RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY=2`, safe `throttled` outcome |
| Admin boundary | `requireRole(['admin'])` vs capability | Capability is finer-grained | `bankCredentials.manage` capability, admin initial holder + rate limit |
| Circuit breaker | Aggressive (half-open auto-probe) vs conservative manual reset | Auto-probe risks repeated lockout | 3 failures/30min -> open; NO half-open; manual admin reset only; alert on open + <=every 30min |
| Audit actions | Free-form vs canonical table | Shorthand `disabled` is ambiguous (kill-switch vs adapter) | Canonical `bank_*` action table with explicit metadata |
| Audit tier | Distinct vs same | Confirmed: same level/retention | Reuse operational AuditEvent sink/actions |

## Data Flow

```
Job{bankCode, expiredEventId} --> Registry.get(bankCode)
     |   [adapter enabled? scrapingEnabled] --> else safe unavailable outcome (no code revert)
     |   [breaker closed? autoLoginEnabled?]
     |   [expired at scrape-time] assertCdpLoopback(cdpUrl) --> acquire AutoLoginLock(bankCode, expiredEventId)
     |         |   returns { leaseToken, fencingToken, expiresAt } or null (skip->manual)
     |   ensureBrowser(per-port, maxConcurrency=2) --> over-capacity -> throttled outcome (503/Retry-After where sync)
     |         |   gotoLoginPage --> LoginMutationGuard(HTTPS+origin+allowlist)
     |                           --> decrypt(envelope) --> fill(re-check) --> submit(re-check) [state writes carry fencingToken/CAS]
     |                                                                              |
     |                           +-------------------------------------------------+
     |                  dashboard <-| outcome detect                                |
     |                     scrape    mfa page --> STOP needs_admin_action            |
     |                            unknown/redirect/incompatible pre-submit --> needs_admin_action
     +-------- release(bankCode, expiredEventId, leaseToken) [owner-only] + ScrapeRun lifecycle + canonical Audit + per-bank Metrics/Alerts
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/modules/bank-adapters/registry.ts` | Create | `BankAdapter` interface + `BankAdapterRegistry` keyed by `bankCode` |
| `src/modules/bank-adapters/popular.ts` | Modify | Expose Popular as a `BankAdapter` (bankCode `popular`) |
| `src/modules/bank-adapters/banreservas.ts`,`bhd.ts` | Create | Read-only adapters + portal fixtures + pure parsers (PR5); auto-login strategy added in PR6 |
| `src/worker/scraper/browser-runtime.ts` | Modify | Per-port mutex, per-bank env factory, `assertCdpLoopback` runtime validation, bounded concurrency semaphore (`RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY=2`), capacity metrics, `throttled` outcome |
| `src/worker/scraper/auto-login.ts` | Create | `BankAutoLoginStrategy` + state machine + `LoginMutationGuard` + Redis `AutoLoginLock` (fencing/CAS) + circuit breaker policy (no half-open) + portal-drift detection |
| `src/modules/bank-auto-login-lock/index.ts` | Create | Redis-backed `AutoLoginLock`: `acquire`/`release` with `leaseToken`/`fencingToken`/`expiresAt`, owner-only release, bounded TTL, owner-only renewal, CAS-guarded state writes |
| `src/modules/bank-credentials/` | Create | AES-GCM envelope crypto (per-field IV), repo, model binding by `bankCode` |
| `src/modules/bank-auto-login-config/` | Create | `BankAutoLoginConfig` model (auto-login kill switch + breaker state), repo, policy |
| `src/modules/bank-adapter-config/` | Create | `BankAdapterConfig` model (`scrapingEnabled` adapter kill switch, default true), repo |
| `prisma/schema.prisma` | Modify | Add `BankCredential`, `BankAutoLoginConfig`, `BankAdapterConfig`; add `@unique` on `Bank.code` |
| `src/app/api/bank-credentials/route.ts` | Create | Admin set/rotate/test endpoints, `bankCredentials.manage` capability, rate-limited |
| `src/app/api/bank-credentials/[bankCode]/adapter/route.ts` | Create | Adapter enable/disable toggle (`scrapingEnabled`), capability-gated, audited as `bank_adapter.enabled|disabled` |
| `src/modules/bank-sessions/index.ts` | Modify | `expired` transition -> assign/retain `expiredEventId` (UUID until restore) + record/alert/schedule only (no credential submission) |
| `src/app/api/scrape-runs/consumer-defaults.ts` | Modify | `resolveDefaultScraper` -> registry routing by `bankCode`; fail-closed on unknown, default Popular only when absent; adapter-disabled -> safe unavailable |
| `src/app/api/scrape-runs/run-now.ts` | Modify | bankCode-aware defaults + 400 on unsupported + 503/Retry-After on throttle |
| `src/lib/banks.ts` | Modify | `SUPPORTED_RUN_NOW_BANK_CODES` from registry presence |
| `src/modules/audit/index.ts` | Modify | Add `username`/`credential`/`plaintext`/`envelope` to sensitiveKeys; add canonical `bank_*` action constants + capability/breaker/killswitch/adapter actions |
| `src/modules/observability/bank-metrics.ts` | Create | Per-bank metrics + CONCRETE alert thresholds (see Observability) + capacity metrics |
| `src/worker/scraper/auto-login.portal-drift.test.ts` | Create | Pre-submit incompatible + post-submit unknown fixtures for Popular, Banreservas, BHD; assert no fill/submit on incompatible pre-submit |
| `scripts/launch-bank-browser.sh` | Modify | Per-bank profile/port/start-url parameterization (loopback binding; runtime still validates) |

## Interfaces / Contracts

```ts
export interface BankPortalConfig {
  bankCode: string; baseUrl: string; loginPathAllowlist: readonly string[];
  cdpUrlEnv: string; profileDirEnv: string; startUrlEnv: string;
  usernameSelector: string; passwordSelector: string; submitSelector: string;
  mfaIndicatorSelector?: string; incompatibleFlowSelector?: string; dashboardPathIndicator: string;
}
export interface BankAdapter {
  readonly bankCode: string; readonly portalConfig: BankPortalConfig;
  createScraper(opts): IngestionScraper;
  createSessionChecker(opts): CdpSessionChecker;
  createAutoLoginStrategy(): BankAutoLoginStrategy;
}
export interface BankAdapterRegistry {
  get(bankCode: string): BankAdapter | undefined;
  supportedBankCodes(): readonly string[];
}

// AES-256-GCM envelope - ONE per field, fresh 12-byte IV per encrypt
export interface AesGcmEnvelope { keyVersion: number; iv: string; ciphertext: string; tag: string; } // all base64
export function encryptCredentialField(plain: string, keyResolver: (v:number)=>Buffer): AesGcmEnvelope;
export function decryptCredentialField(env: AesGcmEnvelope, keyResolver: (v:number)=>Buffer): string;

// Kill switches - SEPARATE concerns
model BankAutoLoginConfig {
  bankCode String @unique; bank Bank @relation(fields:[bankCode], references:[code])
  autoLoginEnabled Boolean @default(false)
  breakerState String @default("closed") // closed|open  (NO half_open)
  breakerFailureCount Int @default(0)
  breakerFailureWindowStart DateTime?
  breakerOpenedAt DateTime?
  breakerLastResetAt DateTime?
  updatedAt; updatedBy String?
}
model BankAdapterConfig {
  bankCode String @unique; bank Bank @relation(fields:[bankCode], references:[code])
  scrapingEnabled Boolean @default(true) // read-only adapter kill switch (separate from autoLoginEnabled)
  updatedAt; updatedBy String?
}
model BankCredential {
  id String @id @default(cuid())
  bankCode String @unique; bank Bank @relation(fields:[bankCode], references:[code])
  encryptedUsernameEnvelope String
  encryptedPasswordEnvelope String // FRESH IV
  keyVersion Int @default(1); isActive Boolean @default(true)
  lastRotatedAt DateTime?; createdAt; updatedAt
}

// Circuit breaker policy - CONSERVATIVE, NO half-open, manual reset only
export const AutoLoginCircuitBreakerPolicy = {
  maxAttemptsPerEvent: 1,
  failureWindowMs: 30*60*1000,
  openThreshold: 3,            // open after 3 failures within failureWindowMs
  cooldownMs: 30*60*1000,      // informational: while open, no attempts (no auto-close)
  halfOpenProbes: 0,           // explicitly NONE
  manualResetOnly: true,       // admin reset closes + clears failure window
  alertRepeatIntervalMs: 30*60*1000, // alert on open + at most every 30 min
} as const;

// CDP loopback runtime invariant - enforced before ANY CDP use
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const ALLOWED_CDP_PROTOCOLS = new Set(["http:", "ws:"]);
export function assertCdpLoopback(rawUrl: string): void {
  const u = new URL(rawUrl); // throws on malformed -> caller maps to safe unavailable
  if (!ALLOWED_CDP_PROTOCOLS.has(u.protocol)) throw new Error("unsupported protocol");
  if (!LOOPBACK_HOSTS.has(u.hostname)) throw new Error("non-loopback host rejected");
}

// Browser backpressure
export const DEFAULT_BROWSER_MAX_CONCURRENCY = 2; // env RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY
export interface BrowserCapacity { active: number; queueDepth: number; max: number; }
export type BrowserAcquireResult = { kind: "acquired"; release(): Promise<void> } | { kind: "throttled" };

// LoginMutationGuard
export class LoginMutationGuard {
  constructor(private cfg: BankPortalConfig) {}
  assertLoginPage(page: CdpPageLike): void { /* parsed URL: https, exact origin, allowlist path */ }
  beforeFill(page: CdpPageLike): void { this.assertLoginPage(page); }
  beforeSubmit(page: CdpPageLike): void { this.assertLoginPage(page); }
  assertCompatiblePreSubmit(page: CdpPageLike): void { /* reject incompatibleFlowSelector -> needs_admin_action, NO fill/submit */ }
}

// Deterministic Redis-backed AutoLoginLock - fencing + CAS + owner-only release
export interface AcquiredLock { leaseToken: string; fencingToken: number; expiresAt: number; }
export interface AutoLoginLock {
  acquire(bankCode: string, expiredEventId: string, ttlMs?: number): Promise<AcquiredLock | null>;
  release(bankCode: string, expiredEventId: string, leaseToken: string): Promise<boolean>; // owner-only
  renew(bankCode: string, expiredEventId: string, leaseToken: string, ttlMs?: number): Promise<boolean>; // owner-only
}
// Lock key: `autologin:lock:{bankCode}:{expiredEventId}`
// fencingToken: monotonically increasing per key; included in every guarded state write (CAS).
// Stale/expired leaseToken cannot release or overwrite a newer attempt's writes.
```

State machine: `expired(scrape-time, expiredEventId) -> adapterEnabled? scrapingEnabled? -> breakerClosed? autoLoginEnabled? -> assertCdpLoopback -> acquireLock(bankCode,expiredEventId) [or skip->manual] -> ensureBrowser(maxConcurrency) [or throttled] -> gotoLoginPage -> LoginMutationGuard.beforeFill -> assertCompatiblePreSubmit -> decrypt -> fill -> LoginMutationGuard.beforeSubmit -> submit [writes carry fencingToken/CAS] -> detect(dashboard|mfa|unknown|redirect|incompatible) -> success|needs_admin_action -> releaseLock(owner)`. `adapter.bankCode === credential.bankCode` asserted before decrypt. Read-only `unsafeBankMutationPattern` block stays enforced on every non-login page.

## Admin API/UI Surfaces

`POST /api/bank-credentials` (set/rotate, `requireCapability('bankCredentials.manage')`, rate-limited), `POST .../test` (dry decrypt + ensureBrowser probe, never echoes value), `GET ...` (returns `{ bankCode, isActive, keyVersion, lastRotatedAt }` — NO ciphertext/plaintext). Kill-switch/breaker endpoints: `PATCH /api/bank-credentials/:bankCode/auto-login` (`autoLoginEnabled`), `POST .../reset-breaker`. Adapter toggle: `PATCH /api/bank-credentials/:bankCode/adapter` (`scrapingEnabled`). UI confirms "Credenciales actualizadas" / "Auto-login desactivado" / "Adaptador desactivado" (professional Spanish) without echoing values. 401/403/400/429/503 safe categorization matches `run-now/route.ts`.

## Audit Integration

Reuse `AuditSink` + `createAuditEvent`. Actions use the CANONICAL table (see spec): `bank_credential.set|rotate|test|decrypt_use`, `bank_autologin.attempted|succeeded|failed|skipped|needs_admin_action`, `bank_breaker.opened|reset`, `bank_killswitch.auto_login_enabled|auto_login_disabled`, `bank_adapter.enabled|disabled`, plus existing `bank_session.expired|restored|unavailable`. Metadata per action in the canonical table — NEVER the value. Actor: admin id (admin actions) or `system:auto-login` / `system:session-monitor` (system actions). Extend `sensitiveKeys` with `username`/`credential`/`envelope`/`plaintext`. Same retention/severity as existing operational audit. No bare `disabled` shorthand.

## Observability

Per-bank metrics (keyed by `bankCode`): `bank_autologin_failure_rate`, `bank_autologin_breaker_open`, `bank_autologin_latency_ms`, `bank_browser_launch_failures`, `bank_needs_admin_action_backlog`, `bank_browser_capacity` (active/queueDepth/throttleEvents). CONCRETE production alert thresholds (15-min rolling window unless noted): failure rate >1% -> investigate warning; >2% -> emergency/high-priority; >5% OR >=3 banks affected -> all-hands/recommend disable auto-login; login latency p95 >30s -> warning, >60s -> high-priority; browser launch failures >10% -> warning, >25% -> high-priority; breaker open -> alert on open + repeat <=every 30 min; needs_admin_action backlog >5 -> warning, >10 OR oldest >24h -> high-priority; browser capacity queue depth >2x max concurrency sustained 5 min -> warning. Metrics never include credential values or URLs with embedded creds.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | crypto envelope round-trip, IV uniqueness, wrong-key/tampered-tag/unknown-keyVersion/malformed-envelope/no-plaintext-leak; parsers; state machine; CB open (no half-open)/manual-reset/alert-rate-limit; LoginMutationGuard HTTPS/origin/allowlist/redirect-reject/incompatible-pre-submit; `assertCdpLoopback` rejects non-loopback + bad protocol + malformed; AutoLoginLock acquire/owner-only-release/renew/stale-release-fails/fencing-CAS; adapter-credential mismatch rejection; adapter-disabled safe outcome; backpressure semaphore + throttle outcome; redaction | Pure functions, injected deps, JSDOM, Redis shim |
| Portal Drift Fixtures | Popular, Banreservas, BHD: pre-submit incompatible-flow fixtures (assert NO fill/submit) + post-submit unknown-flow fixtures | Injected CDP seam per bank |
| Integration | login fill/submit/MFA-stop via injected CDP seam; admin API 403/400/429/503/no-plaintext/audit emitted with canonical actions; registry routing by bankCode + 400 fail-closed on unknown; adapter kill switch disables scraping safely without code revert; kill switch disables auto-login but not scraping; breaker-open -> manual scraping + `skipped` audit; lock-busy -> skip + manual scraping | Vitest + stub `CdpPageLike` + Redis shim |
| E2E | Deferred — real bank portals not testable | Manual + existing fixture parity |

## Migration / Rollout

No data migration (new models). Add `@unique` on `Bank.code`; existing `Bank` rows already carry stable codes. Rollback: set `BankAutoLoginConfig.autoLoginEnabled=false` per bank -> instant revert to manual scraping WITHOUT disabling scraping; set `BankAdapterConfig.scrapingEnabled=false` per bank -> safe unavailable without code revert; drop `BankCredential` rows / `isActive=false`; registry returns 400 for unknown `bankCode` (no Popular fallback for explicit unknowns). Redis lock keys are TTL-bounded and self-expire; no migration needed for lock state. KMS + full key rotation explicitly out of scope; `keyVersion` forward-compatible only.

## Chained PR Plan (<=400 lines each, independently revertible)

| PR | Work unit | Behavior | Risk | Rollback |
|---|---|---|---|---|
| PR1 | `BankAdapter` interface + registry + Popular migration (bankCode identity) | None (routing refactor) | Low | Revert registry; Popular path intact |
| PR2 | Per-bank browser isolation + `assertCdpLoopback` + backpressure semaphore + capacity metrics + portal CONFIGS only (profile/port/start-url env, config objects, launch script) | Multi-bank launch config + runtime loopback guard + bounded concurrency, NO adapter scraping logic, NO auto-login | Low | Revert to single-port |
| PR3 | `BankCredential` schema + AES-GCM per-field envelope crypto + repo + admin set/rotate/test API + `bankCredentials.manage` capability + rate limit | Credential storage (NO auto-login) | HIGH | Drop model/rows |
| PR4 | Redis `AutoLoginLock` (fencing/CAS) + auto-login orchestration core + MFA stop + incompatible-pre-submit detection + circuit breaker policy (no half-open) + `BankAutoLoginConfig` kill switch + `BankAdapterConfig` toggle + Popular auto-login enablement + portal drift fixtures | Popular auto-login live + deterministic locking + adapter toggle | HIGH | `autoLoginEnabled=false` |
| PR5 | Banreservas + BHD READ-ONLY adapters (scraper + parser + session checker, NO auto-login) | Read-only transaction viewing live for both banks | Med | `scrapingEnabled=false` per bank |
| PR6 | Banreservas + BHD auto-login ENABLEMENT (wire auto-login strategy + enable kill switch per bank) | Auto-login live for both banks | Med | `autoLoginEnabled=false` per bank |

PR boundaries: PR2 = configs/isolation/loopguard/backpressure ONLY; PR4 adds deterministic lock + orchestration + adapter toggle + portal drift fixtures; PR5 = read-only adapters ONLY (no auto-login); PR6 = auto-login enablement ONLY. PR3 (crypto), PR4 (first mutation surface + locking), and the breaker policy get deepest review. Each PR keeps tests/docs with its work unit.

## Open Questions

- [ ] Banreservas/BHD exact login selectors + MFA indicator selector + incompatibleFlowSelector (portal reconnaissance needed before PR5/PR6).
- [ ] Per-bank CDP port allocation scheme (env per bank vs derived range) — confirm ops preference.
- [ ] Redis lock TTL default value + renewal cadence (confirm ops SLO for auto-login duration).
