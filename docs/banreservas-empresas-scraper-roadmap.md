# Banreservas Empresas Scraper Completion Roadmap

> Planning date: 2026-09-14 · Branch context: `feat/banreservas-empresas-parser-profile` at `ec89455` (four local commits on top of `50a8257`, not pushed) · Tracker: #111 · Method: live sanitized CDP reconnaissance of the authenticated portal + CodeGraph/structural reading of the Popular production wiring · Companion documents: `docs/fable5-scraper-completion-roadmap.md` (multi-bank PR4–PR6 plan), `docs/runbooks/bank-session.md`, `docs/runbooks/worker.md`.
>
> Audience: the agent team that will finish the Banreservas Empresas scraper end to end. Every slice below names the real contract it plugs into, the files it touches, the tests it must ship, and the gate it must pass. Nothing here authorizes bypassing authentication challenges: Banreservas Empresas currently shows no MFA or CAPTCHA, but every flow that meets an unexpected step MUST stop with `needs_admin_action`.

---

## 1. Executive Summary

**Target flow.** A scrape run for `banreservas_empresas` must: (1) ensure the isolated bank browser is running on its own loopback CDP port, (2) detect whether the portal session is active, (3) if expired, sign in with the stored encrypted credential through the shared auto-login guard, (4) collect the latest movements of every account, (5) upsert them into `Transaction` keyed by `bankId` + `accountFingerprint`, and (6) surface the run and the movements to the operator in the existing UI. This is exactly what Popular does today; Popular is the mold.

**Where Banreservas Empresas stands.** The read-only half is built and validated live against the real portal:

| Piece | Location | Status |
|---|---|---|
| Parser profile (selectors, routes, formats) | `src/modules/bank-adapters/banreservas-empresas.ts` | Done (`50a8257`, extended in `6e55dea`) |
| Frames-based session checker | `src/worker/scraper/banreservas-empresas-session-checker.ts` | Done, live `active` (`40465e4`) |
| CDP frame adapter + explicit endpoint resolver (`127.0.0.1:9225`) | `src/worker/scraper/navigation/banreservas-empresas-cdp.ts` | Done (`40465e4`) |
| Pure per-account collector (period, pagination, fingerprint) | `src/worker/scraper/navigation/banreservas-empresas.ts` | Done (`0dc8d56`) |
| Main-frame CDP page adapter + inert `IngestionScraper` factory | `src/worker/scraper/navigation/banreservas-empresas-cdp.ts` | Done, live `collected` (`6e55dea`, `ec89455`) |
| `BankRuntime` (CDP + ensureBrowser + session checker) | `src/worker/scraper/bank-runtime.ts` | Missing (`runtimeStatus: "deferred"`) |
| `BankPortalConfig` for `Login.aspx` (auto-login selectors) | none | Missing; needs sanitized recon |
| `BankAdapter` + registry entry + run-now code | `src/modules/bank-adapters/registry.ts`, `src/lib/banks.ts` | Missing |
| Auto-login strategy | generic `createBankAutoLoginStrategy` exists | Not composed for this bank |
| Launcher verified start URL, runbook, admin UI entry, `Bank` row | `scripts/launch-bank-browser.*`, `docs/runbooks`, `src/app/admin/bank-connections/page.tsx`, DB | Missing |

**What the collector already guarantees** (verified on 2026-09-13 with a 7-day window, two accounts, custom pagination): deterministic account selection by grid row index, DD/MM/YYYY period typed into the masked inputs with one retry, `Consultar` waited through the ASP.NET `PageRequestManager`, validator check so a blocked query never reads as empty, six direct cells per row, pagination until an empty page or a disabled `lnkNext`, per-account SHA-256 fingerprint, no partial results on any failure, no export/transfer/admin control ever addressed.

**Known correctness gap to close first.** The collector currently tags every movement with currency `DOP` (parser default). The accounts grid has a `Moneda` column and the product combo text ends with `|<currency>`, so USD accounts would be mislabeled. PR-B1 fixes this before anything is registered.

**Lookback decision.** Banreservas Empresas adopts a 7-day default, matching Popular. The collector's existing 1–90-day bounds remain unchanged; environment parsing must use the same trim, numeric, invalid-value, and clamping pattern without introducing a global CDP fallback.

