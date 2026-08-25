# Bank Session Runbook — Via B (Popular Portal)

## How the session works

RD-Sync attaches to a human-opened Brave browser via Chrome DevTools Protocol (CDP). There are no stored credentials and no session secrets — the session lives entirely in the running browser. The admin logs in manually (including MFA) once, and the browser keeps the session alive through cookies.

The bank portal (Banco Popular) expires sessions after a short inactivity window. RD-Sync cannot refresh the session automatically. When the session expires, the admin must log in again.

## Launching the dedicated browser

### Asignación de puertos y perfiles por portal

Cada portal es una identidad de runtime distinta (`bankCode`) y **debe** tener su propio puerto CDP loopback y su propio perfil persistente. Dos portales en el mismo puerto permiten que el worker se conecte a la sesión equivocada; dos portales en el mismo perfil de Chromium activan el bloqueo *singleton*, que hace que el segundo lanzamiento reutilice el primer navegador e **ignore silenciosamente** el `--remote-debugging-port` solicitado.

Asignación operativa vigente (el lanzador no la inventa: la exige por variable de entorno):

| Portal (`bankCode`) | Puerto CDP | Variable de entorno | Perfil por defecto (Windows) |
|---|---|---|---|
| `popular` | 9222 | `RD_SYNC_BANK_POPULAR_CDP_URL=http://127.0.0.1:9222` | `%LOCALAPPDATA%\rd-sync\bank-browser\popular` |
| `bhd_personal` | 9223 | `RD_SYNC_BANK_BHD_PERSONAL_CDP_URL=http://127.0.0.1:9223` | `…\bank-browser\bhd_personal` |
| `banreservas_personas` | 9224 | `RD_SYNC_BANK_BANRESERVAS_PERSONAS_CDP_URL=http://127.0.0.1:9224` | `…\bank-browser\banreservas_personas` |
| `banreservas_empresas` | 9225 | `RD_SYNC_BANK_BANRESERVAS_EMPRESAS_CDP_URL=http://127.0.0.1:9225` | `…\bank-browser\banreservas_empresas` |
| `bhd_empresarial` (diferido) | 9226 reservado | `RD_SYNC_BANK_BHD_EMPRESARIAL_CDP_URL=http://127.0.0.1:9226` | `…\bank-browser\bhd_empresarial` |

Reglas que el lanzador **aplica**, no solo documenta:

- Solo `popular` puede heredar `RD_SYNC_CDP_URL` o el puerto compartido por defecto. Cualquier otro portal sin su propia variable **falla cerrado**.
- Una identidad de portal desconocida se rechaza; nunca se degrada a otro portal.
- El endpoint debe ser `http://` loopback (`127.0.0.1`, `localhost` o `::1`), solo origen, con puerto entre 1 y 65535.
- Si otro portal conocido ya declara ese puerto, el lanzamiento se rechaza por colisión.
- El puerto **siempre** sale de la URL CDP resuelta: no hay ajuste `DEBUG_PORT`, así que lanzador y worker no pueden desincronizarse.
- Nunca se comparten credenciales con RD-Sync: login, MFA y preguntas de seguridad los completa una persona.

Estas variables se definen en el entorno del operador/worker; no se versionan.

### Windows (desarrollo y pruebas live)

El lanzador abre **un portal a la vez**, seleccionado por `BANK_CODE`:

```powershell
.\scripts\launch-bank-browser.ps1 bhd_personal
```

Acepta el portal como argumento posicional, como `-BankCode`, o desde la variable `BANK_CODE` (la vía que usa el worker cuando el auto-lanzamiento está activo). Para inspeccionar la resolución sin abrir nada:

```powershell
.\scripts\launch-bank-browser.ps1 bhd_personal -DryRun
```

El lanzador:
- Falla cerrado si no se indica portal, si el portal es desconocido o si falta su endpoint propio
- Crea un perfil persistente por portal: `RD_SYNC_BANK_<PORTAL>_PROFILE_DIR` textual → `RD_SYNC_BANK_BROWSER_PROFILE_DIR` con sufijo `\<bankCode>` → `%LOCALAPPDATA%\rd-sync\bank-browser\<bankCode>`
- Usa una URL inicial propia del portal o verificada; si no hay ninguna verificada abre `about:blank` y avisa. **Nunca** hereda la URL de otro portal
- Solo permite URLs iniciales `https://` o `about:blank`; rechaza `javascript:`, `data:`, `file:` y `http://`
- Toma un lock exclusivo (`.launch.lock`) en el perfil del portal, así dos ejecuciones simultáneas no lanzan dos navegadores; lo mantiene hasta que CDP responde (`RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS`, por defecto 30000)
- Si CDP ya responde en ese puerto, informa y no relanza
- Detecta Brave y Chrome en rutas estándar (`RD_SYNC_BANK_BROWSER_BIN` para forzar una ruta)

