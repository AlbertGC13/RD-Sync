<!-- Compatibility mirror: canonical SDD artifacts live in Engram under sdd/multi-bank-auto-login/*. This file exists only to satisfy Gentle AI v1.42.0 native dispatcher until Engram status support is released. -->

# Proposal: Multi-Bank Auto-Login

## Intent

RD-Sync today scrapes transactions from a single bank (Popular) via a CDP-attach model where an admin manually logs into a server-side Brave/Chromium browser (including MFA). When the bank session expires, scraping stops and an admin must re-log in manually — blocking the transaction-visibility workflow and forcing manual babysitting.

**Business objective:** Expand to Popular, Banreservas, and BHD, and automate read-only re-login when a session expires so operators see up-to-date transactions without manual intervention — while preserving the existing read-only / MFA-stop / redaction / CDP-localhost security posture and NEVER bypassing MFA.

## Target Users and Situations

| Actor | Situation | Need |
|---|---|---|
| Admin | Configures shared institutional bank credentials | Set/rotate per bank without ever seeing plaintext |
| Operator (viewer/reviewer/admin) | Triggers Refrescar and the bank session has expired | Auto-login completes transparently; transactions refresh |
| Admin | Auto-login hits an MFA/challenge page | Receive explicit "needs admin action" alert; log in manually |
| Operator | A new/unsupported bank appears in the registry | Clear messaging that the bank is not yet available for auto-login |

## Scope

### In Scope
- Bank adapter interface + registry routing by `bankId` (replaces Popular-hardcoded `resolveDefaultScraper`).
- Per-bank browser profile dir + CDP port isolation (env-driven).
- Encrypted reversible credential store: `BankCredential` model (AES-256-GCM), admin set/rotate API, audit.
- Secure read-only auto-login orchestration with MFA stop + per-bank circuit breaker.
- Banreservas + BHD adapters (portal config + scraper + auto-login strategy).
- Reuse/extend existing guards: read-only mutation block, MFA stop, `redactDiagnosticText`, `redactAuditMetadata`, CDP-on-localhost, backend authz.

### Out of Scope
- Per-user bank credentials (shared institutional model only).
- Automated MFA/challenge solving (NEVER).
- Scraping products beyond transactions in this change.
- Per-bank UI dashboards (reuse existing run-now surface).
- KMS/HSM integration (env master key now; KMS is a documented follow-up).

## Product & Business Rules
- Auto-login is automatic ONLY for read-only access, triggered on a detected `expired` session (transition or scrape-time expiry).
- One shared institutional credential set per bank. No per-user bank attribution.
- MFA/challenge page -> STOP run, mark `needs_admin_action`, alert admin. No auto-fill/submit of MFA, ever.
- A new/unsupported bank must never be auto-login-enabled: `SUPPORTED_RUN_NOW_BANK_IDS` + adapter presence gate the capability.
- Per-bank `autoLoginEnabled` flag + circuit breaker: a misbehaving auto-login is disableable per bank WITHOUT disabling manual-login scraping.

## Security Rules
- Credentials encrypted at rest with AES-256-GCM; master key in `RD_SYNC_BANK_CREDENTIAL_KEY` (env/KMS), NEVER in the DB.
- scrypt (existing `src/modules/auth/password.ts`) is NOT reused — it is one-way; bank credentials require reversible encryption.
- Decrypt only in worker memory at scrape time; plaintext never persisted, logged, returned in API responses, toasts, or audit metadata.
- Auto-login is the ONLY new legitimate WRITE surface: tightly scoped to the bank login page; the read-only mutation block stays enforced on every other page.
- Every credential decrypt / rotate / auto-login attempt is audited; audit records system-used-credential + actor, NEVER the value (`redactAuditMetadata` extended structurally, not just by redaction).
- All CDP endpoints remain on `127.0.0.1`; profile dirs `0700`; launch mutex becomes per-port, not global.
- No credential caching in the browser profile after login (no-autofill policy + profile sanitization).

## User-Visible Flows

**F1 - Configure shared bank credentials (admin):**
Admin opens bank credential settings, selects a bank, submits username/password. Backend encrypts and stores; UI confirms "Credenciales actualizadas" without echoing values. Rotate = overwrite + audit.

**F2 - Session expires and auto-login succeeds (operator):**
Operator clicks Refrescar; worker detects expired session, performs read-only auto-login, scrapes, upserts. Toast reflects the run outcome (e.g., "Actualización completada. Se importaron N transacciones."). Auto-login is invisible to the operator except via audit.

**F3 - MFA/challenge appears and admin action is required:**
Auto-login submits credentials; an MFA/challenge page appears. Worker stops, marks `needs_admin_action`, alerts admin. Operator sees the existing needs-admin toast ("Se requiere acción del administrador"); admin logs in manually to the profiled browser.

**F4 - Unsupported/new bank behavior:**
A bank in the registry without a configured adapter/credentials surfaces a clear validation error ("Este banco aún no está disponible para actualización automática") and is never queued for auto-login.

## First-Slice Boundary & Chained PR Strategy

Secure design first (this proposal + specs/design), then chained PRs (~400-line budget each):

| PR | Work unit | Behavior change |
|---|---|---|
| PR1 | `BankAdapter` interface + registry + Popular migration | None (routing refactor) |
| PR2 | Per-bank profile/port/CDP isolation + Banreservas/BHD portal configs | Multi-bank launch |
| PR3 | `BankCredential` schema + AES-GCM crypto + repo + admin set/rotate API | Credential storage (NO auto-login) |
| PR4 | Auto-login orchestration + MFA stop + circuit breaker + Popular auto-login | Popular auto-login live |
| PR5 | Banreservas adapter + auto-login | Banreservas live |
| PR6 | BHD adapter + auto-login | BHD live |

PR3 (crypto) and PR4 (first mutation surface) are the highest-risk slices and get the deepest review. First executable slice = PR1 (no behavior change) after design approval.

## Capabilities

### New Capabilities
- `bank-adapter-registry`: adapter interface, registry, bankId routing replacing Popular-hardcoded resolution.
- `bank-credential-store`: encrypted reversible credential model + AES-GCM crypto + admin API + audit.
- `bank-auto-login`: secure read-only auto-login orchestration with MFA stop + per-bank circuit breaker.

### Modified Capabilities
- `bank-sessions`: add auto-login hook on `expired` transition (currently alert-only).
- `bank-browser-runtime`: per-bank profile/port/CDP isolation + per-port launch mutex.
- `scrape-runs`: reuse existing `needs_admin_action` path for auto-login/MFA failures (no new status).

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/lib/banks.ts` | Modified | Adapter lookup + run-now whitelist |
| `src/modules/bank-adapters/` | New | Interface + Banreservas/BHD adapters |
| `src/worker/scraper/navigation/` | Modified | Per-bank CDP scrapers + routing |
| `src/worker/scraper/browser-runtime.ts` | Modified | Per-bank CDP/profile/port + per-port mutex |
| `src/modules/bank-sessions/index.ts` | Modified | Auto-login hook on expired transition |
| `src/app/api/scrape-runs/consumer-defaults.ts` | Modified | bankId routing |
| `src/modules/auth/password.ts` | Reference only | scrypt not reused (one-way) |
| `src/modules/audit/index.ts` | Modified | Credential/auto-login audit events |
| `prisma/schema.prisma` | New | `BankCredential` model |
| `scripts/launch-bank-browser.sh` | Modified | Per-bank parameterization |

## Risks & Open Questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| Credential store compromise | Med | AES-GCM at rest, key in env/KMS, decrypt in memory only, zero logging, structural redaction |
| Auto-login is a mutation surface | Med | Scope writes to login page only; keep read-only block elsewhere |
| MFA bypass temptation | Low | Hard stop -> needs_admin_action; no MFA automation, ever |
| Anti-bot / account lockout | Med | Rate-limit + per-bank circuit breaker + `autoLoginEnabled` flag |
| Credential caching in browser profile | Med | No-autofill policy + profile sanitization |
| Multi-CDP exposure | Low | 127.0.0.1 only, per-port mutex, 0700 profiles |

**Open questions:**
1. Where does `RD_SYNC_BANK_CREDENTIAL_KEY` live in production (env now; KMS/Vault follow-up)? Rotation procedure?
2. Master-key rotation: `keyVersion` re-encrypt-on-rotate, or versioned keys with read-time decrypt only?
3. Auto-login attempt cap: exact per-bank rate limit and circuit-breaker reset policy?
4. Banreservas/BHD: do their portals require a distinct login flow (token device, corporate login) that may force a "manual-only" bank even with stored credentials?
5. Audit retention: should auto-login events have a distinct retention/severity from normal scrape events?

## Rollback Plan
- Per-bank `autoLoginEnabled=false` instantly reverts to manual-login scraping WITHOUT disabling scraping.
- Drop `BankCredential` rows / set `isActive=false` removes auto-login capability per bank.
- Adapter registry falls back to existing Popular-only `resolveDefaultScraper` if a bankId is unknown.
- Each chained PR is independently revertible.

## Dependencies
- Existing read-only scraper, MFA-stop, redaction, audit, and CDP-localhost posture (preserved, not weakened).
- Env secret `RD_SYNC_BANK_CREDENTIAL_KEY` provisioning (ops).

## Success Criteria
- [ ] Popular, Banreservas, BHD each routable by bankId end-to-end.
- [ ] Expired Popular session auto-logs in read-only and scrapes without operator action.
- [ ] MFA/challenge stops the run and alerts admin; MFA is never auto-submitted.
- [ ] No credential plaintext appears in DB at rest, logs, API responses, toasts, or audit metadata.
- [ ] Each chained PR <=400 changed lines and independently reviewable.
- [ ] Existing read-only guards and redaction remain enforced.

## Proposal Question Round
The confirmed product assumptions (banks: Popular/Banreservas/BHD; auto-login trigger: expired read-only session; shared institutional credential model; MFA = stop + admin action, no bypass; secure-design-first) are encoded above. Before spec/design, please confirm or correct: (1) key storage location + rotation model; (2) per-bank rate-limit/circuit-breaker numbers; (3) whether Banreservas/BHD login flows may force manual-only banks; (4) whether KMS is explicitly a non-goal for this slice. A second question round can be requested after answers.