---

## 2. Popular Reference Wiring (the mold)

Read these before writing code. They are the contracts every slice plugs into.

| Concern | Popular implementation | Contract to reuse |
|---|---|---|
| Adapter | `createPopularBankAdapter({ createScraper, createAutoLoginStrategy })` in `src/modules/bank-adapters/popular.ts` | `BankAdapter { bankCode; createScraper(); createAutoLoginStrategy() }` (`registry.ts`) |
| Registry | `bankAdapterRegistry = createBankAdapterRegistry([popularAdapter])` in `registry.ts`; `assertDistinctBankCdpEndpoints` fails closed on shared CDP ports | Add a second adapter to the list; keep distinct `RD_SYNC_BANK_<PORTAL>_CDP_URL` |
| Scraper routing | `resolveDefaultScraper(bankCode)` in `src/app/api/scrape-runs/scraper-defaults.ts`; unknown code → `needs_admin_action` stub | No change needed once the adapter is registered |
| Runtime | `createPopularBankRuntimeResolver(env)` → `createExactBankRuntimeResolver([runtime])` in `src/worker/scraper/bank-runtime.ts`; inert template `createBhdPersonalBankRuntime` | Compose one resolver with Popular + Banreservas runtimes |
| Browser session config | `createBankSessionBrowserConfig(bankCode, env)` reads only `RD_SYNC_BANK_<PORTAL>_CDP_URL`; auto-launch via `RD_SYNC_BANK_BROWSER_AUTO_LAUNCH=enabled` + `RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND` | Reuse as is |
| Session probe | `createAuthenticatedSessionProbe({ resolveSessionChecker, ensureBrowserSession })` in `src/worker/scraper/authenticated-session-probe.ts` | Resolver must return the Banreservas checker for `banreservas_empresas` |
| Auto-login | `createBankAutoLoginStrategy(popularPortalConfig, { supportedBankCodes })`; guard `LoginMutationGuard` (`login-mutation-guard.ts`); runner `createScrapeTimeAutoLoginRunner`; opener `createScrapeTimeAutoLoginBrowserOpener({ trustedLoginUrl })` | Provide a `BankPortalConfig` and the same factories |
| Production processor | `src/worker/authenticated-ingestion-production-processor.ts`: probe → `BankAutoLoginConfig.autoLoginEnabled` + breaker `closed` → `runScrapeTimeAutoLogin` → `collect()` | No change needed; it is bank-agnostic |
| Persistence | `src/worker/queues/index.ts`: `scraper.collect()` → `transactions.upsertMany` → `scrapeRuns.markSucceeded` | No change needed; dedupe via `createSourceHash` |
| Operator surface | `src/lib/banks.ts` (`SUPPORTED_RUN_NOW_BANK_CODES = ["popular"]`), `src/app/admin/bank-connections/page.tsx` (hardcoded `popularBankConnection`), `src/app/api/bank-credentials/[bankCode]/auto-login/route.ts` | Add the portal code, not the brand code |
| Launcher | `scripts/launch-bank-browser.ps1` / `.sh` `VERIFIED_PORTAL_START_URLS` (popular, bhd_personal only) | Add `banreservas_empresas` → `https://www.banreservas.com.do/TuBancoEmpresas/Login.aspx` |

Identity rule (do not violate): `banreservas` is a **brand** code used only for display metadata (`BANKS.banreservas` in `src/lib/banks.ts`). `banreservas_empresas` is the **portal** code that routes, locks, stores credentials, and names the CDP endpoint (`src/modules/bank-adapters/bank-identities.ts`). Never route by the brand code.

---

## 3. Recommended PR Sequence

Chain strategy: feature-branch-chain as in the existing roadmap (each child PR targets the previous child branch; only the tracker merges to `main`). The four existing commits are four sequential base children, not one oversized PR-B0. The roadmap is a separate documentation child so it remains independently reviewable. Every PR: `pnpm test && pnpm lint && pnpm typecheck && git diff --check`, ≤400 changed lines, tests inside the same work unit, Conventional Commits, no AI attribution lines, `.playwright-mcp/` and `docs/audits/*` left untouched, BHD PR #187 untouched.

