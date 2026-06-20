# RD-Sync — UX Audit (2026-06-20)

Method: four parallel read-only reviewers (employee/login, admin scrape-runs,
admin connections/audit, cross-cutting/design-system) produced ~55 findings,
deduplicated and grouped into themes below. Nothing was changed — this is the
map for choosing what to build in the UI/UX phase.

App context: private read-only bank-transaction dashboard, Banco Popular (DR),
Spanish-speaking staff, admin vs employee roles, data-minimization, local-first.

## Themes ranked (by impact × reach)

| # | Theme | Impact | Effort | Findings |
|---|-------|--------|--------|----------|
| T1 | Spanish localization (UI is all English) | High | M–L | app-wide |
| T2 | Scrape-run feedback & trigger | High | M | 6 |
| T3 | Misleading dead stubs & dev text leaking to UI | High | S–M | 6 |
| T4 | Security/leak surfaces (preview backdoor, public nav) | High | S | 3 |
| T5 | Missing loading/error states | High | S–M | 4 |
| T6 | Navigation (active state, 403 escape, login chrome, mobile) | High | M | 5 |
| T7 | Accessibility sweep | Medium | M | 9 |
| T8 | Content clarity (raw enums/UUIDs/JSON, jargon, dup labels) | Medium | S–M | 8 |

---

## T1 — Spanish localization (HIGH, app-wide; all 4 reviewers flagged it)
The entire UI is in English while users are Spanish-speaking Dominican bank
staff. Also `html lang="en"` and dates hardcoded to `en-US` + UTC instead of
`es-DO` + `America/Santo_Domingo` (AST, UTC-4) — operators must mentally subtract
4 hours, an operational-error risk.
- `src/app/layout.tsx:30` `lang="en"`; nav labels, login, headers, empty/error
  states, table headers, button text — all English.
- Dates: `transaction-row.tsx` (`en-US`), `admin/scrape-runs/page.tsx:405-422`
  (`en-US`), `admin/audit/page.tsx:141` (ISO UTC raw).
- Fix: `lang="es"`, translate all user-facing strings to neutral professional
  Spanish, switch Intl locale to `es-DO` + timezone `America/Santo_Domingo` with
  a visible offset. Consider a strings constants file (single target language).

## T2 — Scrape-run feedback & trigger (HIGH; the user hit all of these live)
- No primary "Scrape today" button — only a per-card **"Retry run"** (mislabeled:
  it starts a NEW run, not a retry). On empty history there's no trigger at all.
  `admin/scrape-runs/page.tsx:86-98,198-206`, `run-action-affordances.tsx:55-61`.
- After triggering, the toast only says "queued, refresh to see history" — no
  outcome. A **succeeded run with 0 transactions looks identical to "nothing
  happened"** → infinite-retry confusion. `run-action-affordances.tsx:33-46`,
  `page.tsx:302-313`.
- No page auto-refresh / `router.refresh()` after triggering. No `running`→
  terminal visibility.
- Fix: primary "Ejecutar ahora" button in the PageHeader (works with empty
  history); after trigger, poll the run by id and show a clear outcome
  (0 hoy / importadas N / sesión no disponible / falló); `router.refresh()` +
  light auto-refresh while a run is queued/running; a "Sin transacciones nuevas"
  note when succeeded-with-0.

## T3 — Misleading dead stubs & developer text in production UI (HIGH)
- `bank-connections/[id]/session/page.tsx:78-85` renders developer/roadmap prose
  to end users: *"Session renewal is intentionally a shell in this PR. The next
  slice will wire the controlled browser flow."* Must never ship to users.
- "Disable connection" / "Renew session" are dead `notImplemented` stubs shown as
  the only resolution path (`run-action-affordances.tsx:63-77`,
  `bank-connections/page.tsx:93-95`). "Renew session" also misrepresents what the
  app can do (under Via B a human must re-login in the browser).
- "New connection" page is non-functional — hardcodes the one existing
  connection, no inputs, no submit (`bank-connections/new/page.tsx`).
- Connection status is a hardcoded constant always showing "needs_admin_action"
  (`bank-connections/page.tsx:21-29`).
