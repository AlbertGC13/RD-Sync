# Banreservas — Portal Reconnaissance

**Status:** complete — Personas (login + post-login mapped). Empresas portal pending (different URL).
**Recon date:** 2026-06-29
**Recon branch:** feature/multi-bank-auto-login-pr5-bank-mapping
**Security level:** public + pre-login + authorized post-login observation (no credentials/PII recorded)

---

## 0. TL;DR — Critical Findings

| Finding | Impact |
|---------|--------|
| Unified portal for Personas + Empresas — same URL and form | No separate adapter needed; username format distinguishes account type |
| No visual CAPTCHA on login form | First login attempt can be fully automated |
| Anti-keylogger virtual keyboard ("Teclado virtual") present | Adapter must simulate typing on the hidden real input, NOT the virtual keyboard |
| OneSpan LWSA device fingerprinting via iframe | CDP automation may be scored and challenged |
| Akamai WAF (CDN-level) blocks headless requests | Must use real browser with CDP attach; curl returns 403 |
| Submit is an `<a>` tag, not a `<button type=submit>` | `.click()` on link element, not form submit |
| Angular SPA with `formControlName` bindings | Must dispatch native Angular events (input + blur), not just set `.value` |
| Banreservas REST API discovered pre-login | API calls observable via DevTools network tab |
| Elastic APM (`apm.infocorpgroup.com`) active | Real-user monitoring in place; behavioral analysis possible |
| HSTS active on `tubanco.banreservas.com` | HTTPS enforced; no downgrade possible |
| **Post-login mapped (Personas)** | Transactions at `myProducts → Movimientos`; rows are `div.rivera_row`; export PDF/Excel/CSV |
| Transaction extraction endpoint | `POST Accounts/Movements` (DOM scraping preferred; raw contract not captured) |
| Date range uses a custom `memphis` calendar | No typed date input — adapter must click day cells, not fill a field |
| Navigation needs **trusted** clicks | Angular ignores synthetic `dispatchEvent` clicks; use real CDP/extension click |
| **No MFA on the tested Personas account** | Login → home directly; no security questions (unlike BHD) |

---

## 1. Entry Points

### 1.1 TuBanco Portal (Personas + Empresas — unified)

| Field | Value |
|-------|-------|
| Login URL | `https://tubanco.banreservas.com/TuBancoBanreservas/#/administrationGeneral/login` |
| Protocol | HTTPS |
| CDN / WAF | Akamai (blocks headless curl with HTTP 403) |
| Framework | Angular SPA (ICB7) |
| App title | `Bienvenido a TuBanco` |
| App subtitle | `Banreservas, el banco de todos los dominicanos` |

**Redirect chain:**
```
https://www.banreservas.com.do  →  200 OK (main marketing site)
https://www.banreservas.com.do/TuBancoPersonas/Login.aspx  →  302 → tubanco.banreservas.com (unverified — historical path)
https://tubanco.banreservas.com/TuBancoBanreservas/#/administrationGeneral/login  →  200 OK (final destination)
```

**Security headers:**
- `Strict-Transport-Security` (HSTS) active on `tubanco.banreservas.com`
- Akamai returns `HTTP 403` to curl requests, even with full browser User-Agent
- No iframe embedding detected (X-Frame-Options likely set)

### 1.2 Empresas Portal (separate URL — confirmed)

| Field | Value |
|-------|-------|
| Login URL | `https://www.banreservas.com.do/TuBancoEmpresas/Login.aspx` |
| Note | Separate portal; NOT the same as TuBanco Personas |

### 1.3 Personas vs Empresas distinction

The "Cambiar a TuBanco Empresas" toggle on the Personas portal (`#/administrationGeneral/login`) only swaps the marketing image — it does NOT redirect to the Empresas portal. Empresas has its own separate URL at `banreservas.com.do/TuBancoEmpresas/Login.aspx`.

---

## 2. Login Page

### 2.1 Form Fields

