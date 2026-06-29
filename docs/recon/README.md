# Bank Portal Reconnaissance

This directory contains read-only mapping artifacts for bank portals targeted by RD-Sync adapters.

## Purpose

Each `.md` file maps a bank's online banking portal: login flow, post-login navigation, transaction selectors, edge cases, and security constraints. These artifacts feed the adapter design phase (PR5B+) and replace guesswork with evidence.

## Ground Rules

- **No real credentials.** URLs, selectors, form field names only.
- **No screenshots with passwords, account numbers, or balances.**
- **No bypass** of MFA, CAPTCHA, Imperva, or any challenge. Document as `needs_admin_action`.
- **Read-only observation.** No clicks that submit forms, transfer money, or change settings.
- **Admin intervention required** for any authenticated session step.

## Files

| File | Bank | Status |
|------|------|--------|
| [bhd.md](./bhd.md) | BHD León | complete (pre-login); post-login needs admin session |
| [banreservas.md](./banreservas.md) | Banreservas | complete (pre-login); post-login needs admin session |

## Mapping Checklist (per bank)

- [ ] Initial URL and redirect chain
- [ ] Login page field inventory
- [ ] Login step sequence
- [ ] Post-login landing page selectors
- [ ] Account/product list selectors
- [ ] Transaction/movement navigation path
- [ ] Date filter selectors
- [ ] Pagination mechanism
- [ ] Export mechanism (CSV/PDF/Excel/HTML-only)
- [ ] Session states (success, error, MFA, expired, maintenance, locked)
- [ ] Edge cases documented
- [ ] Security constraints confirmed