| Order | Child PR | Parent | Commit / budget | Name | Risk | Gate |
|---|---|---|---|---|---|---|
| 0a | PR-B0a | `50a8257` | `40465e4` / 397 | Inert frames-based session checker + explicit CDP adapter | Med | fresh review |
| 0b | PR-B0b | PR-B0a | `0dc8d56` / 277 | Pure per-account collector: period, pagination, and fingerprint | Med | fresh review |
| 0c | PR-B0c | PR-B0b | `6e55dea` / 372 | Main-frame CDP page adapter + inert scraper factory | Med | fresh review |
| 0d | PR-B0d | PR-B0c | `ec89455` / 45 | Harden period entry and post-query validation | Med | fresh review |
| 0e | PR-B0e | PR-B0d | This roadmap / ≤400 | Corrected chain publication plan | Low | structural readback + `git diff --check` |
| 1 | PR-B1 | PR-B0e | ≤400 | Currency-aware collection + lookback env + fixture coverage | Med | full gates |
| 2 | PR-B2 | PR-B1 | ≤400 | Inert `createBanreservasEmpresasBankRuntime` + multi-bank production resolver | HIGH | fresh review + Judgment Day |
| 3 | PR-B3 | PR-B2 | ≤400 | Self-opening frameset page for the scraper (attach-or-open) | Med | full gates |
| 4 | PR-B4 | PR-B3 | ≤400 | Sanitized `Login.aspx` recon → `banreservasEmpresasPortalConfig` + portal-drift fixtures | HIGH | fresh review + Judgment Day |
| 5 | PR-B5 | PR-B4 | ≤400 | `BankAdapter` + registry + run-now code + API validation | HIGH | fresh review + Judgment Day |
| 6 | PR-B6 | PR-B5 | ≤400 | Auto-login enablement (strategy, opener, breaker, kill switch tests) | HIGH | fresh review + Judgment Day |
| 7 | PR-B7 | PR-B6 | ≤400 | Operator surface: launcher URL, runbook, admin UI entry, `Bank` row provisioning | Med | full gates |
| 8 | PR-B8 | PR-B7 | ≤400 | Supervised production activation checklist (no product code) | Med | maintainer sign-off |

PR-B2 and PR-B3 are technically independent but publish sequentially in this child chain; PR-B4 needs a live sanitized recon session; PR-B5 depends on B1–B4; PR-B6 depends on B5.

---

## 4. Slice Specifications

### PR-B0a — Inert frames-based session checker + explicit CDP adapter

- **Parent:** base parser-profile commit `50a8257`.
- **Commit:** `40465e4` (`feat(banks): add inert Banreservas Empresas CDP session checker`).
- **Churn:** 397 authored additions and deletions combined (397 additions).
- **Work:** review this child before the collector depends on it; preserve the explicit per-portal endpoint and inert frames-only session observation.
- **Acceptance:** review approves the fail-closed posture and no runtime registration.

### PR-B0b — Pure per-account collector

- **Parent:** PR-B0a child branch.
- **Commit:** `0dc8d56` (`feat(banks): collect Banreservas Empresas movements per account`).
- **Churn:** 277 authored additions and deletions combined (277 additions).
- **Work:** review deterministic account iteration, Santo Domingo period resolution, pagination, opaque fingerprints, and no-partial-results behavior.
- **Acceptance:** the pure collector is independently reviewable on top of the session-checker child.

### PR-B0c — Main-frame CDP page adapter + inert scraper factory

- **Parent:** PR-B0b child branch.
- **Commit:** `6e55dea` (`feat(banks): drive Banreservas Empresas collection over CDP frames`).
- **Churn:** 372 authored additions and deletions combined (358 additions, 14 deletions).
- **Work:** review the narrow main-frame seam, profile-driven selectors, and attach-only scraper factory.
- **Acceptance:** the adapter drives only the documented consultation flow and detaches without closing operator pages.

### PR-B0d — Harden period entry and post-query validation

