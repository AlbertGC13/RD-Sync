# Bank Session Runbook — Via B (Popular Portal)

## How the session works

RD-Sync attaches to a human-opened Brave browser via Chrome DevTools Protocol (CDP). There are no stored credentials and no session secrets — the session lives entirely in the running browser. The admin logs in manually (including MFA) once, and the browser keeps the session alive through cookies.

The bank portal (Banco Popular) expires sessions after a short inactivity window. RD-Sync cannot refresh the session automatically. When the session expires, the admin must log in again.

## Launching the dedicated browser

Use the provided PowerShell script to open Brave with an isolated profile reserved for the bank session:

```powershell
.\scripts\launch-bank-browser.ps1
```

The script:
- Creates a persistent profile at `%LOCALAPPDATA%\rd-sync\bank-browser`
- Opens Brave on CDP port 9222
- Detects Brave at the two standard install paths and exits with a clear error if absent

**Important:** Never browse personal sites in this profile. Keep it bank-only so the session cookies are not invalidated by other activity.

## Logging in

1. Run the launch script above.
2. In the Brave window that opens, navigate to the bank portal and log in with your credentials and MFA code.
3. Leave the browser open. RD-Sync will attach to it automatically on the next scheduled or manual scrape.

Because the profile is persistent, cookies survive browser restarts. After the initial login you should only need to re-authenticate when the bank expires the session.

## What the session monitor does

When `RD_SYNC_SESSION_MONITOR=enabled`, RD-Sync polls the bank portal dashboard at the configured interval (default every 5 minutes). It detects three states:

| Status | Meaning |
|--------|---------|
| `active` | Session is live and the dashboard loaded correctly |
| `expired` | The portal redirected away from the dashboard, or the dashboard did not render |
| `browser_unavailable` | CDP could not attach (Brave is not running or the port is wrong) |

Alerts are sent only on **transitions**:
- `active → expired` → attention required email
- `active → browser_unavailable` → attention required email
- `expired → active` → recovery email
- `browser_unavailable → active` → recovery email
- Repeated bad states → silent (no inbox spam)

## What the alert emails mean

**Subject: RD-Sync: bank session attention required**
The bank session has expired or the browser is unavailable. Log in again using the steps above.

**Subject: RD-Sync: bank session restored**
The session is active again. No action needed.

## Checking session status manually

```
GET /api/bank-sessions/status
```

Requires an admin principal (trusted headers `x-rd-sync-user-id` and `x-rd-sync-role: admin`, or `?previewRole=admin` in dev mode).

Response shape:

```json
{
  "session": {
    "status": "active",
    "checkedAt": "2026-06-12T10:00:00.000Z",
    "safeSummary": "Bank session is active"
  },
  "monitor": {
    "enabled": true,
    "lastResult": { ... }
  }
}
```

`session` reflects a **live check** performed at request time.
`monitor.lastResult` reflects the most recent background check (null if the monitor has not run yet).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RD_SYNC_SCRAPER` | — | Set to `popular-cdp` to enable the CDP-backed scraper and session checker |
| `RD_SYNC_CDP_URL` | `http://localhost:9222` | CDP endpoint for the running Brave session |
| `RD_SYNC_SESSION_MONITOR` | — | Set to `enabled` to start the background session monitor |
| `RD_SYNC_SESSION_CHECK_INTERVAL_MS` | `300000` (5 min) | Poll interval in milliseconds; minimum 60000 (1 min) |
| `RD_SYNC_ALERT_SMTP_URL` | — | SMTP URL for alert emails; falls back to console.warn if absent |
| `RD_SYNC_ADMIN_EMAIL` | — | Recipient address for alert emails |

## Dev-mode caveats

- **Restart the dev server after changing scraper code.** Next.js hot-reload does not re-execute module-level wiring code (`consumer-defaults.ts`, `bank-sessions/defaults.ts`). Env vars are read at import time.
- **Admin RSC pages and API routes maintain separate in-memory state.** The `defaultAuditSink` (InMemoryAuditSink) is shared within a single process, but RSC rendering and API route execution may run in different Node.js worker threads under Next.js dev mode. Audit events emitted by the session monitor may not appear in the RSC-rendered admin pages until Prisma persistence lands.
- **Dev preview principal** (`?previewRole=admin`) is active only when `NODE_ENV !== production` and `RD_SYNC_DEV_PREVIEW=enabled`. It is disabled in production unconditionally.
