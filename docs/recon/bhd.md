# BHD León — Portal Reconnaissance

**Status:** Personal — login + post-login mapped. Empresarial — pre-login only (always-CAPTCHA, deferred).
**Recon date:** 2026-06-29
**Recon branch:** feature/multi-bank-auto-login-pr5-bank-mapping
**Security level:** public + pre-login + authorized post-login observation (no credentials/PII recorded)

---

## 0. TL;DR — Critical Findings

| Finding | Impact |
|---------|--------|
| TWO separate portals (Personal vs Empresarial) | Must choose which one RD-Sync targets |
| Personal: CAPTCHA hidden, appears on failed login | First attempt may succeed; on CAPTCHA show → `needs_admin_action` |
| Empresarial: CAPTCHA always visible (image-based) | Every login requires human → `needs_admin_action` per session |
| Personal uses Angular/PrimeNG (SPA); no native form submit | Adapter must trigger Angular form submission, not raw POST |
| Empresarial uses IBM WebSphere Portal (legacy GET form) | Classic DOM scraping; stable selector names |
| Google reCAPTCHA v3 running silently in Personal | Behavioral scoring; headless automation may get flagged |
| LogRocket + LexisNexis SDK on both portals | Device/session fingerprinting active |
| Personal: password field is `type=text` masked by CSS | Can be typed into directly |
| Empresarial: CAPTCHA image is inline base64 JPEG | Cannot be fetched from a stable URL; must read `img` src each login |
| **Personal security questions = FIRST login per browser only** | 2 memorized Q&A on first sign-in from a new browser. Checking **"guardar navegador"** (remember device) suppresses them on all later logins → `needs_admin_action` ONCE per browser, then clean |
| **Personal post-login mapped** | Dashboard → account card → product-detail → "Ver estados y movimientos" → PrimeNG datatable |
| Transactions are a clean PrimeNG `p-datatable` | Positional `<td>` columns; far easier to scrape than Banreservas' nested divs |
| Date range = typed PrimeNG datepicker inputs | `placeholder="Fecha inicio"/"Fecha final"`, `DD/MM/YYYY` — no day-cell clicking needed |
| Export "Descargar movimientos" | PDF / EXCEL / TXT — FALLBACK only; primary path is direct DOM table read |

---

## 1. Entry Points

### 1.1 Personal Portal (new — recommended target)

| Field | Value |
|-------|-------|
| Initial URL | `https://ibp.bhd.com.do/#/login` |
| Canonical login URL | `https://ibp.bhd.com.do/#/login` |
| Protocol | HTTPS |
| CDN / WAF | Amazon CloudFront |
| Framework | Angular 17+ + PrimeNG |
| App version | v5.8 (visible bottom-left of login page) |
| App title | `Banco BHD - IBP` |
| Domain | `ibp.bhd.com.do` → IPs: `52.85.78.x` (CloudFront) |

**Redirect chain:**
```
https://www.bhdleon.com.do  →  302  →  https://bhd.com.do/
https://ibp.bhd.com.do/#/login  →  200 OK (no redirect)
```

**Security headers (CloudFront origin):**
- `Strict-Transport-Security: max-age=63072000`
- `X-Frame-Options: SAMEORIGIN`
- CSP: restricts scripts to `ibp.bhd.com.do` + Google/analytics allowlist
- Server: `nginx`

### 1.2 Empresarial Portal (legacy — WebSphere)

| Field | Value |
|-------|-------|
| Login URL | `https://ib.bhd.com.do/wps/portal/ibe/login` |
| Parent shell URL | `https://ib.bhd.com.do/wps/portal/banking/!ut/p/z1/...` |
| Protocol | HTTPS |
| Framework | IBM WebSphere Portal + jQuery + select2 |
| App title | `Banco BHD / Empresarial` |