- **Parent:** PR-B0c child branch.
- **Commit:** `ec89455` (`fix(banks): harden Banreservas Empresas period entry and query check`).
- **Churn:** 45 authored additions and deletions combined (39 additions, 6 deletions).
- **Work:** review masked-input retry and ASP.NET validator checks so a rejected query cannot be read as an empty result.
- **Acceptance:** the hardened collector remains fail-closed with no partial movements.

### PR-B0e — Roadmap as a reviewable documentation child

- **Parent:** PR-B0d child branch.
- **Commit:** this documentation work unit.
- **Churn:** the roadmap remains an independent documentation child within the ≤400-line budget.
- **Work:** review the sequential child-PR publication plan, the 7-day lookback decision, and the unchanged scope boundaries.
- **Acceptance:** complete structural readback and `git diff --check`; no unrelated files are staged.

### PR-B1 — Currency-aware collection + lookback env

- **Goal:** stop defaulting every movement to `DOP`; make the lookback window operator-configurable the way Popular does.
- **Evidence:** accounts grid columns are `ProductTypeDescription, NumberConsolidated, Alias, Currency, TotalAmount` (hidden `ProductId, ProductType`); product combo option text is `<number>|<currency>`.
- **Files:** `src/worker/scraper/navigation/banreservas-empresas.ts` (+ test), `src/worker/scraper/navigation/banreservas-empresas-cdp.ts` (+ test).
- **Design:** extend the page seam with `selectedAccountCurrency(): Promise<string>` read from the combo selected option text after the `|` separator (or from the `Currency` cell of the selected accounts row). Validate against an allowlist (`DOP`, `USD`, `EUR`); unknown currency fails closed for that account. Pass `currency` to `parseBanreservasEmpresasTransactionRows`. Wire `lookbackDays` from env through the established Popular trim/numeric parsing convention in the scraper factory, with a 7-day default; keep the collector's 1–90 clamp and do not consult global CDP fallback variables.
- **Tests:** fake pages returning `USD`, `DOP`, or `EUR` yield the matching currency; unknown or malformed currency → `unavailable` with a fixed safe summary and no partial results; env lookback defaults to 7, clamps within Banreservas bounds, and handles invalid input; existing fingerprint and paging tests remain green.
- **Budget:** ~120 lines.

### PR-B2 — Inert runtime + multi-bank production resolver

- **Goal:** give the worker a `BankRuntime` for `banreservas_empresas` without changing production behavior until the env endpoint is set.
- **Template:** `createBhdPersonalBankRuntime` in `src/worker/scraper/bank-runtime.ts`.
- **Files:** `bank-runtime.ts` (+ test), `src/modules/bank-adapters/bank-identities.ts` (+ test: `runtimeStatus: "inert"`), `src/worker/ingestion-worker.ts` (one-line swap to the new resolver factory).
- **Design:**
  - `createBanreservasEmpresasBankRuntime(env, deps)` → `createBankSessionBrowserConfig(banreservasEmpresasBankCode, env)`; `sessionChecker = createBanreservasEmpresasCdpSessionChecker(browser.cdpUrl)`; `ensureBrowser = createScrapeTimeAutoLoginBrowserOpener({ trustedLoginUrl: banreservasEmpresasPortalProfile.loginUrl, ... })` exactly like BHD.
  - `createProductionBankRuntimeResolver(env, deps)` → `createExactBankRuntimeResolver([popularRuntime, banreservasRuntime].filter(defined))`. Popular keeps its current construction; Banreservas appears only when `RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL` is a valid loopback URL.
  - Keep `resolveBanreservasEmpresasCdpUrl` (canonical `9225`) for tooling; the worker must use the env-only `createBankSessionBrowserConfig` path so an unset endpoint means "not wired", matching the launcher's refusal to guess.
- **Tests:** resolver returns `unavailable`/`undefined` for `banreservas_empresas` when the env var is unset; returns the checker and CDP URL when set; Popular behavior unchanged; distinct-port collision still throws at registry build (registry test).
- **Budget:** ~180 lines.

### PR-B3 — Attach-or-open frameset page