La resolución de identidad y endpoint vive en `scripts/lib/bank-portal-endpoint.ps1`, con un test de paridad que la mantiene alineada con `bankPortalIdentities` del runtime.

### Primera sesión live de un portal (procedimiento manual)

RD-Sync no automatiza login, MFA ni preguntas de seguridad. Por cada portal, una persona hace esto una vez:

1. Defina la variable CDP del portal según la tabla.
2. Ejecute el lanzador con ese `bankCode`.
3. Inicie sesión con las credenciales del portal.
4. Complete MFA y preguntas de seguridad si el portal las pide.
5. Cuando el portal ofrezca recordar o confiar en el dispositivo, **acéptelo**: las siguientes sesiones en ese perfil evitan repetir el MFA.
6. Deje el navegador abierto. RD-Sync se conecta por CDP en modo lectura.

No navegue sitios personales ni otro portal dentro de ese perfil: las cookies del portal son la sesión completa.

### Linux server (production)

Use the provided Bash script to open Brave/Chromium with an isolated profile. **Pase siempre el código de banco** como argumento para que el perfil y el puerto CDP queden asociados al banco correcto:

```bash
./scripts/launch-bank-browser.sh popular
```

> **Importante (multi-banco):** cuando configure un endpoint por banco con `RD_SYNC_BANK_<BANCO>_CDP_URL`, **debe** lanzar el script con el mismo código de banco (`./scripts/launch-bank-browser.sh <banco>`). Solo así el lanzador abre el navegador en el mismo puerto loopback que el worker consulta para ese banco. Si ejecuta el script sin código de banco, la configuración por banco se ignora y se usa la URL CDP global/por defecto — el lanzador imprime una advertencia en stderr para avisarle.

The script:
- Detects the first available browser binary in this order: `brave-browser`, `brave`, `chromium-browser`, `chromium`, `google-chrome` (override with `RD_SYNC_BANK_BROWSER_BIN`)
- Creates a persistent profile at `~/.local/share/rd-sync/bank-browser` — bank-scoped to `…/bank-browser/<bank_code>` when a bank code is passed so each bank stays isolated. A **global** `RD_SYNC_BANK_BROWSER_PROFILE_DIR` is also bank-scoped (it gets `/<bank_code>` appended); only a per-bank `RD_SYNC_BANK_<BANK>_PROFILE_DIR` is used verbatim
- Binds CDP to **127.0.0.1 only**; the debug port ALWAYS comes from the resolved CDP URL (`RD_SYNC_BANK_<BANK>_CDP_URL` / `RD_SYNC_CDP_URL`) so it always matches the worker. There is no `DEBUG_PORT` knob. When no CDP URL is configured, the launcher and worker share one default (`http://127.0.0.1:9222`) — never exposes CDP to the network
- Abre la URL inicial del portal indicado: `RD_SYNC_BANK_<BANCO>_START_URL` → `RD_SYNC_BANK_BROWSER_START_URL` → la URL **verificada** de ese portal (`popular` → `https://ib.bpd.com.do`, `bhd_personal` → `https://ibp.bhd.com.do/#/login`). Un portal sin URL verificada abre `about:blank` con una advertencia: **nunca** hereda la URL de otro banco, porque llevaría a iniciar sesión en el portal equivocado dentro de un perfil dedicado a otro
- Solo acepta URLs iniciales `https://` o `about:blank`; rechaza `javascript:`, `data:`, `file:` y `http://`
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
5. **Relance manualmente** solo cuando esté listo: `./scripts/launch-bank-browser.sh <banco>` (p. ej. `popular`) y complete el login/MFA. Use el mismo código de banco configurado en `RD_SYNC_BANK_<BANCO>_CDP_URL`.

## Logging in

1. Run the launch script above.
2. In the Brave window that opens, navigate to the bank portal and log in with your credentials and MFA code.
3. Leave the browser open. RD-Sync will attach to it automatically on the next scheduled or manual scrape.

Because the profile is persistent, cookies survive browser restarts. After the initial login you should only need to re-authenticate when the bank expires the session.

## What the session monitor does

When `RD_SYNC_SESSION_MONITOR=enabled`, the ingestion worker performs live CDP checks and emits only safe alert transitions and monitor audits. The status endpoint still performs a live, read-only session check and reports these three states:

The expiry runtime is alert/outbox-only. It does not create expiry episodes, schedule publication jobs, observe publication state, or require Redis for monitoring. Existing durable episode and manual-resolution rows remain untouched. Publication retirement is in progress; authenticated-ingestion activation is not part of this runbook change.