**Notes:**
- The outer WebSphere shell embeds the form in an `<iframe src="https://ib.bhd.com.do/wps/portal/ibe/login">` — inspect the iframe URL directly, not the shell.
- The "← Ir a Internet Banking Empresarial" link on the Personal portal triggers a JS click handler (no routerLink) that navigates to the WebSphere shell URL.
- `https://ib.bhd.com.do/wps/portal/BHD/` returns 404 — stale redirect from `ib.bhd.com.do`.

---

## 2. Login Page — Personal Portal

### 2.1 Form Fields

| Label | Selector | Type | Notes |
|-------|----------|------|-------|
| Usuario | `input#userName[name=userName][formcontrolname=username]` | text | PrimeNG `p-inputtext-lg`; has clear (×) button |
| Contraseña | `input#password[name=password][formcontrolname=password]` | text | Visually masked by CSS class `password-mask`; NOT `type=password` |
| CAPTCHA | `input[name=captcha][formcontrolname=captcha]` | text | maxlength=4; parent `div.field.col-10.mb-2` has `display:none` initially |

**Form wrapper (Angular):**
```
form.ng-invalid > div.grid > div.p-card-content > div.p-fluid.formgrid.grid.justify-content-center
  └── div.field (Usuario)
  └── div.field (Contraseña)
  └── div.field.col-10.mb-2 [display:none] (CAPTCHA area)
       └── div.bhd-captcha > canvas[width=110][height=30]
       └── div.captchaInput > input[name=captcha]
```

### 2.2 CAPTCHA Behavior

- **Type**: HTML5 Canvas, 4 characters, 110×30 px; rendered client-side.
- **Visibility**: Hidden (`display:none` on parent `.field`) on page load.
- **Trigger**: Parent becomes visible after a failed login attempt (unconfirmed — inferred from DOM state).
- **Google reCAPTCHA v3**: Also loaded (`recaptcha__es.js`); runs invisibly in background and scores behavior.
- **Action**: If CAPTCHA becomes visible → `needs_admin_action`.

### 2.3 Submit Button

| Selector | Text | Notes |
|----------|------|-------|
| `button[type=submit].p-ripple.p-button.p-component.bhd-btn-primary` | Entrar | PrimeNG button; also wrapped by `p-button` custom element |

### 2.4 Other Links

| Text | Selector / Behavior |
|------|---------------------|
| ¿Olvidaste tu clave de acceso? | JS click handler (no `href`, no `routerLink`) |
| ← Ir a Internet Banking Empresarial | JS click handler → navigates to Empresarial WebSphere portal |

### 2.5 Anti-Bot Stack (Personal)

| Script | Origin | Purpose |
|--------|--------|---------|
| `recaptcha__es.js` | `gstatic.com` | Google reCAPTCHA v3 (invisible scoring) |
| `sdk.min.js` | `ibp.bhd.com.do/assets/scripts/` | Unknown — likely behavior analytics |
| `logger-1.min.js` | `cdn.lgrckt-in.com` | LexisNexis ThreatMetrix / LogRocket |
| `qualtrics.js` | `ibp.bhd.com.do/assets/scripts/` | Session recording / surveys |
| `SIE` iframe | `zn8ceqhp0zudybf7e-bancobhdleon.siteintercept.qualtrics.com` | Qualtrics Site Intercept |

---

## 3. Login Page — Empresarial Portal

### 3.1 Form Fields

| Label | Selector | Type | Notes |
|-------|----------|------|-------|
| Portal type | `select.loginCombo.select2-hidden-accessible` | select-one | Only option: "Empresarial" (value=2); rendered by select2 |
| Cédula / Pasaporte | `input[name=documentType].idNumber` | radio | "Cédula" selected by default |
| _(alternate)_ | `input[name=documentType].passportNumber` | radio | "Pasaporte" |
| Cédula o pasaporte | `input[name=User]` | text | maxlength=20; placeholder="Cédula o pasaporte" |
| Clave de acceso | `input[name=Password]` | password | Standard type=password |
| CAPTCHA | `input[name=Captcha].captcha` | text | maxlength=4; placeholder="Digite imagen"; `data-nbc="recaptcha"` |