- **Goal:** after an auto-login (which runs in its own tab) or after a browser restart with a valid cookie session, the scraper must not depend on an operator having left a `Default.aspx` tab open.
- **Files:** `src/worker/scraper/navigation/banreservas-empresas-cdp.ts` (+ test).
- **Design:** in `createBanreservasEmpresasCdpScraper.collect()`, if no trusted `Default.aspx` page exists, open one page in the default context (`openCdpPageInDefaultContext` from `browser-runtime.ts`), `goto(landingUrl)`, wait for `load`, and accept it only if the session checker reports `active`; otherwise close **that** page (never operator pages) and return the manual result. Add `landingUrl` navigation as the only allowed top-level navigation; keep the attach path unchanged.
- **Tests:** existing tab → no new page; no tab + valid session → one page opened, collected, page closed after collection; no tab + login bounce → page closed, manual result, no DOM reads beyond the checker; `newPage` throwing → manual.
- **Budget:** ~150 lines.

### PR-B4 — `Login.aspx` portal config from sanitized recon

- **Goal:** produce `banreservasEmpresasPortalConfig` satisfying `BankPortalConfig` (`src/worker/scraper/login-mutation-guard.ts`): `baseUrl`, `loginPathAllowlist`, `usernameSelector`, `passwordSelector`, `submitSelector`, `mfaIndicatorSelector`, `incompatibleFlowSelector`, `dashboardPathIndicator`.
- **Recon rules (mandatory):** read-only CDP against `127.0.0.1:9225` on the `Login.aspx` tab only; collect element ids, names, types, tag names, and form action path; never read, type, or store credentials; never submit; no screenshots; no raw HTML in reports or fixtures. Record the DOM the portal shows for a wrong password, a locked user, and a forced password change **only if the operator triggers those states manually**; otherwise document them as open.
- **Known facts:** `Login.aspx` is a top-level WebForms document (no frameset) at `https://www.banreservas.com.do/TuBancoEmpresas/Login.aspx`; success lands on `/TuBancoEmpresas/Default.aspx` whose header frame renders `a[href*='Logout.aspx']`.
- **Files:** `src/modules/bank-adapters/banreservas-empresas-portal.ts` (+ test), `src/worker/scraper/auto-login.portal-drift.test.ts` (add Banreservas fixtures).
- **Design:** `mfaIndicatorSelector` must be a real challenge marker even if the portal shows none today (for example a token/OTP input or a security-question form observed in the DOM tree); `incompatibleFlowSelector` must catch the forced-password-change and blocked-user pages. The guard asserts required controls before any fill, so wrong selectors fail closed, never fill.
- **Tests:** profile contract test; portal-drift fixtures proving the guard performs no `fill`/`click` when the incompatible selector is present or the login form is missing; post-submit unknown flow → `needs_admin_action`.
- **Budget:** ~150 lines plus fixtures.

### PR-B5 — Adapter, registry, run-now code

- **Goal:** make `banreservas_empresas` routable from the API and the worker.
- **Files:** `src/modules/bank-adapters/banreservas-empresas.ts` (add `createBanreservasEmpresasBankAdapter` like `createPopularBankAdapter`), `src/modules/bank-adapters/registry.ts` (+ test), `src/lib/banks.ts` (+ test: `SUPPORTED_RUN_NOW_BANK_CODES`), `src/app/api/bank-credentials/[bankCode]/auto-login/route.test.ts`, `src/app/api/scrape-runs/scraper-defaults.ts` (+ test).
- **Design:** `createScraper` builds `createBanreservasEmpresasCdpScraper({ cdpUrl: resolveBankBrowserEnv(...).cdpUrl, lookbackDays, clock })` from env at call time (lazy, like `createPopularScraperFromEnv`); gate with a per-bank selector env such as `RD_SYNC_BANK_BANRESERVAS_EMPRESAS_SCRAPER=cdp` mirroring `RD_SYNC_SCRAPER=popular-cdp`, otherwise return the existing `needs_admin_action` stub. `createAutoLoginStrategy` returns `createBankAutoLoginStrategy(banreservasEmpresasPortalConfig, { supportedBankCodes: [banreservasEmpresasBankCode] })`. Registry list becomes `[popularAdapter, banreservasEmpresasAdapter]`; the distinct-port guard now protects both.
- **Tests:** routing by `banreservas_empresas` returns the CDP scraper when the env selector is set and the stub otherwise; `popular` unchanged; `banreservas` (brand) still fails closed; run-now validation accepts the portal code; credential API accepts the portal code.
- **Budget:** ~200 lines.