Los trabajos `bank-session-expiry-publication` ya encolados todavía no se retiran con WU5a y continúan pasando por el consumidor existente. WU5b los validará y confirmará como inertes, sin ingesta ni mutación; ese comportamiento aún no está activo. WU5a solo se despliega dentro del artefacto completo del corte coordinado de ramas, nunca de forma independiente a `main`.

| Status | Meaning |
|--------|---------|
| `active` | Session is live and the dashboard loaded correctly |
| `expired` | The portal redirected away from the dashboard, or the dashboard did not render |
| `browser_unavailable` | CDP could not attach (Brave is not running or the port is wrong) |

When a future lifecycle owner activates the monitor, the durable winner may attempt alerts only on **transitions**:
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
    "enabled": false,
    "lastResult": null
  }
}
```

`session` reflects a **live check** performed at request time.
`monitor.lastResult` is `null` while the API-process monitor remains deliberately dormant.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RD_SYNC_SCRAPER` | — | Set to `popular-cdp` to enable the CDP-backed scraper and session checker |
| `RD_SYNC_CDP_URL` | `http://127.0.0.1:9222` | Global CDP endpoint for the running Brave session (bind to 127.0.0.1 only). Single-bank-only fallback — with 2+ registered banks each must set a distinct `RD_SYNC_BANK_<BANK>_CDP_URL` |
| `RD_SYNC_SESSION_MONITOR` | — | Set to `enabled` in the ingestion worker to activate alert/outbox-only monitoring |
| `RD_SYNC_SESSION_CHECK_INTERVAL_MS` | `300000` (5 min) | Poll interval in milliseconds; minimum 60000 (1 min) |
| `RD_SYNC_ALERT_SMTP_URL` | — | SMTP URL for alert emails; falls back to console.warn if absent |
| `RD_SYNC_ADMIN_EMAIL` | — | Recipient address for alert emails |
| `RD_SYNC_BANK_BROWSER_AUTO_LAUNCH` | — | Set to `enabled` to let the worker start the bank browser before connecting |
| `RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND` | — | Trusted local command that starts the bank browser (server config only) |
| `RD_SYNC_BANK_BROWSER_READY_TIMEOUT_MS` | `30000` | Max wait for CDP after launching the browser |
| `RD_SYNC_BANK_BROWSER_POLL_INTERVAL_MS` | `500` | Poll interval while waiting for CDP |
| `RD_SYNC_BANK_BROWSER_PROFILE_DIR` | `~/.local/share/rd-sync/bank-browser[/<bank_code>]` | GLOBAL persistent browser profile dir (used by the launch script). Bank-scoped by appending `/<bank_code>` when a bank code is given. A per-bank `RD_SYNC_BANK_<BANK>_PROFILE_DIR` is used verbatim |

## Security warnings

- **CDP bound to 127.0.0.1 only.** El script de lanzamiento siempre usa `--remote-debugging-address=127.0.0.1`. Nunca exponga CDP a Internet o a la red local — cualquiera con acceso al endpoint CDP podría controlar la sesión bancaria autenticada.
- **Distinct CDP URL/port per registered bank.** Cada banco registrado debe usar un puerto CDP loopback distinto vía `RD_SYNC_BANK_<BANK>_CDP_URL`. Si dos bancos comparten el mismo puerto, el worker podría adjuntarse a la sesión del banco equivocado; por eso el registro de adaptadores falla de forma cerrada al arrancar si detecta una colisión de puerto. El fallback global `RD_SYNC_CDP_URL` es solo para un único banco.
- **No automated credential entry.** RD-Sync no introduce credenciales ni completa MFA. El administrador inicia sesión manualmente en el navegador del servidor.
- **No Imperva/anti-bot bypass.** RD-Sync no evade las defensas anti-bot del banco. El scraper es de solo lectura: navega y extrae transacciones sobre una sesión abierta por un humano.
- **Launch command is trusted server config.** `RD_SYNC_BANK_BROWSER_LAUNCH_COMMAND` solo se establece en la configuración del servidor gestionada por el operador. Nunca desde entrada de usuario ni desde la interfaz de empleado.

## Dev-mode caveats

- **Restart the dev server after changing scraper code.** Next.js hot-reload does not re-execute module-level wiring code (`consumer-defaults.ts`, `bank-sessions/defaults.ts`). Env vars are read at import time.
- **Admin RSC pages and API routes maintain separate in-memory state.** The `defaultAuditSink` (InMemoryAuditSink) is shared within a single process, but RSC rendering and API route execution may run in different Node.js worker threads under Next.js dev mode. Audit events emitted by the session monitor may not appear in the RSC-rendered admin pages until Prisma persistence lands.
- **Dev preview principal** (`?previewRole=admin`) is active only when `NODE_ENV !== production` and `RD_SYNC_DEV_PREVIEW=enabled`. It is disabled in production unconditionally.