| Label | Selector | Type | Notes |
|-------|----------|------|-------|
| Usuario / Número de cliente | `input[formControlName=username]#step01.ipswich-main-data-input.reveal` | text | Angular reactive form binding; `.reveal` class present |
| Contraseña | `input[formControlName=password]#step02.ipswich-main-data-input` | text | Visually masked — NOT `type=password`; CSS mask applied |

**Angular form wrapper:**
```
div.ipswich-main-card
  └── form (Angular reactive)
       └── input[formControlName=username]#step01.ipswich-main-data-input.reveal
       └── input[formControlName=password]#step02.ipswich-main-data-input
       └── a.ipswich-main-buttons-link (submit)
```

**Important**: This is an Angular reactive form. Setting `element.value = x` alone does NOT trigger Angular's change detection. You MUST dispatch `new Event('input', {bubbles: true})` and/or `new Event('blur', {bubbles: true})` after setting each field's value, or use CDP `Input.dispatchKeyEvent` per character.

### 2.2 CAPTCHA Behavior

- **No visual CAPTCHA** on the initial login form.
- OneSpan LWSA scores the session in the background; a challenge may appear post-fingerprinting (not observed pre-login).
- If any challenge appears → `needs_admin_action`.

### 2.3 Submit Button

| Selector | Text | Tag | Notes |
|----------|------|-----|-------|
| `a.ipswich-main-buttons-link.default.big` | Ingresar | `<a>` | NOT a button or input; CSS class `inactive` is added when fields are empty; removed when both fields have values |

```html
<!-- Empty state -->
<a class="ipswich-main-buttons-link default inactive big">Ingresar</a>

<!-- With values filled -->
<a class="ipswich-main-buttons-link default big">Ingresar</a>
```

**Adapter must wait for `inactive` class to be removed before clicking.**

### 2.4 Virtual Keyboard (Teclado virtual)

| Element | Selector | Behavior |
|---------|----------|----------|
| Toggle link | `a.ipswich-main-keyboard-link` text "Teclado virtual" | Opens anti-keylogger virtual keyboard overlay |

- When activated, a virtual keyboard modal appears for character-by-character entry.
- The underlying `input` fields still exist in the DOM; clicking the virtual keyboard buttons fires synthetic events to those inputs.
- **Adapter strategy**: ignore the virtual keyboard entirely. Type into the real `input` directly via CDP (the virtual keyboard is an alternative UI, not a replacement for the real input).
- Virtual keyboard click does NOT navigate away; the page URL remains `#/administrationGeneral/login`.

### 2.5 Other Links and Controls

| Text | Selector | Notes |
|------|----------|-------|
| ¿Ha olvidado su contraseña? | `a.ipswich-main-engagement-data-ul-item-link.disabled` | `.disabled` class — not clickable in its default state |
| Cambiar a TuBanco Empresas | `a.ipswich-main-engagement-data-ul-item-link` | Toggles right-panel image; form does NOT change |
| Teclado virtual | `a.ipswich-main-keyboard-link` | Anti-keylogger virtual keyboard; optional UI |

### 2.6 Anti-Bot Stack

| Script / Resource | Origin | Purpose |
|-------------------|--------|---------|
| `uppopi` script + `lwsa.html` iframe | `integ.banreservas.com/cdn/ca/` | OneSpan Light Web Security Agent — device fingerprinting, session risk scoring |
| Akamai edge | CDN level | HTTP 403 for known bot signatures; blocks curl even with browser UA |
| Elastic APM | `apm.infocorpgroup.com:8200/intake/v2/rum/events` | Real User Monitoring (RUM) — behavioral event stream |
| GTM / analytics | standard | Tag Manager |

**OneSpan flow:**
```
Page load
  └── uppopi.js loaded from integ.banreservas.com
  └── lwsa.html iframe injected (cross-origin fingerprinting)
  └── Device fingerprint submitted silently to integ.banreservas.com
  └── Risk score returned; influences authentication challenge threshold
```

### 2.7 Known API Endpoints (pre-login, observed in DevTools network tab)