**Form:**
```html
<form action="https://ib.bhd.com.do/wps/portal/ibe/login" method="get">
  <ul>
    <li> ... select2 dropdown ... </li>
    <li> ... radio buttons ... </li>
    <li> ... User input ... </li>
    <li> ... Password input ... </li>
    <li class="captchaBlock">
      <p> [background-image: base64 JPEG 150×50 — CAPTCHA image] </p>
      <div class="captchaInput">
        <input type="text" name="Captcha" class="captcha" maxlength="4" data-nbc="recaptcha">
      </div>
    </li>
    <li> ... submit ... </li>
  </ul>
</form>
```

### 3.2 CAPTCHA Behavior (Empresarial)

- **Type**: Server-generated JPEG image (150×50 px), embedded as inline base64 `data:image/jpeg;base64,...` in a CSS `background-image` on a `<p>` element inside `li.captchaBlock`.
- **Visibility**: **ALWAYS visible** — shown on every page load.
- **Refresh**: `a[href="javascript:;"]` text "Refrescar imagen" → JS handler fetches a new captcha image and updates the background.
- **Action**: Every login attempt requires CAPTCHA → **`needs_admin_action` on every session**.

### 3.3 Submit Button

| Selector | Value | Notes |
|----------|-------|-------|
| `input[type=submit].submit` | Entrar | Standard HTML submit; form method=GET |

### 3.4 Anti-Bot Stack (Empresarial)

| Script | Origin | Purpose |
|--------|--------|---------|
| `logger-1.min.js` | `cdn-staging.logrocket.io` | LogRocket session recording |
| `a80c73a9/c803f5ba.js` | `j.bhd.com.do` | Custom analytics / bot detection |
| GTM | `googletagmanager.com` | Google Tag Manager |

---

## 4. Post-Login Navigation (BHD Personal — mapped via authorized admin session)

> Mapped 2026-06-29 on an authorized account. No credentials, account numbers, or balances recorded — selectors and structure only. **Login required answering security questions** before reaching the dashboard (see §5).

### 4.1 Landing Page

| Field | Value |
|-------|-------|
| Landing URL | `#/bhd/dashboard` |
| Top nav (PrimeNG menubar) | `menubar` with links: `#/bhd/dashboard` (Mis Productos), `#/bhd/payments-transfers` (Pagos y Transferencias), `#/bhd/requests-claims` (Solicitudes y Reclamaciones), `#/bhd/offers` (Ofertas) |
| Products summary | "360 - Resumen de Productos", grouped collapsible sections: **Cuentas**, **Tarjetas**, **Centro Financiero BHD** |
| Account card | Shows product name + number (e.g. `02301820014`), type (Ahorros), state (Activa), `Balance disponible`, `Balance en tránsito`; each card has a `⋮` (3-dot) menu |

### 4.2 Account / Product List

| Field | Value |
|-------|-------|
| Cuentas section | Lists each account as a clickable card |
| Card click target | Clicking the card name navigates to `#/bhd/product-detail` |
| Product selector (on detail) | `div.p-select-dropdown` (PrimeNG) — switch between products without going back |
| Detail fields | Número de producto, Cuenta estándar (IBAN `DO24BCBH...`), Tipo de cuenta, Estado, Balance disponible / en tránsito / actual / promedio del mes |

### 4.3 Path to Transactions

```
Dashboard (#/bhd/dashboard)
  └── Click account card (Cuentas section)
       → #/bhd/product-detail  (account summary)
         └── Green button "Ver estados y movimientos"
              → expands the movements panel inline (filters + p-datatable) on the same route
```

- **"Ver estados y movimientos"** button: `button.bhd-btn-primary.p-button` (PrimeNG). This is the gate to the transaction table.
- Navigation is Angular SPA (PrimeNG); routes are real hash routes (`#/bhd/...`) and the nav links DO carry `href`, unlike Banreservas.