### PR-B6 — Auto-login enablement

- **Goal:** an expired session recovers without an operator when the credential is stored and `autoLoginEnabled` is true.
- **Files:** `src/worker/scraper/bank-runtime.ts` (opener already composed in B2), `src/worker/authenticated-ingestion-production-processor.test.ts` (Banreservas scenarios), `src/worker/scraper/auto-login.test.ts` (strategy with the Banreservas config), `src/modules/bank-auto-login-config` defaults if a per-bank default is needed.
- **Design:** no new mechanism. Verify the end-to-end order with fakes: probe → `unauthenticated` → config enabled + breaker closed → lock → credential decrypt → guard → fill/submit → post-login `dashboardPathIndicator` → `collect()` (with PR-B3, the freshly logged-in tab or a newly opened frameset tab is found). Confirm the auto-login tab lifecycle: if the opener closes its page after login, the scraper relies on B3; if it keeps it, the checker must accept it.
- **Tests:** expired → auto-login → collected; wrong password → `needs_admin_action` + breaker attempt recorded; `autoLoginEnabled=false` → `skipped(disabled)`; breaker open → manual; lock busy → transient; kill switch (`BankAdapterConfig.scrapingEnabled=false`) → no collection.
- **Budget:** ~250 lines (mostly tests).

### PR-B7 — Operator surface

- **Goal:** an operator can launch, connect, store the credential, and see the bank without env overrides or SQL.
- **Files:** `scripts/launch-bank-browser.ps1` and `.sh` (`VERIFIED_PORTAL_START_URLS`), `docs/runbooks/bank-session.md` (Banreservas Empresas section: port 9225, profile dir, first manual session), `src/app/admin/bank-connections/page.tsx` (+ test: a `banreservas_empresas` connection card with `BankAutoLoginSettings`), `Bank` row provisioning (`prisma/seed.ts` upsert or a data migration; see Open Questions), `.env.example` entries.
- **Tests:** launcher shell/PowerShell parity test if one exists for the verified map; admin page renders both connections; seed idempotent.
- **Budget:** ~200 lines; split UI from ops if it grows.

### PR-B8 — Supervised activation (no product code)

1. Server env: `RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL=http://127.0.0.1:9225`, scraper selector env from B5, optional `RD_SYNC_BANK_BROWSER_AUTO_LAUNCH=enabled` with the launch command from the runbook.
2. Launch the isolated browser once, sign in manually, mark the browser as trusted if the portal offers it, confirm the session monitor reports `active`.
3. Store the credential through the existing admin API; leave `autoLoginEnabled=false`.
4. Run one supervised run-now; verify `ScrapeRun` succeeded, `Transaction` rows for both accounts with correct currencies, operator UI shows them.
5. Enable `autoLoginEnabled=true`; let the session expire; verify recovery and the audit trail; verify the breaker opens on a deliberately wrong credential in a staging profile only.
6. Rollback: `autoLoginEnabled=false`, `scrapingEnabled=false`, unset the env endpoint.

---

## 5. Portal Facts the Team Can Rely On (sanitized)