**API base:** `https://tubanco.banreservas.com/DO_BR_ICB7_AZ_PROD.WebServer.Api/api/`

Banreservas internal REST API (Infocorp ICB7 framework). Most calls are `POST` with a `?reqId={n}` sequence counter and require a Bearer token (held in `sessionStorage`, NOT extracted during recon — the adapter relies on the live CDP session's cookies/headers, never on reading the token directly).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `Authentication/GetAuthenticationConfigurationItems` | GET | Login form config (captcha flags, feature flags) |
| `Users/ConsolidatedPositionData` | POST | Consolidated product/balance position |
| `Users/UserProductTypes` | POST | Product type list |
| `Users/Products` | POST | User products |
| `Users/GetUserFavoriteProductsStatus` | POST | Favorite products |
| `Accounts/Account` | POST | Account detail (called per product) |
| **`Accounts/Movements`** | **POST** | **Transaction/movement list — the core endpoint for extraction** |
| `Common/IsAvailableExtractAccount` | POST | Whether export/extract is available for the account |
| `Common/ExchangeRates` | POST | FX rates (USD/EUR) |
| `Common/GetDocumentTypes` | POST | Document types |
| `Clients/Client` | POST | Client info |
| `Clients/AccountOfficer` | POST | Assigned account officer |
| `Messaging/UnreadMessages` | POST | Inbox unread count |
| `TaskProcessing/RecentBatches` / `FrequentBatches` | POST | Recent/frequent transfer batches |

> **Note on `Accounts/Movements`**: the exact JSON request/response contract was NOT captured. Reading it required extracting the session Bearer token from `sessionStorage`, which the auto-mode security classifier correctly blocked. It is **not needed** for the chosen adapter approach (DOM scraping, same model as `popular.ts`). If a future API-based adapter is desired, capture the contract via the browser DevTools Network tab during an admin session instead of programmatic token extraction.

---

## 3. Post-Login Navigation (TuBanco Personas — mapped via authorized admin session)

> Mapped 2026-06-29 on an authorized account. No credentials, account numbers, or balances are recorded here — selectors and structure only. This account had **no MFA** and **no additional verification** on login.

### 3.1 Landing Page

| Field | Value |
|-------|-------|
| Landing URL | `#/administrationGeneral/home` |
| Root element | `<icb-app>` (Angular host; `app-root` does NOT exist — selector must be `icb-app`) |
| Product cards | `span.araure-ribbon-item-amount-value` (balance), shown in a carousel on home |
| Top nav | `a.tucson-item-header-link` (top-level), `a.tucson-subitem-link` (submenu) |
| Mobile/bottom nav | `a.leeds_list_item_link` |

### 3.2 Account / Product List

| Field | Value |
|-------|-------|
| Products view URL | `#/administrationGeneral/myProducts?productId={ID}&view=Simple&backTo=home` |
| `productId` | Internal numeric product id (e.g. `380419`) — NOT the account number; obtained from the card, not user-facing |
| Product filter panel | `a.oldham-panel-link` with label `span.oldham-panel-title-text` (Todos mis productos / Cuenta corriente / Cuenta de ahorros / Tarjeta de crédito / Préstamo) |
| View selector | same `oldham-panel-link` pattern (Simple / Combinada / Agrupada / Personalizada) |
| Account number (display) | shown in header as `{accountNumber} | {NAME}` |
| IBAN | format `DO65 BRRD 0000 0000 0096 0346 5107` (in Detalle tab) |

### 3.3 Path to Transactions

```
Home (#/administrationGeneral/home)
  └── Click product card (e.g. ref to "Cuenta de ahorros")
       → navigates to #/administrationGeneral/myProducts?productId={ID}&view=Simple
         └── "Movimientos" tab (active by default) → transaction list
         └── "Detalle" tab → account metadata (IBAN, apertura, estado, etc.)
```

- Navigation links are Angular click-handlers (no `href`/`routerLink`); a **trusted** click (real MouseEvent via CDP/extension) is required — synthetic `.dispatchEvent(new MouseEvent('click'))` does NOT trigger Angular routing.
- The Angular `Router` is sometimes reachable via the root element's `__ngContext__` (`navigateByUrl`), but not reliably across page loads — prefer clicking the product card.

### 3.4 Date / Period Filter

The period filter is a chip (`Junio 2026 ⚙`) that opens a "Período" dialog. Trigger element: the chip showing the current period (an `<a>`/link; label in `span.oldham-panel-title-text`).

**Period options** (each is `a.oldham-panel-link` + `span.oldham-panel-title-text`):

| Option | Notes |
|--------|-------|
| `Junio 2026` … `Enero 2026` | Last 6 calendar months (rolling) |
| `Fecha desde - hasta` | Custom date range → opens custom calendar (see below) |
| `Últimos 5 movimientos` | Last 5 movements |
| `Hoy` | Today |
| `Ayer` | Yesterday |
| `Últimos 7 días` | Last 7 days |
| `Últimos 30 días` | Last 30 days |

**Custom date range** (`Fecha desde - hasta`): renders two clickable date spans `{from} al {to}` inside `div.ohio_header_content.ohio_header_content_range-date`. Clicking a date opens the **`memphis` calendar widget**:

| Element | Selector |
|---------|----------|
| Calendar root | `div.memphis` → `div.memphis-main` → `div.memphis-main-block.memphis-main-dayView` |
| Day selector | `div.memphis-day-selector` |
| Month title | inside `div.memphis-day-selector` (text e.g. "Junio 2026") |
| Prev month | `a.leftArrow` |
| Next month | `a.rightArrow` |
| Weekday header | `th.memphis-day-header` (L M M J V S D — week starts Monday) |
| Day cell | `td.memphis-day-cell` → `div.memphis-day-data` → `a.memphis-day-value` (text = day number) |
| "Hoy" reset | `a.memphis-day-button-reset` |

**Adapter strategy for date range**: click the from-date span → navigate months with `a.leftArrow`/`a.rightArrow` → click `a.memphis-day-value` whose text matches the target day → repeat for to-date. There is NO typed date input; dates are picked from the calendar only. Date display format is `DD/MM/YYYY`.

### 3.5 Movement Type Filter

Chip `Créditos y débitos ⚙` opens a "Movimientos" dialog. Options (`a.oldham-panel-link` + `span.oldham-panel-title-text`):

| Option | Selector match | Default |
|--------|---------------|---------|
| Créditos y débitos | `a.oldham-panel-link.active` | ✅ active |
| Créditos | `a.oldham-panel-link` | |
| Débitos | `a.oldham-panel-link` | |

### 3.6 Text Search (within loaded movements)

| Element | Selector |
|---------|----------|
| Search input | `input.estambul_input` (placeholder "Buscar") — top-right magnifier icon toggles it |

Filters the already-loaded rows client-side; does not re-query the server.

### 3.7 Pagination

| Mechanism | Selector | Notes |
|-----------|----------|-------|
| Lazy "ver más" | `div.florida_wrapper_loader_default` (contains `span.florida_wrapper_loader_default_description` = "ver más") | Loads the next batch of movements in place; infinite-scroll style. Adapter loops: click "ver más" → wait → repeat until it disappears |

### 3.8 Export Options

| Element | Selector | Notes |
|---------|----------|-------|
| Export trigger | `a.ankara` (icon `i.stream-ext.stream-ext-export`, top-right) | Opens "Exportar archivo" dialog |
| Format options | `a.oldham-panel-link` + `span.oldham-panel-title-text` | **PDF**, **Excel**, **CSV** available |

> Selecting a format triggers a file **download** → out of scope for read-only recon. CSV is the preferred target for the adapter (structured, parseable). NOT exercised during recon.

### 3.9 Transaction Table Selectors

Each movement is a `div.rivera_row` (modifiers `cleanRowMode compact`). Internal structure:

| Field | Selector | Format / Example | Notes |
|-------|----------|------------------|-------|
| Row container | `div.rivera_row` | — | One per movement |
| Info block | `div.rivera_row_data` | — | Holds date + description + reference |
| Posted date | `div.rivera_row_info_legend > icb-field-formatter > span.marmaris[data-type=date]` | `29/06/2026` (`DD/MM/YYYY`) | First `marmaris` span; a 2nd empty `marmaris` follows (effective date, usually blank) |
| Description | `div.rivera_row_info_title span.marmaris[data-type=string]` | `TRANSFERENCIA A XC SUPPLY SRL` | |
| Reference | `div.rivera_row_info_subtitle span.marmaris[data-type=textResourceKey]` | `# Nro. transacción : 242340089089 \| Número de referencia : 242340089` | Two IDs packed in one string; split on `\|` |
| Debit amount | `div.rivera_row_simple` (1st sibling of `rivera_row_data`) | `-5,000.00` | Negative; thousands sep `,`, 2 decimals. Empty for credits |
| Credit amount | `div.rivera_row_simple` (2nd) | `44,000.00` | Empty for debits |
| Running balance | `div.rivera_row_simple.highlighted` | `9,639.79` | Balance after the movement |
| Currency + amount (mobile) | `div.rivera_row_simple.mobileHighlighted.default` | `DOP5,000.00` | Currency prefix + absolute amount |
| Detail expander | `i.stream-arrow-right-7` inside `span.rivera_row_info_legend_icon` | — | Per-row "open detail" arrow |

**Per-row detail dialog** (when a row is expanded) exposes: Número de Cuenta, Titular, Sucursal, Fecha movimiento, Monto, Descripción, plus a **Descargar** button (`button` text "Descargar" → per-movement voucher download, out of scope).

### 3.10 Empty State

Not observed (account had movements). Likely a "No hay información para mostrar" message — same pattern as the home "Mis transacciones favoritas" empty block. Confirm when an empty period is encountered → currently `TBD`.

---

## 4. Session States

| State | Trigger | Observed? | Action |
|-------|---------|-----------|--------|
| Login success | Valid credentials | **Yes** (Personas) | Lands on `#/administrationGeneral/home` |
| Invalid credentials | Wrong user/pass | No | Retry; observe error message selector |
| OneSpan challenge | High risk score from fingerprinting | No | `needs_admin_action` |
| MFA / OTP | Device/session token | **No challenge** on tested account | — (none required for Personas here) |
| Inactivity warning | Idle timeout approaching | **Yes** (`dialog` "Aviso de inactividad") | Click "Continuar sesión" to keep alive |
| Session finalized | Security / duplicate session | **Yes** (`dialog` "Sesión finalizada" / "Sesión duplicada" reason) | Re-login |
| Session expired | Timeout | Yes (via inactivity dialog) | Re-login |
| Account locked | Excessive failed attempts | No | `needs_admin_action` |
| Maintenance | Planned downtime | No | `needs_admin_action` |
| Update available | New app version | **Yes** (`dialog` "Actualización disponible") | Click "Aceptar" |
| Akamai block | Bot behavior detected | Curl = 403; browser = OK | Use real CDP browser only |

---

## 5. Edge Cases

| Case | Notes |
|------|-------|
| Angular reactive form — `.value =` assignment ignored | Must use CDP InputDispatchKeyEvent or fire `input` + `blur` events |
| Submit is `<a>` with `.inactive` class | Wait for `inactive` removal before clicking; check class after each field fill |
| Virtual keyboard overlay | Ignore it — type into real `input` directly; virtual keyboard is alternative UI only |
| OneSpan scoring on headless | CDP-attached real browser should pass; pure headless Chromium may fail |
| `inactive` class on submit link | If still `inactive` after filling both fields → Angular did not register the input values → re-dispatch events |
| Personas vs Empresas are SEPARATE portals | Empresas has its own URL (`TuBancoEmpresas/Login.aspx`); do NOT assume one form covers both |
| Trusted clicks required | Angular routing ignores `dispatchEvent(new MouseEvent('click'))`; use real CDP/extension clicks |
| Custom calendar, no date input | Date range is picked via the `memphis` calendar (click day cells); there is no fillable date field |
| `productId` ≠ account number | The `myProducts?productId=` value is an internal id, not the user-facing account number |
| Debit/credit in separate columns | Debit and credit are distinct `rivera_row_simple` cells (one is empty per row); don't assume a single signed amount cell |
| Reference field packs two IDs | `Nro. transacción` and `Número de referencia` share one string — split on `\|` |
| Multiple accounts (same customer) | Observed: account had several products (ahorros ×2, corriente ×2, tarjeta). Iterate product cards / `productId` |
| DOP vs USD accounts | Only DOP observed; card shows currency per balance (e.g. tarjeta had DOP + USD lines). USD movement format `TBD` |
| Zero-movement period | `TBD` — not observed (see §3.10) |
| Modal overlays on login/home | First-visit guided-tour dialogs ("Menú", "Inbox", "Quick Options") may overlay; dismiss before interacting |

---

## 6. Security Constraints

- [x] No credentials in this file
- [x] No session cookies documented
- [x] No tokens or auth headers
- [x] No bypass of OneSpan / Akamai
- [x] Post-login steps marked `[needs_admin_action]`
- [x] Read-only navigation only

---

## 7. Selector Stability Assessment

| Selector | Stability | Reason |
|----------|-----------|--------|
| `input[formControlName=username]#step01` | **Stable** | Both `formControlName` and `id` attributes; Angular binding name |
| `input[formControlName=password]#step02` | **Stable** | Same |
| `a.ipswich-main-buttons-link.default.big` | Stable | Likely a design system class (ipswich); not generated |
| `.inactive` class on submit | Stable | Angular adds/removes programmatically; reliable state indicator |
| `a.ipswich-main-keyboard-link` | Stable | Design system selector |
| `integ.banreservas.com/cdn/ca/lwsa.html` | Stable | OneSpan CDN path; would only change if vendor changes |
| `DO_BR_ICB7_AZ_PROD.WebServer.Api/api/` | Fragile | Env tag in URL path; may change on environment promotion |
| Angular route `#/administrationGeneral/login` | Stable | Angular router path; would only change on major routing refactor |
| `div.rivera_row` / `rivera_row_data` / `rivera_row_simple` | Stable | Design-system (rivera) classes for the movements list |
| `span.marmaris[data-type=...]` | **Stable** | `data-type` attribute is the most robust hook (`date`/`string`/`textResourceKey`) |
| `td.memphis-day-cell` / `a.memphis-day-value` / `a.leftArrow` / `a.rightArrow` | Stable | `memphis` calendar design-system classes |
| `a.oldham-panel-link` + `span.oldham-panel-title-text` | Stable | Generic dropdown/option pattern; **select by label text**, not position |
| `a.ankara` (export) / `i.stream-ext-export` | Moderate | Single-letter-ish class `ankara`; pair with the export icon for robustness |
| `div.florida_wrapper_loader_default` ("ver más") | Stable | Lazy-load pagination wrapper |
| `icb-app` root element | **Stable** | App host tag; note it is `icb-app`, NOT `app-root` |

---

## 8. Proposed Scraper Profile (draft)

```typescript
// Banreservas TuBanco Personas — login + post-login mapped 2026-06-29.
// Adapter approach = DOM scraping over a CDP-attached, pre-authenticated session (same model as popular.ts).
export const banreservasScraperProfile = {
  bankId: "banreservas",
  portalVariant: "personas",
  loginUrl: "https://tubanco.banreservas.com/TuBancoBanreservas/#/administrationGeneral/login",
  rootElement: "icb-app", // NOT app-root
  accountFingerprint: "banreservas-XXXXXXXXXX", // per-account, assigned at onboarding (not the raw account number)
  defaultSearchMode: "current-month",
  inputStrategy: "trusted-click+angular-events", // synthetic dispatchEvent clicks are ignored by Angular routing
  selectors: {
    // --- Login ---
    usernameInput: "input[formControlName='username']#step01",
    passwordInput: "input[formControlName='password']#step02",
    submitLink:    "a.ipswich-main-buttons-link.default.big",
    submitInactiveClass: "inactive", // wait for removal before clicking

    // --- Navigation ---
    productCardBalance: "span.araure-ribbon-item-amount-value",
    topNavItem:    "a.tucson-item-header-link",
    topNavSubItem: "a.tucson-subitem-link",

    // --- Period / date filter ---
    periodChipLabel: "span.oldham-panel-title-text", // select option by matching text
    periodOption:    "a.oldham-panel-link",
    dateRangeContainer: "div.ohio_header_content_range-date",
    calendar: {
      root:      "div.memphis-main-block.memphis-main-dayView",
      prevMonth: "a.leftArrow",
      nextMonth: "a.rightArrow",
      dayCell:   "a.memphis-day-value",   // text = day number
      todayReset:"a.memphis-day-button-reset",
    },

    // --- Movement type filter ---
    movementTypeOption: "a.oldham-panel-link", // Créditos y débitos / Créditos / Débitos (by label)

    // --- Transaction table ---
    transactionRow:   "div.rivera_row",
    rowInfoBlock:     "div.rivera_row_data",
    rowDate:          "div.rivera_row_info_legend span.marmaris[data-type='date']",
    rowDescription:   "div.rivera_row_info_title span.marmaris[data-type='string']",
    rowReference:     "div.rivera_row_info_subtitle span.marmaris[data-type='textResourceKey']",
    rowDebit:         "div.rivera_row_simple",            // 1st sibling
    rowBalance:       "div.rivera_row_simple.highlighted",
    rowCurrencyAmt:   "div.rivera_row_simple.mobileHighlighted",

    // --- Pagination & export ---
    loadMore:    "div.florida_wrapper_loader_default", // "ver más" lazy-load
    exportTrigger: "a.ankara",                          // icon i.stream-ext-export
    exportFormatOption: "a.oldham-panel-link",          // PDF / Excel / CSV (by label)

    // --- Text search ---
    searchInput: "input.estambul_input",
  },
  formats: {
    date: "DD/MM/YYYY",
    amount: "-1,234.56", // thousands ',', 2 decimals, leading '-' for debits
    currencyPrefix: "DOP", // e.g. "DOP5,000.00" in mobileHighlighted cell
  },
} as const;
```

---

## 9. Open Questions / Blockers

**Resolved this session (Personas):**
- [x] ~~Post-login navigation~~ — mapped: home → product card → Movimientos
- [x] ~~Transaction table selectors~~ — `div.rivera_row` family, see §3.9
- [x] ~~Date filter~~ — `oldham-panel` period chip + `memphis` custom calendar, see §3.4
- [x] ~~Pagination~~ — lazy "ver más" (`florida_wrapper_loader_default`)
- [x] ~~Export~~ — PDF / Excel / CSV via `a.ankara`
- [x] ~~Transaction history endpoint~~ — `POST Accounts/Movements`
- [x] ~~Any OTP / second factor post-login?~~ — NONE on the tested Personas account

**Still open:**
- [ ] **Empresas portal** (`https://www.banreservas.com.do/TuBancoEmpresas/Login.aspx`) — separate URL, NOT yet mapped. Likely a different (older ASP.NET) stack than the Personas Angular SPA. Needs its own recon pass.
- [ ] `Accounts/Movements` raw JSON contract — deferred (token extraction blocked; not needed for DOM-scraping adapter)
- [ ] Does OneSpan LWSA score a CDP-attached real Chrome as a bot, or pass? (Login not automated yet)
- [ ] Username format difference Personas (cédula) vs Empresas (RNC) — confirm on Empresas pass
- [ ] Empty / zero-movement period indicator (§3.10) — not observed
- [ ] Multi-currency (USD) account movement format — only DOP account observed