### 4.4 Filters

**Type filter** (button group): `Todos` / `Débitos` / `Créditos`

| Tab | Selector (stable part) | Default |
|-----|------------------------|---------|
| Todos | `button.bhd-btn-tab-select` (selected state) | ✅ |
| Débitos | `button.bhd-btn-tab-default` (+ `border-tab`) | |
| Créditos | `button.bhd-btn-tab-default` (+ `bhd-btn-tab-border-radius.right`) | |

**Period dropdown** (`div.p-select-dropdown`, label shows current period). Options:

| Option | Notes |
|--------|-------|
| `Último mes` | Default |
| `2 últimos meses` | |
| `3 últimos meses` | |
| `Rango de fecha` | Custom range → reveals two date inputs (see §4.5) |

**Text search**: `input[placeholder="Buscar"]` (client-side filter of loaded rows).

### 4.5 Date Range Filter

Selecting `Rango de fecha` replaces the period dropdown with two **PrimeNG datepicker inputs** + a back arrow (`←`) to return to the preset dropdown:

| Field | Selector | Format | Notes |
|-------|----------|--------|-------|
| Fecha inicio | `input.p-datepicker-input[placeholder="Fecha inicio"]` | `DD/MM/YYYY` | Accepts **typed** input OR calendar picker |
| Fecha final | `input.p-datepicker-input[placeholder="Fecha final"]` | `DD/MM/YYYY` | Same |
| Back to presets | the `←` button (`button.bhd-btn-tab-select.left`) | — | Returns to the preset period dropdown |

> **Easier than Banreservas**: these are real `<input>` PrimeNG datepickers that accept typed dates — the adapter can set the value + dispatch `input`/`blur`, no day-cell clicking required. (Avoid the dynamic `ng-tns-c...-NN` class fragment — match on `placeholder` instead.)

### 4.6 Pagination

The table is a **PrimeNG scrollable datatable** (`p-datatable-scrollable`). Movements load into a single scrollable body (`p-datatable-scrollable-table`); ~40 rows were present for "Último mes". Scrolling the table body reveals more rows (virtual/lazy scroll) rather than discrete pages.

**Primary adapter strategy (direct DOM read — same model as `popular.ts`):** set the date range, then scroll the table body to the bottom and collect `tr.body-responsive` rows until no new rows append (row count stabilizes). This is the hot path — fast, no file handling. The export (§4.7) is a fallback only.

### 4.7 Export Options

| Control | Selector | Formats |
|---------|----------|---------|
| **Descargar movimientos** | `button.p-button-outlined.bhd-btn-default` (split/dropdown) → menu `a.p-menu-item-link` | **PDF**, **EXCEL**, **TXT** |
| Descargar estados de cuenta | `button.bhd-btn-primary` (split/dropdown) | Account statements (PDF) |
| Print | printer icon button | Browser print |

> **Export is a FALLBACK, not the primary path.** RD-Sync reads the rendered table directly (faster, no file handling, no download permission needed) — see §4.8. Export (EXCEL/TXT/PDF) is kept documented for: (a) recovery if the DOM structure changes and scraping breaks, (b) periodic reconciliation/audit against the scraped data, (c) one-time backfill of deep history beyond what the UI lazy-loads comfortably. Selecting a format triggers a **download** (a permission-required action) and PDF/Excel need binary parsing → extra reasons it is not the hot path. Menu items are `a.p-menu-item-link` matched by text (PDF / EXCEL / TXT); the `li.p-menu-item` `ng-tns-c...` class is dynamic — match on link text. NOT exercised during recon.

### 4.8 Transaction Table Selectors

PrimeNG datatable (`table.p-datatable-table.p-datatable-scrollable-table`). Rows: `tr.body-responsive`. Columns (in order):