- Frameset `Default.aspx`: `topFrame` → `Header.aspx` (logout link marker), `leftFrame` → `Menu.aspx` (menu anchors target `mainFrame`), `mainFrame` → `Home.aspx`, plus two advertising frames to ignore.
- Accounts query: `Pages/Accounts/Accounts.aspx`, DevExpress grid `ctl00_MainHolder_AccountGrid_AccountASPxGridView`, `allowSelectByRowClick` + single selection, `SelectionChanged` handler redirects `mainFrame` to `Pages/Common/ProductStatus.aspx?<rowKey>` (never log the query string).
- Detail: `select#ctl00_MainHolder_cmbProducts` auto-postbacks on change (disabled options are type headers; selectable values are `<ProductType>_<ProductId>`, texts `<number>|<currency>`); masked period inputs (`99/99/9999`, typed as `DDMMYYYY`, server accepts DD/MM/YYYY); `ddlTransactionTypes` defaults to both directions; `Consultar` is an UpdatePanel async postback; the server remembers the last period per session.
- Movements grid `ctl00_MainHolder_AccountTransactionGrid_ASPxGridViewTransactions`: 20 rows per page, rows `tr[id*="_DXDataRow"].dxgvDataRow` with exactly six direct `td` (Fecha `DD/MM/YY`, Nro. Transacción inside a child element, Concepto, Débitos, Créditos with `0.00` on the inactive side, Balance cell holding a nested four-cell table `DOP d,ddd.dd`). Empty results render a DX empty row.
- Pagination: custom `divPager` with `lnkPrevious` / `lnkNext` inside UpdatePanels and hidden `hdnMovementDirection`; disabled = class `aspNetDisabled` and no `href` (the `disabled` attribute is not used); a full last page still shows Next enabled and returns an empty page on click. Export links (PDF, QIF, CSV, Excel) sit in the same bar and are never addressed.
- Session behavior: a restored `Default.aspx` tab can render stale DOM after the server session expired; the checker therefore requires the header marker and a portal `mainFrame` route, and PR-B3 must re-verify `active` after opening a page. The browser process was observed to disappear once without any `close()` from tooling; `chromium.connectOverCDP(...).close()` only detaches.

---

## 6. Global Risks

| Risk | Mitigation |
|---|---|
| Portal DOM drift (DevExpress ids, pager markup) | Profile-driven selectors, portal-drift fixtures in PR-B4, fail-closed collection with no partial rows |
| Cross-bank session attach | Distinct CDP ports enforced by `assertDistinctBankCdpEndpoints` and the launcher; Banreservas endpoint never inherits `RD_SYNC_CDP_URL` |
| Auto-login typing into the wrong page | `LoginMutationGuard` asserts allowlisted path and required controls before any fill; unknown post-submit state → `needs_admin_action` |
| Currency mislabeling | PR-B1 before registration |
| Duplicate movements across runs | `createSourceHash` dedupe on upsert; stable fingerprint per account; deterministic reference/concept normalization |
| Long lookback windows on busy accounts | 90-day cap, 100-page cap per account, stuck-page detection |
| Operator confusion between brand and portal codes | Only `banreservas_empresas` in registry, run-now list, credentials, and runtime; brand metadata stays display-only |

---

## 7. Open Questions (maintainer decision needed)

1. **`Bank` row provisioning.** `prisma/seed.ts` seeds roles and the admin user only. How was the `popular` row created in each environment? Decide between a seed upsert and a data migration for `banreservas_empresas` (name: "Banreservas Empresas").
2. **UI naming.** `BANKS` in `src/lib/banks.ts` is keyed by brand (`banreservas`). Add a portal-level entry or map portal → brand for logos and labels.
3. **Auto-login tab lifecycle.** Confirm whether `createScrapeTimeAutoLoginBrowserOpener` closes its page after a successful login; PR-B3 covers both outcomes but the tests in PR-B6 must reflect the real one.
4. **Failure states on `Login.aspx`.** Wrong password, locked user, and forced password change were not observed. PR-B4 needs the operator to trigger them in a staging profile or document them as unobserved.
5. **Banreservas Personas** stays `deferred`; nothing in this roadmap touches it.

---

## 8. How the Executor Agents Should Use This Roadmap

- One writer per pane; no parallel writers on the same branch. Delegate exploration only when a slice needs four or more unfamiliar files.
- TDD per slice: write the failing test, run it, implement, run again, then the full gate. Include the RED confirmation in the PR description.
- Reconnaissance is sanitized and read-only: ids, tags, routes, booleans, and value shapes only; no credentials, cookies, tokens, names, accounts, balances, movements, raw HTML, storage, network bodies, or screenshots. Never open transfers, payments, beneficiaries, approvals, administration, downloads, or exports.
- Keep every PR ≤400 changed lines without gaming the budget; split by work unit (tests live with the behavior they verify).
- Do not register, enable, or cut over anything in production from a development pane; PR-B8 is executed by the maintainer with the runbook.
- Record non-sensitive discoveries in Engram under `rd-sync` (topics `recon/banreservas-empresas-*`, `impl/banreservas-empresas-*`) and update #111 only when the maintainer asks.