- Fix: hide/relabel stubs honestly ("Próximamente"); replace dev prose with
  operator guidance ("Abrí el navegador del banco y volvé a iniciar sesión");
  either build or disable the new-connection affordance; wire real session
  status or mark the card "demo data".

## T4 — Security / leak surfaces (HIGH, cheap)
- `src/app/page.tsx:41` hardcodes a link to `/admin/scrape-runs?previewRole=admin`
  — a dev preview backdoor rendered unconditionally on the public home page.
- Root `/` and the home flow cards expose internal navigation to unauthenticated
  visitors (`page.tsx:28-44`).
- Login page renders inside the global layout with the full nav of links the user
  can't use yet (`layout.tsx:28-98` wraps `login/page.tsx`).
- Fix: remove the `previewRole` link (or gate on non-prod); redirect `/` by auth
  state; move `/login` into a `(public)` route group with a minimal nav-less layout.

## T5 — Missing loading/error states (HIGH/MED, robustness)
- No `loading.tsx`/`error.tsx` boundaries; a slow fetch hangs blank, a failed
  fetch shows a raw Next crash. The `Skeleton` and `ErrorState` components exist
  but are never used. (`(private)/transactions/page.tsx`, app-wide.)
- Fix: add `loading.tsx` (skeleton rows) + `error.tsx` (ErrorState + retry) for
  transactions, scrape-runs, audit.

## T6 — Navigation (HIGH)
- No active-state indicator in the nav — can't tell which section you're in
  (`layout.tsx:62-70`, no `usePathname`/`aria-current`).
- 403 screens (admin layout, audit) strand users with no link back
  (`admin/layout.tsx:25-36`).
- Mobile: nav labels hidden below `sm`, icons unlabelled, no `aria-label`
  (`layout.tsx:68`).
- Fix: active nav state + `aria-current`; a "Volver a transacciones" link on 403;
  `aria-label` on icon links + a mobile drawer (the Drawer component exists).

## T7 — Accessibility sweep (MEDIUM)
- Audit table `<th>` missing `scope="col"` + no `<caption>`/aria name
  (`audit/page.tsx:118-126`).
- `title`-attribute tooltips (audit metadata) are inaccessible on touch/keyboard
  — use the Tooltip component (`audit/page.tsx:164-169`).
- `Skeleton` uses `animate-pulse` with no `motion-safe:` guard.
- Filter chips lack `aria-label="Remove filter: …"`; pagination links lack
  `aria-label` + `aria-live` for page changes.
- Login: both inputs share one `aria-describedby` to the error (announced twice).

## T8 — Content clarity (MEDIUM)
- Raw internal values surfaced to users: enum `needs_admin_action` shown verbatim
  (`session/page.tsx:52`), actor **UUIDs** with no name (`audit/page.tsx:143`),
  raw JSON metadata truncated at 120 chars (`audit/page.tsx:130-134`).
- Jargon: "movements", "Account fingerprint" / placeholder "acct-main".
- `transaction-row.tsx:89-91` duplicates the review-state label (badge + plain
  span). Amount filter has no format/semantics hint.
- Filter chips remove local state but don't re-navigate → list stays stale until
  "Apply" (`filter-bar.tsx:78-93`).

---

## Recommended order of attack (proposed slices)

1. **Slice A — Scrape-runs operational UX (T2 + T3 + the dismiss/acknowledge
   backend).** Highest day-to-day friction, already felt live. Includes the
   primary scrape button, run-outcome feedback, acknowledge/dismiss, and hiding
   the misleading stubs/dev-text. Medium effort.
2. **Slice B — Security/leak + nav + states (T4 + T5 + T6).** Cheap, high-value
   correctness/robustness/navigation polish; removes the preview backdoor, adds
   loading/error boundaries, fixes navigation and the login chrome.
3. **Slice C — Spanish localization (T1).** App-wide sweep; best done once the
   screens settle so strings aren't translated twice. Set `lang="es"`, `es-DO`
   dates/timezone, translate all copy.
4. **Slice D — Accessibility + content clarity (T7 + T8).** Quality pass:
   a11y fixes + replacing raw enums/UUIDs/JSON with human-readable content.

Each slice is a focused PR with TDD + adversarial review, following the existing
design system in `src/components/ui`.