| # | Column | Format / Example | Notes |
|---|--------|------------------|-------|
| 1 | Fecha | `30/06/2026` (`DD/MM/YYYY`) | Sortable (`↑↓`) |
| 2 | Nº confirmación | `2638027` | Transaction confirmation id |
| 3 | Descripción | `Fondo reservado Visa Db: 20260629` / `TRANSFERENCIA RECIBIDA DE ...` | |
| 4 | Comprobante | `0000000000` | Voucher/receipt number (often zero-filled) |
| 5 | Débitos | `RD$ 679.51` | Empty for credits; `RD$ ` prefix, thousands `,`, 2 decimals |
| 6 | Créditos | `RD$ 1,450.00` | Empty for debits |
| 7 | Balance | `RD$ 7,167.94` | Running balance after the movement |

- Each `<td>` is positional — extract by column index (no per-cell semantic class needed). All columns sortable via the header `↑↓` toggle.
- Debit and credit are **separate columns** (one empty per row) — same pattern as Banreservas.

---

## 5. Session States

| State | Trigger | Observed? | Action |
|-------|---------|-----------|--------|
| Login success | Valid credentials (+ CAPTCHA if shown) | No (needs admin) | Continue to dashboard |
| Invalid credentials | Wrong user/pass | No | Retry; expect error message |
| CAPTCHA shown | Failed login attempt (Personal) | Inferred from DOM | `needs_admin_action` |
| CAPTCHA always present | Any load (Empresarial) | Yes | `needs_admin_action` |
| Security questions (first login per browser) | 2 memorized Q&A — ONLY on first sign-in from a new browser/device | Yes (observed) | `needs_admin_action` ONCE; admin answers + checks "guardar navegador" → never prompted again on that browser |
| Remembered browser | "guardar navegador" was checked on first login | Yes | No Q&A; credentials alone reach dashboard → adapter CDP-attach works cleanly |
| Session expired | Timeout | No | Re-login |
| reCAPTCHA v3 block | Bot behavior score too low | No | `needs_admin_action` |
| Account locked | Excessive failed attempts | No | `needs_admin_action` |
| Maintenance | Planned downtime | No | `needs_admin_action` |

---

## 6. Edge Cases

| Case | Notes |
|------|-------|
| Personal CAPTCHA hidden then shown | Adapter must detect `.field.col-10.mb-2[style*=display:none]` becoming visible |
| Empresarial CAPTCHA always required | Cannot automate; needs admin every session |
| reCAPTCHA v3 scoring | Headless CDP automation may score low → silent block or CAPTCHA challenge |
| Two portals (Personal vs Empresarial) | BankAdapter config must specify which portal to use |
| select2 dropdown (Empresarial) | Must interact with select2 wrapper, not raw `<select>` |
| WebSphere URL contains `!ut/p/z1/...` | Dynamic state token in path — do NOT hardcode; use `ib.bhd.com.do/wps/portal/ibe/login` directly |
| **Security questions = first-login-per-browser gate** | 2 memorized Q&A appear ONLY on the first sign-in from a new browser. Admin answers them and checks **"guardar navegador"** (remember device) → subsequent logins on that browser skip the Q&A entirely. Implication: provision the RD-Sync browser profile ONCE with admin help; thereafter credentials-only login works and the adapter's CDP-attach model runs unattended. Never automate the Q&A (lockout risk) |
| Movements panel is inline on product-detail | "Ver estados y movimientos" expands the table on `#/bhd/product-detail`; it is NOT a separate route |
| PrimeNG dynamic classes `ng-tns-c…-NN` | These scope ids change between builds/components — NEVER match on them; use `placeholder`, role, stable `bhd-*`/`p-*` classes, or column index |
| Multiple accounts | Observed: 2 accounts (Ahorro Personal, Supercuenta Nómina) + Tarjetas + Centro Financiero sections. Switch via `div.p-select-dropdown` on product-detail or revisit cards |
| DOP vs USD accounts | Only DOP (`RD$`) observed; amounts carry `RD$ ` prefix. USD format `TBD` |
| Zero-movement period | `TBD` — not observed |

