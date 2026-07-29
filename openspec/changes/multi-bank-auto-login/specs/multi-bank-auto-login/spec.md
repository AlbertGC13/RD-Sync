<!-- Compatibility mirror: canonical SDD artifacts live in Engram under sdd/multi-bank-auto-login/*. This file exists only to satisfy Gentle AI v1.42.0 native dispatcher until Engram status support is released. -->

# Spec: Multi-Bank Auto-Login (multi-bank-auto-login)

Single concatenated delta artifact (Engram-only store). Encodes NEW and MODIFIED capability deltas. Operator/UI copy in professional Spanish for Dominican banking staff; technical artifacts in English.

**Encoded decisions (remediation 2):** banks = Popular, Banreservas, BHD; canonical identity = `Bank.code` (immutable domain code); auto-login read-only on expired session via ONE scrape-time/run-context trigger; shared institutional credential per bank; env master key `RD_SYNC_BANK_CREDENTIAL_KEY`; full key rotation out of scope (minimal `keyVersion`/forward-compat only); conservative circuit breaker (1 attempt/event, opens after 3 failures/30min, NO half-open, manual reset only); per-bank kill switch in dedicated `BankAutoLoginConfig` model; AES-256-GCM full envelope per field with fresh 12-byte IV; Banreservas/BHD username/password-only with safe fallback to admin action; MFA never bypassed; audit at SAME level/retention as existing operational audit with CANONICAL action names; dedicated `bankCredentials.manage` capability + rate-limited admin endpoints; per-bank observability metrics/alerts with CONCRETE production thresholds; Redis-backed deterministic AutoLoginLock with fencing tokens + compare-and-set; runtime CDP loopback validation before any CDP use; browser backpressure (default max concurrency 2); per-bank read-only adapter toggle separate from auto-login toggle; portal drift fixtures required for all 3 banks; chained PRs (~400 lines) with unambiguous boundaries.

---

## Domain: bank-identity (NEW canonical contract)

| Requirement | Strength | Behavior |
|---|---|---|
| Canonical Bank Code | MUST | `Bank.code` (immutable, unique domain code: `popular`, `banreservas`, `bhd`) is the canonical identity for adapters, jobs, API, and credentials. `Bank.id` (cuid) is the internal DB PK only. |
| Job/API/Credential Binding | MUST | `IngestionJobData` carries `bankCode`; adapters registered by `bankCode`; `BankCredential` binds to `bankCode` (FK to `Bank.code`), NOT to ambiguous `bankId` |
| Adapter-Credential Match Enforcement | MUST | At runtime the worker asserts `adapter.bankCode === credential.bankCode`; mismatches are rejected and never proceed to auto-login |
| Distinct id vs code | MUST | Code that confuses `Bank.id` (cuid) with `Bank.code` (domain code) is a contract violation |

#### Scenario: route run by bankCode
- GIVEN a scrape run job carries `bankCode=banreservas`
- WHEN the worker resolves the adapter via the registry
- THEN the banreservas adapter is selected by code, not Popular

#### Scenario: adapter-credential mismatch rejected
- GIVEN a run resolves adapter `bhd` but the credential row's `bankCode` is `banreservas`
- WHEN the worker checks identity
- THEN it rejects the mismatch, marks `needs_admin_action`, and never submits credentials

---

## Domain: bank-adapter-registry (NEW)

| Requirement | Strength | Behavior |
|---|---|---|
| Adapter Interface | MUST | Each bank adapter exposes `{ bankCode, portalConfig, createScraper(), createSessionChecker(), createAutoLoginStrategy() }` |
| Registry Routing | MUST | `resolveScraper(bankCode)` / run-now dispatch route via `BankAdapterRegistry` keyed by `bankCode`, replacing the Popular-hardcoded `resolveDefaultScraper` |
| Whitelist + Adapter + Credential Gate | MUST | A bank is auto-login-enabled only when `bankCode` is in `SUPPORTED_RUN_NOW_BANK_CODES` AND its adapter is present AND credentials are configured AND `autoLoginEnabled=true` AND breaker closed |
| Banreservas & BHD Adapters | MUST | Adapters for `banreservas` and `bhd` are registered with portal configs and read-only scrapers |
| Safe Fallback to Admin Action | MUST | When a bank's real login flow differs from username/password, the adapter degrades to `needs_admin_action` instead of attempting an unsupported login |
| Per-bank Adapter Kill Switch | MUST | A dedicated `BankAdapterConfig.scrapingEnabled` flag (default true), SEPARATE from `BankAutoLoginConfig.autoLoginEnabled`, is a runtime kill switch for the whole adapter (read-only scraping included). Disabling it returns a safe unavailable run outcome WITHOUT code revert and WITHOUT disabling other banks. |
| Unknown Bank Fails Closed | MUST | An explicit `bankCode` with no registered adapter fails closed (400 + audit); it NEVER falls back to Popular. |

#### Scenario: unsupported bank fails closed
- GIVEN `bankCode` is explicitly present but absent from `SUPPORTED_RUN_NOW_BANK_CODES` or has no adapter
- WHEN run-now is invoked for that bank
- THEN the API returns 400 with "Este banco aún no está disponible para actualización automática" and emits an audit event; NO auto-login is queued; the bank NEVER falls back to Popular

#### Scenario: only absent bankCode defaults to Popular
- GIVEN `bankCode` is absent/empty (legacy/default run)
- WHEN run-now is invoked
- THEN it defaults to `popular` for backward compatibility only; any explicit non-popular unknown code still fails closed

#### Scenario: adapter kill switch disables scraping safely
- GIVEN `BankAdapterConfig.scrapingEnabled=false` for `banreservas` while `autoLoginEnabled=true`
- WHEN a run for banreservas is processed
- THEN the run returns a safe unavailable outcome ("Actualización no disponible temporalmente para este banco"), scraping AND auto-login are both skipped for that bank, and other banks are unaffected; no code revert is required to re-enable later

#### Scenario: portal forces manual-only fallback
- GIVEN the bhd adapter detects a corporate/token login page incompatible with stored username/password
- WHEN auto-login is attempted
- THEN the run stops, is marked `needs_admin_action`, admin alerted; no credentials submitted past incompatible-flow detection

---

## Domain: bank-browser-runtime (MODIFIED)

(Previously: single CDP endpoint, single profile dir, global process-level launch mutex.)

| Requirement | Strength | Behavior |
|---|---|---|
| Per-bank Isolation | MUST | Each bank gets a dedicated persistent profile dir (0700) and a dedicated CDP port, env-driven (`RD_SYNC_BANK_<BANK>_CDP_URL`) |
| Per-port Launch Mutex | MUST | The launch mutex is per-port, not global, so banks do not block each other |
| CDP Loopback Runtime Invariant | MUST | Before ANY CDP fetch/connect/auto-login, the runtime parses the configured CDP URL and REJECTS non-loopback hosts (only `127.0.0.1`, `localhost`, `::1` allowed) and unsupported protocols (only `http`/`ws` to loopback). Launcher binding alone is NOT sufficient; this is enforced and tested at runtime. |
| Browser Backpressure | MUST | A bounded concurrency limit governs simultaneous browser launches/sessions. Default `RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY=2`. Over-capacity requests are queued with bounded backoff/timeout; on timeout the run yields a safe `throttled` outcome (NOT a hard failure) and may surface `503`/`Retry-After` semantics on the API where applicable. |
| Capacity Metrics | MUST | Active browser sessions, queue depth, and throttle events are emitted as capacity metrics per bank. |
| Safe Error Summaries | MUST | Launch/browser errors surface safe summaries; command strings and secrets never leak |

#### Scenario: isolated concurrent banks
- GIVEN Popular and Banreservas runs are concurrent
- WHEN both browsers launch
- THEN each uses its own profile dir and CDP port under a per-port mutex; neither blocks the other

#### Scenario: non-loopback CDP URL rejected at runtime
- GIVEN a CDP URL is misconfigured to `http://10.0.0.5:9222` (non-loopback) or `ftp://...`
- WHEN the runtime validates it before connecting
- THEN it rejects the URL, aborts the CDP operation, and returns a safe unavailable outcome; NO connection is attempted to the non-loopback host

#### Scenario: over-capacity run is throttled safely
- GIVEN 3 banks attempt to launch browsers while `RD_SYNC_BANK_BROWSER_MAX_CONCURRENCY=2`
- WHEN the third request exceeds capacity and the bounded queue timeout elapses
- THEN that run yields a safe `throttled` outcome (scrape deferred), the API may return `503` with `Retry-After` where the call is synchronous, and a throttle metric is emitted; no browser is force-started beyond the limit

#### Scenario: error without leakage
- GIVEN a browser launch fails
- WHEN the error is surfaced to the operator
- THEN only a safe summary is shown; the launch command and any secret are redacted

---

## Domain: bank-credential-store (NEW)

| Requirement | Strength | Behavior |
|---|---|---|
| Full Envelope Per Field | MUST | `BankCredential` stores `encryptedUsernameEnvelope` and `encryptedPasswordEnvelope` — each a self-contained AES-256-GCM envelope `{ keyVersion, iv, ciphertext, tag }` with its OWN fresh 12-byte random IV. NO shared `iv`/`authTag` columns. |
| Reversible Encryption at Rest | MUST | AES-256-GCM; master key from `RD_SYNC_BANK_CREDENTIAL_KEY` env (32 bytes), NEVER in DB |
| No scrypt Reuse | MUST | Existing scrypt (one-way) is NOT used; reversible symmetric encryption only |
| Bind by bankCode | MUST | `BankCredential.bankCode` is unique and FK to `Bank.code`; one credential set per bank code; no per-user attribution |
| Fresh IV Per Encrypt | MUST | Every encryption of every field uses a freshly generated 12-byte IV; reusing an IV across fields or rotations is a contract violation |
| Admin Set/Rotate API | MUST | Admins with `bankCredentials.manage` capability set and rotate credentials; rotate = overwrite + audit; UI confirms "Credenciales actualizadas" without echoing values |
| Decrypt In-Memory Only | MUST | Plaintext decrypted only in worker memory at scrape time; never persisted, logged, or returned in API/toasts/audit |
| Minimal keyVersion Forward-Compat | SHOULD | Carry `keyVersion` in each envelope for forward compatibility; full key rotation out of scope for this slice |

#### Scenario: admin stores credentials
- GIVEN an authenticated admin with `bankCredentials.manage` selects bank=banreservas and submits username/password
- WHEN the backend encrypts and persists
- THEN two AES-256-GCM envelopes (one per field, each with its own fresh IV) + keyVersion are stored; the API returns success without echoing values; a `bank_credential.set` audit event is emitted

#### Scenario: rotate credentials
- GIVEN an existing `BankCredential` for bhd
- WHEN the admin rotates (overwrites) credentials
- THEN both envelopes are overwritten with fresh IVs, keyVersion/timestamps update, a `bank_credential.rotate` audit event records bankCode + actor (never the value)

#### Scenario: plaintext never persisted
- GIVEN a credential decrypt occurs at scrape time
- WHEN the worker fills the login form
- THEN plaintext lives only in worker memory for the login step and is never written to DB, logs, API responses, toasts, or audit metadata

#### Scenario: crypto contract tests
- GIVEN the crypto module
- WHEN tested
- THEN it verifies: IV uniqueness across encrypts, wrong-key auth failure, tampered-tag auth failure, unknown keyVersion fail-closed, malformed-envelope parse failure, and no-plaintext-leakage in stored ciphertext

---

## Domain: bank-auto-login-trigger (NEW canonical)

| Requirement | Strength | Behavior |
|---|---|---|
| ONE Canonical Trigger | MUST | Auto-login is triggered exactly once per run-context expired detection at scrape-time within the scrape run. The session monitor's `expired` transition does NOT submit credentials independently; it only records/alerts and may schedule a run. |
| Expired Event Identity | MUST | The session monitor assigns a stable `expiredEventId` (UUID) at the moment of an `expired` transition and retains it until the session is restored; the scrape run's run-context carries that `expiredEventId`. The lock and idempotency are keyed by `bankCode + expiredEventId`, NOT by `runId` alone (runId-per-run would defeat de-dup). |
| Deterministic AutoLoginLock | MUST | A Redis-backed per-`bankCode + expiredEventId` lock prevents concurrent runs from double-submitting credentials for the SAME expired state. `acquire(bankCode, expiredEventId)` returns `{ leaseToken, fencingToken, expiresAt }` or `null` if held. `release(bankCode, expiredEventId, leaseToken)` succeeds ONLY for the owner `leaseToken`. ALL state writes guarded by the lock carry the `fencingToken` with compare-and-set semantics, so a stale/expired lease cannot unlock or overwrite a newer attempt's writes. TTL is bounded and renewed ONLY by the owner if needed. |
| No Independent Monitor Submission | MUST | If the session monitor remains in the flow, it must not decrypt or submit credentials; only the scrape-run context does. |
| Lock Backing Store | MUST | Redis is the lock backing store (Redis already exists for queues). In-process locks are NOT acceptable for correctness. |

#### Scenario: scrape-time trigger performs auto-login
- GIVEN a run for an enabled, configured bank detects an expired session at scrape-time carrying `expiredEventId=E1`
- WHEN the run-context trigger fires
- THEN it acquires the Redis lock keyed `autologin:lock:{bankCode}:E1` and performs read-only auto-login exactly once

#### Scenario: concurrent runs do not double-submit
- GIVEN two concurrent runs for `popular` both react to the SAME expired transition `E1`
- WHEN both attempt auto-login
- THEN only the lock holder submits credentials; the other receives `acquire=null`, skips auto-login, and falls back to manual scraping; a newer attempt's state writes cannot be overwritten by a stale lease due to fencing/CAS

#### Scenario: distinct expired events get distinct locks
- GIVEN run A reacts to expired event `E1` and run B reacts to a LATER expired event `E2` for the same bank
- WHEN both attempt auto-login
- THEN each acquires its own lock (`E1` vs `E2`); they do not mutually exclude, because they correspond to different expired states

#### Scenario: stale release cannot unlock
- GIVEN a lease for `E1` expired and a new attempt acquired a fresh lease
- WHEN the stale holder calls `release` with its old `leaseToken`
- THEN release fails (token mismatch) and the newer attempt's lock/state remain intact

#### Scenario: monitor does not submit credentials
- GIVEN the session monitor detects an `expired` transition
- WHEN the hook runs
- THEN it records/alerts (and may schedule a run) but never decrypts or submits credentials itself

---

## Domain: bank-auto-login (NEW)

| Requirement | Strength | Behavior |
|---|---|---|
| Read-Only Auto-Login on Expiry | MUST | On the canonical scrape-time expired trigger, the worker auto-logs in read-only using stored credentials, then scrapes |
| Login-Only Write Surface | MUST | Auto-login writes are scoped to the bank's login page only; the existing read-only mutation block stays enforced on every other page |
| LoginMutationGuard URL Validation | MUST | Before every fill AND submit, `LoginMutationGuard` validates the parsed URL: HTTPS only, exact allowed origin match (no lookalike tolerance), pathname in an explicit login-path allowlist; unknown redirects/lookalikes are rejected -> STOP -> `needs_admin_action` |
| MFA/Challenge Stop | MUST | If an MFA/challenge page appears, the run STOPS, is marked `needs_admin_action`, admin alerted; MFA is NEVER auto-filled or submitted |
| No Credential Caching | MUST | After login the browser profile is sanitized; no-autofill policy; credentials are not cached in the persistent profile |
| Per-bank Circuit Breaker (Conservative, No Half-Open) | MUST | A per-bank circuit breaker disables a misbehaving auto-login per bank WITHOUT disabling manual-login scraping. Policy: open after 3 failures within 30 min; WHILE open, NO auto-login attempts are made (no half-open auto-probe); alert on open and at most every 30 min; admin MANUAL reset closes the breaker AND clears the failure window. There is NO automatic close and NO half-open state — this is intentionally conservative. |
| Per-bank Kill Switch | MUST | A dedicated `BankAutoLoginConfig.autoLoginEnabled` flag (separate from credential active state AND from `BankAdapterConfig.scrapingEnabled`) is the manual kill switch; default off |
| One Attempt Per Event | MUST | 1 attempt per run-context expired event |
| Per-bank Toggle Rollback | MUST | `autoLoginEnabled=false` instantly reverts a bank to manual-login scraping |
| Portal Drift Fixtures | MUST | Pre-submit incompatible-flow fixtures AND post-submit unknown-flow fixtures are required for Popular, Banreservas, AND BHD. Tests MUST prove NO credential fill/submit occurs on an incompatible pre-submit page. |

#### Scenario: expired session auto-logs in
- GIVEN a popular session is expired and `autoLoginEnabled=true`, credentials configured, breaker closed, adapter enabled
- WHEN the scrape-time trigger fires
- THEN it auto-logs in read-only, scrapes, upserts; the operator toast reflects the outcome (e.g., "Actualización completada. Se importaron N transacciones.")

#### Scenario: MFA stops the run
- GIVEN auto-login submits credentials and an MFA/challenge page appears
- WHEN the worker detects the MFA indicator
- THEN it stops, marks `needs_admin_action`, alerts admin, shows "Se requiere acción del administrador"; MFA is never submitted

#### Scenario: circuit breaker opens (no half-open)
- GIVEN a bank's auto-login has failed 3 times within 30 min
- WHEN the breaker opens
- THEN auto-login is disabled for that bank; subsequent runs fall back to manual-login scraping; NO half-open probe is auto-attempted; an alert fires on open and at most every 30 min while open

#### Scenario: manual admin reset (only way to close)
- GIVEN a breaker is open for a bank
- WHEN an admin resets it
- THEN the breaker returns to closed, the failure window clears, and auto-login resumes; absent manual reset it never auto-closes

#### Scenario: kill switch disables auto-login only
- GIVEN `autoLoginEnabled=false` for a bank while `scrapingEnabled=true`
- WHEN an expired trigger occurs
- THEN auto-login is skipped and manual-login scraping proceeds; scraping is NOT disabled

#### Scenario: read-only block holds off the login page
- GIVEN auto-login completed and the browser is on the bank dashboard
- WHEN the scraper navigates account/transaction pages
- THEN the read-only mutation block rejects any transfer/payment selector; auto-login writes never occur off the login page

#### Scenario: redirect off login page rejected
- GIVEN auto-login navigated to the login page and a redirect to an unknown origin/lookalike occurs before submit
- WHEN LoginMutationGuard re-validates before submit
- THEN it rejects the URL, stops, marks `needs_admin_action`; no credentials are submitted to the unknown page

#### Scenario: incompatible pre-submit page blocks credential fill
- GIVEN a portal drift fixture for BHD presents an incompatible (corporate/token) login page BEFORE submit
- WHEN the auto-login strategy evaluates the page
- THEN it detects the incompatible flow, marks `needs_admin_action`, and NEVER fills or submits credentials

---

## Domain: bank-sessions (MODIFIED)

(Previously: `expired` transition was alert-only.)

| Requirement | Strength | Behavior |
|---|---|---|
| Expired Transition Records + Assigns EventId | MUST | On an `expired` transition, the session monitor records the event, assigns/retains a stable `expiredEventId` (until restore), alerts; it does NOT submit credentials. Auto-login is performed only within the scrape-run context (canonical trigger). |
| Preserve Unavailable Handling | MUST | `browser_unavailable` and health-check behavior remain unchanged |

#### Scenario: expired transition records, run performs login
- GIVEN the session monitor detects an `expired` transition for an enabled, configured bank and assigns `expiredEventId=E1`
- WHEN the hook runs
- THEN it records/alerts (and may schedule a run carrying `E1`); the subsequent scrape run performs the auto-login via the canonical trigger keyed by `E1`

#### Scenario: disabled bank still alerts
- GIVEN `autoLoginEnabled=false` for the bank
- WHEN an `expired` transition occurs
- THEN the monitor alerts admin as before; no auto-login is attempted

---

## Domain: scrape-runs (MODIFIED)

(Previously: `needs_admin_action` used for MFA/manual-login failures; no auto-login concept.)

| Requirement | Strength | Behavior |
|---|---|---|
| Reuse needs_admin_action | MUST | Auto-login/MFA/circuit-breaker/identity-mismatch/portal-drift failures reuse the existing `needs_admin_action` status; NO new status is introduced |
| Throttled Outcome | MUST | A run that yields to browser backpressure is recorded as a safe `throttled` outcome (deferred, not failed) in run audit, distinct from `needs_admin_action` and `failed` |
| Auto-Login Outcome on Run Audit | MUST | Each run records whether auto-login was attempted/succeeded/failed/skipped/throttled in run audit, without exposing credential values |

#### Scenario: MFA failure marks run
- GIVEN an auto-login hits MFA
- WHEN the run is finalized
- THEN the scrape run is marked `needs_admin_action` and a `bank_autologin.needs_admin_action` audit event is emitted; the operator sees the existing needs-admin toast

#### Scenario: breaker-open run outcome
- GIVEN the breaker is open for a bank
- WHEN a run for that bank is processed
- THEN the run proceeds with manual-login scraping semantics and records that auto-login was skipped (`bank_autologin.skipped`) due to breaker-open

---

## Domain: bank-admin-capability (NEW)

| Requirement | Strength | Behavior |
|---|---|---|
| Dedicated Capability | MUST | A `bankCredentials.manage` capability governs credential set/rotate/test AND kill-switch/breaker changes AND adapter toggle changes; the existing admin role is its initial holder |
| Rate-Limited Endpoints | MUST | set/rotate/test endpoints are rate-limited per actor (e.g. 10/min) to slow brute/abuse |
| No Plaintext Echo | MUST | Admin endpoints never return ciphertext or plaintext; GET returns `{ bankCode, isActive, keyVersion, lastRotatedAt }` only |

#### Scenario: non-admin cannot manage credentials
- GIVEN an authenticated non-admin (no `bankCredentials.manage`)
- WHEN they call set/rotate/test
- THEN the API returns 403

#### Scenario: rate limit on rotate
- GIVEN an admin rotates credentials repeatedly
- WHEN they exceed the per-actor limit
- THEN the API returns 429 with Retry-After

---

## Domain: bank-secure-observability (NEW + observability extension)

| Requirement | Strength | Behavior |
|---|---|---|
| Credential Access Audit | MUST | Every credential decrypt/rotate/auto-login attempt emits an audit event recording bankCode + system-used-credential identity + actor; NEVER the value. Actions use the CANONICAL names below. |
| Canonical Audit Action Names | MUST | All auto-login/credential/breaker/kill-switch/adapter actions use the explicit canonical names in the table below; shorthand like bare `disabled` is prohibited (ambiguous with kill-switch vs adapter). |
| Structural Redaction | MUST | Credential values are excluded structurally from audit metadata; extend `redactAuditMetadata` structurally |
| Diagnostic Redaction | MUST | `redactDiagnosticText` strips credentials/URI-creds/account-numbers/balances from any diagnostic reaching the UI |
| Same Audit Level/Retention | MUST | Credential/auto-login audit events use the SAME level/retention as existing operational audit |
| No Secret Exposure | MUST | Secrets never appear in DB at rest, logs, API responses, toasts, error summaries, or audit metadata |
| Per-bank Metrics | MUST | Per-bank metrics emitted: auto-login failure rate, breaker-open events, login latency, browser launch failures, unresolved `needs_admin_action` backlog, browser capacity (active sessions/queue depth/throttle events) |
| Concrete Production Alert Thresholds | MUST | Alerts fire at the concrete thresholds in the table below (15-min rolling window unless noted) |

### Canonical Audit Action Table

| Canonical Action | Actor | Metadata (never the value) |
|---|---|---|
| `bank_credential.set` | admin id | `{ bankCode, keyVersion }` |
| `bank_credential.rotate` | admin id | `{ bankCode, keyVersion }` |
| `bank_credential.test` | admin id | `{ bankCode, outcome }` |
| `bank_credential.decrypt_use` | `system:auto-login` | `{ bankCode, keyVersion }` |
| `bank_autologin.attempted` | `system:auto-login` | `{ bankCode, expiredEventId }` |
| `bank_autologin.succeeded` | `system:auto-login` | `{ bankCode, expiredEventId }` |
| `bank_autologin.failed` | `system:auto-login` | `{ bankCode, expiredEventId, reason }` |
| `bank_autologin.skipped` | `system:auto-login` | `{ bankCode, reason: breaker_open|kill_switch_off|adapter_disabled|throttled|lock_busy }` |
| `bank_autologin.needs_admin_action` | `system:auto-login` | `{ bankCode, expiredEventId, reason }` |
| `bank_breaker.opened` | `system:auto-login` | `{ bankCode }` |
| `bank_breaker.reset` | admin id | `{ bankCode }` |
| `bank_killswitch.auto_login_enabled` | admin id | `{ bankCode }` |
| `bank_killswitch.auto_login_disabled` | admin id | `{ bankCode }` |
| `bank_adapter.enabled` | admin id | `{ bankCode }` |
| `bank_adapter.disabled` | admin id | `{ bankCode }` |
| `bank_session.expired` | `system:session-monitor` | `{ bankCode, expiredEventId, checkedAt }` |
| `bank_session.restored` | `system:session-monitor` | `{ bankCode, checkedAt }` |
| `bank_session.unavailable` | `system:session-monitor` | `{ bankCode, checkedAt }` |

### Production Alert Thresholds (15-min rolling window)

| Metric | Threshold | Severity / Action |
|---|---|---|
| Auto-login failure rate | >1% in 15 min | Investigate warning |
| Auto-login failure rate | >2% in 15 min | Emergency / high-priority alert |
| Auto-login failure rate | >5% in 15 min OR >=3 banks affected | All-hands / recommend disable auto-login |
| Login latency (p95) | >30 s | Warning |
| Login latency (p95) | >60 s | High-priority alert |
| Browser launch failures | >10% in 15 min | Warning |
| Browser launch failures | >25% in 15 min | High-priority alert |
| Circuit breaker open | any open event | Alert on open + repeat at most every 30 min while open |
| Unresolved `needs_admin_action` backlog | >5 unresolved for a bank | Warning |
| Unresolved `needs_admin_action` backlog | >10 unresolved for a bank OR oldest >24 h | High-priority alert |
| Browser capacity | queue depth > 2x max concurrency sustained 5 min | Warning |

#### Scenario: decrypt audited without value
- GIVEN the worker decrypts a credential for an auto-login
- WHEN the audit event is written
- THEN it records `bank_credential.decrypt_use` with bankCode, keyVersion, and actor; the credential value is structurally absent

#### Scenario: high failure rate triggers emergency alert
- GIVEN a bank's auto-login failure rate exceeds 2% over 15 min
- WHEN the metric is evaluated
- THEN an emergency/high-priority alert fires for that bank with the bankCode

#### Scenario: multi-bank outage triggers all-hands
- GIVEN auto-login failure rate exceeds 5% in 15 min OR >=3 banks are affected
- WHEN the metric is evaluated
- THEN an all-hands alert fires recommending disabling auto-login

#### Scenario: breaker-open alert fires and is rate-limited
- GIVEN a bank's breaker opens and stays open
- WHEN alerts are evaluated
- THEN an alert fires on open and repeats at most every 30 min (not on every run)

---

## Coverage Notes
- Happy paths: routing by bankCode, auto-login success, credential store, audit, observability with concrete thresholds.
- Edge cases: unsupported bank fail-closed vs absent-default, adapter kill switch, adapter-credential mismatch, concurrent de-dup via Redis lock + fencing, distinct expired events, stale release rejection, kill switch, breaker open (no half-open)/manual reset, redirect rejection, CDP non-loopback rejection, browser throttling, portal drift incompatible pre-submit.
- Error states: MFA stop, launch failure without leakage, breaker-open run, throttled run, unknown keyVersion, malformed envelope, lock-busy skip.
- Implementation/architecture details deferred to sdd-design.

---

## Domain: expiry-consumer-recovery (ADDED)

| Requirement | Strength | Behavior |
|---|---|---|
| Manual resolution authorization | MUST | The domain operation accepts `{ operatorId, roles }`, rejects unless `roles` includes `admin`, and invokes an injected rate-limit gate before persistence. A denial creates no state or outbox change. PR4.8 owns the future authenticated-admin HTTP integration that invokes this domain command; no endpoint exists in PR4p2b2. |
| Immutable resolution record | MUST | Only `manual_recovery_required` may resolve. Resolution atomically persists `outcome`, `operatorId`, compatible categorized `reason`, and `resolvedAt`; these fields are immutable. Allowed pairs are `safe_to_retry/verified_no_mutation`, `mutation_confirmed/verified_mutation`, and `resolved_no_retry/closed_without_retry`. |
| Resolution audit outbox | MUST | The same PostgreSQL transaction that resolves the exact durable envelope and claim owner inserts one pending, idempotent resolution-audit outbox row. Stale, wrong-owner, duplicate, unauthorized, or rate-limited requests produce neither transition nor row. Delivery is deferred. |
| Recovery containment | MUST | `manual_recovery_required` remains visible and does not increment the auto-login breaker; it represents infrastructure uncertainty. Auto-login remains dormant and never retries an uncertain mutation. |
| Future replay | MUST | Only `safe_to_retry` may authorize replay in PR4p2b2b. Replay is not created in this slice and must use a new `expiredEventId`, `runId`, claim token, and attempt budget while preserving the original resolution; at most one replay per resolution. |

#### Scenario: admin resolves an uncertain mutation
- GIVEN an exact `manual_recovery_required` episode and matching consumer claim
- WHEN an admin passes the rate-limit gate with `mutation_confirmed/verified_mutation`
- THEN one immutable resolution and one pending `bank_autologin.manual_recovery_resolved` audit-outbox row commit together.

#### Scenario: resolution is denied before persistence
- GIVEN a non-admin, rate-limited, stale, wrong-owner, or already-resolved request
- WHEN the resolution operation runs
- THEN it makes no durable state or audit-outbox change.

### Consumer recovery audit actions

| Action | Actor | Allowed metadata keys |
|---|---|---|
| `bank_autologin.consumer_reserved` | `system:auto-login` | `bankCode`, `expiredEventId`, `runId`, `reservedAt` |
| `bank_autologin.mutation_started` | `system:auto-login` | `bankCode`, `expiredEventId`, `runId`, `mutationStartedAt` |
| `bank_autologin.manual_recovery_required` | `system:auto-login` | `bankCode`, `expiredEventId`, `runId`, categorized `reason`, `manualRecoveryRequiredAt` |
| `bank_autologin.manual_recovery_resolved` | admin `operatorId` | `bankCode`, `expiredEventId`, `runId`, `outcome`, `operatorId`, categorized `reason`, `resolvedAt` |
| `bank_autologin.replay_authorized` | admin `operatorId` | `bankCode`, `expiredEventId`, `runId`, `outcome`, `operatorId`, categorized `reason`, `replayAuthorizedAt` |

No action may include claim tokens, credentials, secrets, or internal errors. The three system actions are emitted by future consumer/runtime phases; the two operator actions are emitted only after the authenticated domain path authorizes the admin actor.
