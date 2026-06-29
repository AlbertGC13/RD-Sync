# BHD León — Portal Reconnaissance

**Status:** complete (pre-login only)
**Recon date:** 2026-06-29
**Recon branch:** feature/multi-bank-auto-login-pr5-bank-mapping
**Security level:** public + pre-login observations; post-login requires admin session

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

## 4. Post-Login Navigation

> **`[needs_admin_action]`** — All sections below require a live authenticated session.

### 4.1 Landing Page
- TBD — admin session required.

### 4.2 Account / Product List
- TBD

### 4.3 Path to Transactions
- TBD

### 4.4 Date Filter Selectors
- TBD

### 4.5 Pagination
- TBD

### 4.6 Export Options
- TBD

### 4.7 Transaction Table Selectors
- TBD

---

## 5. Session States

| State | Trigger | Observed? | Action |
|-------|---------|-----------|--------|
| Login success | Valid credentials (+ CAPTCHA if shown) | No (needs admin) | Continue to dashboard |
| Invalid credentials | Wrong user/pass | No | Retry; expect error message |
| CAPTCHA shown | Failed login attempt (Personal) | Inferred from DOM | `needs_admin_action` |
| CAPTCHA always present | Any load (Empresarial) | Yes | `needs_admin_action` |
| MFA / device challenge | Unknown — not observed | No | `needs_admin_action` |
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
| Multiple accounts | TBD |
| DOP vs USD accounts | TBD |
| Zero-movement period | TBD |

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
| Angular route `#/login` | Personal | Stable | Angular router path |

---

## 9. Proposed Scraper Profile (draft)

```typescript
// Personal portal — fill remaining fields after post-login recon
export const bhdPersonalScraperProfile = {
  bankId: "bhd",
  portalVariant: "personal",
  loginUrl: "https://ibp.bhd.com.do/#/login",
  accountFingerprint: "bhd-XXXXXXXXXX", // fill after admin session
  selectors: {
    usernameInput: "input#userName",
    passwordInput: "input#password",
    captchaInput:  "input[name='captcha']",
    captchaArea:   "div.field.col-10.mb-2",  // hidden until triggered
    captchaCanvas: ".bhd-captcha canvas",
    submitButton:  "button[type='submit'].bhd-btn-primary",
    // post-login — TBD
    accountList:   "TBD",
    transactionTable: "TBD",
    fromDateInput: "TBD",
    toDateInput:   "TBD",
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

- [ ] Which portal does the target BHD account use — Personal or Empresarial?
- [ ] Post-login: account list, transaction navigation, date filter, pagination, export — all need admin session `[needs_admin_action]`
- [ ] Does reCAPTCHA v3 block CDP/Playwright automation even on first load?
- [ ] Empresarial: can the CAPTCHA image be read from the DOM as base64 + decoded, or does it require human visual reading?
- [ ] Personal CAPTCHA: confirmed trigger condition (failed login vs after N seconds)?
- [ ] Are there other authentication factors (OTP, device token) that appear post-username?