---

## 7. Security Constraints

- [x] No credentials in this file
- [x] No session cookies documented
- [x] No tokens or auth headers
- [x] No bypass of CAPTCHA / reCAPTCHA / LexisNexis
- [x] Post-login steps marked `[needs_admin_action]`
- [x] Read-only navigation only

---

## 8. Selector Stability Assessment

| Selector | Portal | Stability | Reason |
|----------|--------|-----------|--------|
| `input#userName` | Personal | **Stable** | Explicit `id` + `name` attribute |
| `input#password` | Personal | **Stable** | Explicit `id` + `name` attribute |
| `input[name=captcha]` | Personal | **Stable** | `name` + `formcontrolname` |
| `button[type=submit].bhd-btn-primary` | Personal | Stable | Class likely intentional branding |
| `input[name=User]` | Empresarial | **Stable** | Legacy WebSphere — names rarely change |
| `input[name=Password]` | Empresarial | **Stable** | Same |
| `input[name=Captcha]` | Empresarial | **Stable** | Same |
| `li.captchaBlock > p` (bg-image) | Empresarial | Fragile | CSS background approach may change |
| WebSphere `!ut/p/z1/...` path | Empresarial | **Fragile** | Dynamic state token; use `/ibe/login` base only |
| Angular route `#/login` / `#/bhd/dashboard` / `#/bhd/product-detail` | Personal | Stable | Angular router paths |
| `button.bhd-btn-primary` ("Ver estados y movimientos") | Personal | Stable | `bhd-*` branded class |
| `table.p-datatable-table` / `tr.body-responsive` | Personal | **Stable** | PrimeNG datatable + custom row class; extract `<td>` by index |
| `input.p-datepicker-input[placeholder="Fecha inicio"/"Fecha final"]` | Personal | **Stable** | Match on `placeholder`, NOT the `ng-tns-c…` fragment |
| `div.p-select-dropdown` (period + product selector) | Personal | Stable | PrimeNG select; read label / open for options |
| `a.p-menu-item-link` (export PDF/EXCEL/TXT) | Personal | Stable (by text) | `li.p-menu-item` `ng-tns-c…` is dynamic — match link text |
| `ng-tns-c…-NN` class fragments | Personal | **Fragile** | Angular-generated scope ids; never select on these |

---

## 9. Proposed Scraper Profile (draft)

