# Banreservas — Portal Reconnaissance

**Status:** complete (pre-login only)
**Recon date:** 2026-06-29
**Recon branch:** feature/multi-bank-auto-login-pr5-bank-mapping
**Security level:** public + pre-login observations; post-login requires admin session

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

### 1.2 Personas vs Empresas distinction

The "Cambiar a TuBanco Empresas" toggle button stays on the SAME URL (`#/administrationGeneral/login`) and changes only the right-panel marketing image. The login form is IDENTICAL for both. Account type is determined server-side by the username/RNC format entered, not by a separate portal or form.

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

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `DO_BR_ICB7_AZ_PROD.WebServer.Api/api/Authentication/GetAuthenticationConfigurationItems` | GET | Fetches login form config (captcha requirements, feature flags, etc.) |

**API base:** `https://tubanco.banreservas.com/DO_BR_ICB7_AZ_PROD.WebServer.Api/api/`

This is the Banreservas internal REST API. Additional endpoints will be discoverable after admin session via network tab observation.

---

## 3. Post-Login Navigation

> **`[needs_admin_action]`** — All sections below require a live authenticated session.

### 3.1 Landing Page
- TBD — admin session required.

### 3.2 Account / Product List
- TBD

### 3.3 Path to Transactions
- TBD

### 3.4 Date Filter Selectors
- TBD

### 3.5 Pagination
- TBD

### 3.6 Export Options
- TBD

### 3.7 Transaction Table Selectors
- TBD

---

## 4. Session States

| State | Trigger | Observed? | Action |
|-------|---------|-----------|--------|
| Login success | Valid credentials | No (needs admin) | Continue to dashboard |
| Invalid credentials | Wrong user/pass | No | Retry; observe error message selector |
| OneSpan challenge | High risk score from fingerprinting | No | `needs_admin_action` |
| MFA / OTP | Device/session token | No | `needs_admin_action` |
| Session expired | Timeout | No | Re-login |
| Account locked | Excessive failed attempts | No | `needs_admin_action` |
| Maintenance | Planned downtime | No | `needs_admin_action` |
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
| Personas vs Empresas same form | No selector change needed between account types; username determines type server-side |
| RNC (Registro Nacional del Contribuyente) vs cédula format | Username format likely determines if Personas or Empresas account; confirm with admin |
| Multiple accounts (same customer) | TBD |
| DOP vs USD accounts | TBD |
| Zero-movement period | TBD |

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

---

## 8. Proposed Scraper Profile (draft)

```typescript
// Fill remaining selectors after post-login admin session
export const banreservasScraperProfile = {
  bankId: "banreservas",
  loginUrl: "https://tubanco.banreservas.com/TuBancoBanreservas/#/administrationGeneral/login",
  accountFingerprint: "banreservas-XXXXXXXXXX", // fill after admin session
  defaultSearchMode: "current-day",
  selectors: {
    usernameInput: "input[formControlName='username']#step01",
    passwordInput: "input[formControlName='password']#step02",
    submitLink:    "a.ipswich-main-buttons-link.default.big",
    submitInactiveClass: "inactive", // wait for this to disappear before clicking
    // post-login — TBD
    accountList:      "TBD",
    transactionTable: "TBD",
    fromDateInput:    "TBD",
    toDateInput:      "TBD",
    searchButton:     "TBD",
  },
  inputStrategy: "angular-events", // must fire input+blur events, not just set .value
} as const;
```

---

## 9. Open Questions / Blockers

- [ ] Post-login: account list, transaction navigation, date filter, pagination, export — all need admin session `[needs_admin_action]`
- [ ] Does OneSpan LWSA score CDP-attached real Chrome as a bot, or does it pass?
- [ ] What is the exact API endpoint for fetching transaction history?
- [ ] Username format difference between Personas (cédula) and Empresas (RNC)?
- [ ] Does Banreservas have a separate Empresas portal at a different URL, or is the unified portal confirmed for both?
- [ ] Any OTP or second-factor challenge post-login?
- [ ] What Angular event sequence does the "Ingresar" link listen to — `click`, `mousedown`, or custom Angular event?
