# Bank Session Runbook — Via B (Popular Portal)

## How the session works

RD-Sync attaches to a human-opened Brave browser via Chrome DevTools Protocol (CDP). There are no stored credentials and no session secrets — the session lives entirely in the running browser. The admin logs in manually (including MFA) once, and the browser keeps the session alive through cookies.

The bank portal (Banco Popular) expires sessions after a short inactivity window. RD-Sync cannot refresh the session automatically. When the session expires, the admin must log in again.

## Launching the dedicated browser

### Windows (local development)

Use the provided PowerShell script to open Brave with an isolated profile reserved for the bank session:

```powershell
.\scripts\launch-bank-browser.ps1
```

The script:
- Creates a persistent profile at `%LOCALAPPDATA%\rd-sync\bank-browser`
- Opens Brave on CDP port 9222
- Detects Brave at the two standard install paths and exits with a clear error if absent

### Linux server (production)

Use the provided Bash script to open Brave/Chromium with an isolated profile:

```bash
./scripts/launch-bank-browser.sh
```

The script:
- Detects the first available browser binary in this order: `brave-browser`, `brave`, `chromium-browser`, `chromium`, `google-chrome` (override with `RD_SYNC_BANK_BROWSER_BIN`)
- Creates a persistent profile at `~/.local/share/rd-sync/bank-browser` (override with `RD_SYNC_BANK_BROWSER_PROFILE_DIR`)
- Binds CDP to **127.0.0.1 only** on port 9222 (override with `RD_SYNC_BANK_BROWSER_DEBUG_PORT`) — never exposes CDP to the network
- Opens the bank portal at `https://ib.bpd.com.do` (override with `RD_SYNC_BANK_BROWSER_START_URL`)
- If CDP is already alive on the port, prints a message and exits without relaunching
- Writes browser logs to `~/.local/share/rd-sync/bank-browser/browser.log` (override with `RD_SYNC_BANK_BROWSER_LOG_FILE`)

**Importante:** No navegue sitios personales en este perfil. Manténgalo exclusivo para el banco para que las cookies de sesión no se invaliden.

#### Auto-lanzamiento desde el worker (opcional)

Cuando se configuran estas variables de entorno, el worker puede iniciar el navegador del banco automáticamente antes de conectarse por CDP:

| Variable | Descripción |
|----------|-------------|
| `RD_SYNC_BANK_BROWSER_AUTO_LAUNCH` | `enabled` para activar el auto-lanzamiento |
| `RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND` | Comando confiable de servidor que inicia el navegador (p. ej. `./scripts/launch-bank-browser.sh`) |
| `RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS` | Tiempo máximo de espera tras lanzar (por defecto 30000) |
| `RD_SYNC_BANK_BROWSER_POLL_INTERVAL_MS` | Intervalo de sondeo de CDP (por defecto 500) |

**Seguridad:** `RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND` es configuración de servidor gestionada por el operador. Nunca se debe establecer desde entrada no confiable ni desde la interfaz de usuario. El resumen de error que ve el empleado nunca incluye la ruta del comando ni su salida — esos detalles quedan solo en logs del servidor.

El verificador de estado de sesión (`/api/bank-sessions/status`) **no** lanza el navegador. Solo reporta el estado actual. Si el navegador está caído, reporta `browser_unavailable` para que el administrador lo inicie.

**Important:** Never browse personal sites in this profile. Keep it bank-only so the session cookies are not invalidated by other activity.

#### Rollback — deshabilitar el auto-lanzamiento y limpiar huérfanos

Si el auto-lanzamiento causa problemas (procesos duplicados, navegador en mal estado, perfil corrupto), siga estos pasos en orden:

1. **Deshabilite el auto-lanzamiento** eliminando o comentando `RD_SYNC_BANK_BROWSER_AUTO_LAUNCH` (o poniéndolo en cualquier valor distinto de `enabled`) en la configuración del servidor. El worker volverá a conectar directamente a CDP sin lanzar nada.
2. **Reinicie el worker** para que relea la configuración:
   ```bash
   kill -SIGTERM <worker-pid>
   RD_SYNC_REDIS_URL=redis://localhost:6379 pnpm worker
   ```
