# Proposal: Transaction Dashboard MVP

## Intent

Build RD-Sync as a private, read-only bank transaction dashboard so designated employees can verify customer payments without accessing bank portals or calling the owner/admin.

## Scope

### In Scope
- Dashboard for recent bank transactions with filters by bank, account, date, amount, currency, reference, concept, and originator when available.
- Controlled scraping worker for one initial bank, with admin-only MFA handling and no employee bank access.
- Transaction storage, idempotency, audit logging, operational alerts, and future ERP extension fields.

### Out of Scope
- ERP integration, invoice reconciliation, automatic payment matching, transfers, payments, beneficiary management, and employee access to bank portals.

## Capabilities

### New Capabilities
- `bank-transaction-ingestion`: Scrape, normalize, deduplicate, and persist recent bank transactions.
- `transaction-dashboard`: Display recent transactions and filters for authorized employees.
- `access-control-audit`: Enforce roles, data minimization, MFA boundaries, and audit events.
- `operations-monitoring`: Surface scraper health, failures, and UI-change alerts.

### Modified Capabilities
- None.

## Approach

Use a modular monolith plus worker: dashboard/API and Playwright scraper run as separate processes over shared PostgreSQL. Keep scraper credentials/session state isolated from employees. Store only normalized transaction data for dashboard reads. Prepare ERP extension fields without implementing ERP behavior.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `openspec/changes/build-transaction-dashboard-mvp/` | New | SDD artifacts for the MVP. |
| Future `src/app` | New | Dashboard and internal API. |
| Future `src/worker` | New | Scraping, normalization, retry, and alert jobs. |
| Future `database` | New | Transactions, users, roles, scrape runs, audit events. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Bank UI changes break scraping | High | Adapter tests, selector config, screenshots redacted, failure alerts. |
| Credential/session exposure | Med | Secrets manager, encryption, TTL, admin-only MFA, read-only bank user. |
| Employees see excess data | Med | RBAC, field-level minimization, no balances/screenshots by default. |
| Scraping compliance risk | Med | Private use, low frequency, authorized account, no money movement. |

## Rollback Plan

Disable scraper jobs, revoke stored sessions/secrets, keep dashboard read-only, and remove any newly ingested transactions by scrape run if needed.

## Dependencies

- Confirm first target bank and available read-only user permissions.
- Select stack before implementation.
- Create test runner before enabling Strict TDD.

## Success Criteria

- [ ] Employees can filter recent transactions without bank access.
- [ ] Scraper inserts no duplicate transactions.
- [ ] MFA and bank session handling remain admin-only.
- [ ] Audit trail records scraping and dashboard access.