```typescript
// Personal portal — fill remaining fields after post-login recon
export const bhdPersonalScraperProfile = {
  bankId: "bhd",
  portalVariant: "personal",
  loginUrl: "https://ibp.bhd.com.do/#/login",
  accountFingerprint: "bhd-XXXXXXXXXX", // per-account, assigned at onboarding
  // Login gated by security questions → admin completes login; adapter attaches
  // to the already-authenticated session (CDP-attach model). Do NOT automate the Q&A.
  // Security Q&A appears ONLY on first login per browser. Admin answers once and
  // checks "guardar navegador" → all later logins skip it. Provision the browser
  // profile once with admin help, then credentials-only login runs unattended.
  loginStrategy: "admin-assisted-first-login+remember-browser+cdp-attach",
  routes: {
    dashboard:     "#/bhd/dashboard",
    productDetail: "#/bhd/product-detail",
  },
  selectors: {
    // --- Login (admin-assisted) ---
    usernameInput: "input#userName",
    passwordInput: "input#password",
    captchaInput:  "input[name='captcha']",
    captchaArea:   "div.field.col-10.mb-2",  // hidden until triggered
    captchaCanvas: ".bhd-captcha canvas",
    submitButton:  "button[type='submit'].bhd-btn-primary",

    // --- Navigation ---
    accountCard:   "div.p-select-dropdown", // product selector on product-detail
    viewMovementsButton: "button.bhd-btn-primary", // "Ver estados y movimientos"

    // --- Filters ---
    typeTabTodos:    "button.bhd-btn-tab-select",
    periodDropdown:  "div.p-select-dropdown",      // Último mes / 2-3 últimos meses / Rango de fecha
    fromDateInput:   "input.p-datepicker-input[placeholder='Fecha inicio']", // typed DD/MM/YYYY
    toDateInput:     "input.p-datepicker-input[placeholder='Fecha final']",
    searchInput:     "input[placeholder='Buscar']",

    // --- Transaction table (PrimeNG datatable; extract <td> by column index) ---
    transactionTable: "table.p-datatable-table",
    transactionRow:   "tr.body-responsive",
    // columns: 0=Fecha 1=Nº confirmación 2=Descripción 3=Comprobante 4=Débitos 5=Créditos 6=Balance

    // --- Export (FALLBACK only — primary path is direct table read above) ---
    exportMovementsButton: "button.p-button-outlined.bhd-btn-default", // "Descargar movimientos"
    exportFormatItem:      "a.p-menu-item-link", // match text: PDF / EXCEL / TXT
  },
  formats: {
    date: "DD/MM/YYYY",
    amount: "RD$ 1,234.56", // RD$ prefix, thousands ',', 2 decimals; debit & credit in separate columns
  },
} as const;

// Empresarial portal — always-captcha; needs_admin_action
export const bhdEmpresarialScraperProfile = {
  bankId: "bhd",
  portalVariant: "empresarial",
  loginUrl: "https://ib.bhd.com.do/wps/portal/ibe/login",
  accountFingerprint: "bhd-emp-XXXXXXXXXX",
  selectors: {
    documentTypeRadioCedula:   "input[name='documentType'].idNumber",
    documentTypeRadioPasaporte: "input[name='documentType'].passportNumber",
    usernameInput: "input[name='User']",
    passwordInput: "input[name='Password']",
    captchaInput:  "input[name='Captcha']",
    captchaImageEl: "li.captchaBlock > p",   // bg-image contains base64 JPEG
    captchaRefresh: "a[href='javascript:;']", // "Refrescar imagen"
    submitButton:  "input[type='submit'].submit",
    // post-login — TBD
  },
} as const;
```

---

## 10. Open Questions / Blockers

**Resolved this session (Personal):**
- [x] ~~Post-login navigation~~ — dashboard → account card → product-detail → "Ver estados y movimientos" (§4.3)
- [x] ~~Transaction table selectors~~ — PrimeNG `p-datatable`, positional `<td>` columns (§4.8)
- [x] ~~Date filter~~ — preset dropdown + typed `Rango de fecha` PrimeNG datepickers (§4.5)
- [x] ~~Export~~ — Descargar movimientos: PDF / EXCEL / TXT (§4.7)
- [x] ~~Auth factors~~ — CONFIRMED: security questions appear post-credentials; wrong answer risks lockout → `needs_admin_action` (admin completes login; adapter uses CDP-attach)

**Still open:**
- [ ] Which portal does the target BHD account use — Personal or Empresarial? (Personal now fully mapped)
- [ ] **Empresarial post-login** — NOT mappable for now: no BHD business account available to the team (confirmed 2026-06-29). Also gated by always-visible CAPTCHA. Revisit only if a business account is provisioned
- [ ] Does reCAPTCHA v3 block CDP/Playwright automation even on first load?
- [ ] Empresarial: can the CAPTCHA image be read from the DOM as base64 + decoded, or does it require human visual reading?
- [ ] Personal CAPTCHA: confirmed trigger condition (failed login vs after N seconds)?
- [ ] Security questions: exact selector/DOM of the Q&A screen (not captured — admin had already passed it before observation)
- [ ] Pagination: confirm whether the datatable lazy-loads ALL movements on scroll, or caps at a limit (export is the safer extraction path either way)
- [ ] USD-account amount format (only DOP observed)