3. **Termine cualquier navegador huérfano** lanzado por el perfil o el puerto CDP:
   ```bash
   # Por puerto CDP (más seguro — apunta solo al navegador de debug):
   pkill -f "remote-debugging-port=9222"

   # O por directorio de perfil (si el puerto por defecto cambió):
   pkill -f "user-data-dir=$HOME/.local/share/rd-sync/bank-browser"
   ```
   Verifique que no queden procesos: `pgrep -af "remote-debugging-port"`.
4. **Verifique el estado** antes de reanudar:
   ```bash
   curl -fsS http://127.0.0.1:9222/json/version >/dev/null && echo "CDP activo" || echo "CDP caído"
   ```
   Y consulte `GET /api/bank-sessions/status` (requiere principal admin). Debe reportar `active` tras un relanzamiento manual limpio, o `browser_unavailable` si decide dejarlo caído hasta que un admin inicie sesión de nuevo.
5. **Relance manualmente** solo cuando esté listo: `./scripts/launch-bank-browser.sh` y complete el login/MFA.

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
| `RD_SYNC_CDP_URL` | `http://127.0.0.1:9222` | CDP endpoint for the running Brave session (bind to 127.0.0.1 only) |
| `RD_SYNC_SESSION_MONITOR` | — | Set to `enabled` to start the background session monitor |
| `RD_SYNC_SESSION_CHECK_INTERVAL_MS` | `300000` (5 min) | Poll interval in milliseconds; minimum 60000 (1 min) |
| `RD_SYNC_ALERT_SMTP_URL` | — | SMTP URL for alert emails; falls back to console.warn if absent |
| `RD_SYNC_ADMIN_EMAIL` | — | Recipient address for alert emails |
| `RD_SYNC_BANK_BROWSER_AUTO_LAUNCH` | — | Set to `enabled` to let the worker start the bank browser before connecting |
| `RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND` | — | Trusted local command that starts the bank browser (server config only) |
| `RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS` | `30000` | Max wait for CDP after launching the browser |
| `RD_SYNC_BANK_BROWSER_POLL_INTERVAL_MS` | `500` | Poll interval while waiting for CDP |
| `RD_SYNC_BANK_BROWSER_PROFILE_DIR` | `~/.local/share/rd-sync/bank-browser` | Persistent browser profile dir (used by the launch script) |
| `RD_SYNC_BANK_BROWSER_DEBUG_PORT` | `9222` | CDP debug port (used by the launch script) |

## Security warnings

- **CDP bound to 127.0.0.1 only.** El script de lanzamiento siempre usa `--remote-debugging-address=127.0.0.1`. Nunca exponga CDP a Internet o a la red local — cualquiera con acceso al endpoint CDP podría controlar la sesión bancaria autenticada.
- **No automated credential entry.** RD-Sync no introduce credenciales ni completa MFA. El administrador inicia sesión manualmente en el navegador del servidor.
- **No Imperva/anti-bot bypass.** RD-Sync no evade las defensas anti-bot del banco. El scraper es de solo lectura: navega y extrae transacciones sobre una sesión abierta por un humano.
- **Launch command is trusted server config.** `RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND` solo se establece en la configuración del servidor gestionada por el operador. Nunca desde entrada de usuario ni desde la interfaz de empleado.

## Dev-mode caveats

- **Restart the dev server after changing scraper code.** Next.js hot-reload does not re-execute module-level wiring code (`consumer-defaults.ts`, `bank-sessions/defaults.ts`). Env vars are read at import time.
- **Admin RSC pages and API routes maintain separate in-memory state.** The `defaultAuditSink` (InMemoryAuditSink) is shared within a single process, but RSC rendering and API route execution may run in different Node.js worker threads under Next.js dev mode. Audit events emitted by the session monitor may not appear in the RSC-rendered admin pages until Prisma persistence lands.
- **Dev preview principal** (`?previewRole=admin`) is active only when `NODE_ENV !== production` and `RD_SYNC_DEV_PREVIEW=enabled`. It is disabled in production unconditionally.
