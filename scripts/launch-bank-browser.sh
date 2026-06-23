#!/usr/bin/env bash
#
# launch-bank-browser.sh
#
# Launches Brave/Chromium with a DEDICATED persistent profile for the bank
# session used by RD-Sync on a Linux server.
#
# The browser exposes Chrome DevTools Protocol (CDP) on 127.0.0.1 ONLY so the
# RD-Sync worker can attach read-only. CDP is NEVER bound to 0.0.0.0 — exposing
# it to the network would let anyone drive the logged-in bank session.
#
# After the browser opens, an admin must log in to the bank portal manually
# (including MFA). RD-Sync does NOT automate login or MFA, and does NOT
# attempt to evade the bank's anti-bot defences.
#
# Usage:
#   ./scripts/launch-bank-browser.sh
#
# Environment variables (all optional):
#   RD_SYNC_BANK_BROWSER_BIN          — override browser binary path
#   RD_SYNC_BANK_BROWSER_PROFILE_DIR  — persistent profile directory
#   RD_SYNC_BANK_BROWSER_DEBUG_PORT   — CDP debug port (default 9222)
#   RD_SYNC_BANK_BROWSER_START_URL    — initial URL (default https://ib.bpd.com.do)
#   RD_SYNC_BANK_BROWSER_LOG_FILE     — stdout/stderr log file
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Hardening (Fix B — R4 CRITICAL: profile/log permissions too open)
#
# umask 077 ensures every file/dir created by this script (profile dir, lock
# file, log file) is only readable/writable by the current user. The bank
# profile holds authenticated session cookies — it must never be group/world
# accessible.
# ---------------------------------------------------------------------------
umask 077

profileDir="${RD_SYNC_BANK_BROWSER_PROFILE_DIR:-$HOME/.local/share/rd-sync/bank-browser}"
debugPort="${RD_SYNC_BANK_BROWSER_DEBUG_PORT:-9222}"
startUrl="${RD_SYNC_BANK_BROWSER_START_URL:-https://ib.bpd.com.do}"
logFile="${RD_SYNC_BANK_BROWSER_LOG_FILE:-$profileDir/browser.log}"
lockFile="$profileDir/.launch.lock"

# ---------------------------------------------------------------------------
# Pre-flight: curl is required to probe the CDP endpoint.
# ---------------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
  echo "ERROR: 'curl' no está instalado. Instale curl para verificar el estado de CDP." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# detectBrowser — locate a Brave/Chromium binary in PATH order.
# Returns the binary name on stdout, exits non-zero if none found.
# ---------------------------------------------------------------------------
detectBrowser() {
  if [[ -n "${RD_SYNC_BANK_BROWSER_BIN:-}" ]]; then
    printf '%s' "$RD_SYNC_BANK_BROWSER_BIN"
    return 0
  fi

  local candidates=(
    "brave-browser"
    "brave"
    "chromium-browser"
    "chromium"
    "google-chrome"
  )

  local bin
  for bin in "${candidates[@]}"; do
    if command -v "$bin" >/dev/null 2>&1; then
      printf '%s' "$bin"
      return 0
    fi
  done

  return 1
}

# ---------------------------------------------------------------------------
# cdpAlive — check whether CDP is already responding on the debug port.
# ---------------------------------------------------------------------------
cdpAlive() {
  curl -fsS "http://127.0.0.1:${debugPort}/json/version" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# prepareProfileDir — create the profile dir with secure permissions and verify
# ownership (Fix B). Refuses to operate on a profile dir owned by another user.
# ---------------------------------------------------------------------------
prepareProfileDir() {
  mkdir -p "$profileDir"
  chmod 700 "$profileDir"

  # Ownership guard: refuse if the profile dir exists and is not owned by the
  # current user. A profile owned by another account could hold a different
  # (or compromised) session. `stat -c %u` is GNU stat (Linux); if stat is
  # unavailable we warn but continue — the umask/chmod already restrict access.
  if command -v stat >/dev/null 2>&1; then
    local ownerUid
    ownerUid="$(stat -c '%u' "$profileDir" 2>/dev/null || echo '')"
    if [[ -n "$ownerUid" && "$ownerUid" != "$(id -u)" ]]; then
      echo "ERROR: el directorio de perfil '$profileDir' no pertenece al usuario actual." >&2
      echo "       Reasigne la propiedad o elimine el directorio antes de continuar." >&2
      exit 1
    fi
  else
    echo "ADVERTENCIA: 'stat' no está disponible; no se pudo verificar la propiedad del perfil." >&2
  fi
}

# ---------------------------------------------------------------------------
# prepareLogFile — ensure the browser log exists with 0600 permissions before
# any redirect appends to it (Fix B). Prevents a pre-existing world-readable
# log from leaking browser output.
# ---------------------------------------------------------------------------
prepareLogFile() {
  touch "$logFile"
  chmod 600 "$logFile"
}

# ---------------------------------------------------------------------------
# acquireLaunchLock — shell-level mutex so concurrent invocations (e.g. the
# worker auto-launch racing a manual operator run) do not spawn two browsers
# (Fix A — R4 CRITICAL).
#
# Uses flock when available. The lock file lives under the profile dir. After
# acquiring, the caller MUST re-check CDP (double-checked locking): another
# invocation may have launched the browser between the initial fast check and
# the lock acquisition.
# ---------------------------------------------------------------------------
acquireLaunchLock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$lockFile"
    flock 9
    return 0
  fi

  echo "ADVERTENCIA: 'flock' no está disponible. Se continúa sin bloqueo de lanzamiento;" >&2
  echo "             verifique el estado de CDP antes de lanzar para evitar procesos duplicados." >&2
  return 0
}

# ---------------------------------------------------------------------------
# Main
#
# Double-checked locking flow (Fix A):
#   1. Fast CDP check (no lock) — common case: already alive → exit 0 fast.
#   2. Prepare profile + log with secure perms (Fix B).
#   3. Acquire the launch lock.
#   4. Re-check CDP under the lock — another process may have launched it.
#   5. Detect browser + launch.
# ---------------------------------------------------------------------------

# 1. Fast path — avoid lock contention when the browser is already running.
if cdpAlive; then
  echo "El navegador del banco ya está corriendo en el puerto ${debugPort} (CDP activo)."
  echo "No se relanzó. RD-Sync puede conectarse directamente."
  exit 0
fi

# 2. Secure profile + log (Fix B). Done before the lock so the lock file can be
#    created under the profile dir with correct permissions.
prepareProfileDir
prepareLogFile

# 3. Acquire the launch lock (Fix A).
acquireLaunchLock

# 4. Re-check CDP under the lock — a concurrent invocation may have launched
#    the browser between the fast check and the lock acquisition.
if cdpAlive; then
  echo "El navegador del banco ya está corriendo en el puerto ${debugPort} (CDP activo)."
  echo "No se relanzó. RD-Sync puede conectarse directamente."
  exit 0
fi

# 5. Detect the browser binary and launch.
browserBin=""
if ! browserBin="$(detectBrowser)"; then
  echo "ERROR: No se encontró ningún navegador Brave/Chromium instalado." >&2
  echo "Se buscaron: brave-browser, brave, chromium-browser, chromium, google-chrome." >&2
  echo "Instale Brave o Chromium, o defina RD_SYNC_BANK_BROWSER_BIN con la ruta al binario." >&2
  exit 1
fi

echo "Lanzando navegador del banco..."
echo "  Navegador  : $browserBin"
echo "  Perfil     : $profileDir"
echo "  Puerto CDP : $debugPort (127.0.0.1 únicamente)"
echo "  URL inicial: $startUrl"
echo "  Log        : $logFile"
echo ""

# Launch detached. stdout/stderr are redirected to the log file so this script
# can exit without killing the browser. CDP is bound to 127.0.0.1 only.
nohup "$browserBin" \
  --user-data-dir="$profileDir" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$debugPort" \
  --no-first-run \
  --new-window "$startUrl" \
  >>"$logFile" 2>&1 &

disown 2>/dev/null || true

echo "============================================================"
echo "INSTRUCCIONES PARA EL ADMINISTRADOR"
echo "============================================================"
echo ""
echo "1. En la ventana del navegador que se abrió, inicie sesión en el"
echo "   portal bancario con sus credenciales."
echo "2. Complete la autenticación de dos factores (MFA) si el portal la"
echo "   solicita."
echo "3. Deje el navegador abierto. RD-Sync se conectará automáticamente"
echo "   en el próximo scrape programado o manual."
echo ""
echo "ADVERTENCIA: No navegue sitios personales en este perfil."
echo "             Manténgalo exclusivo para el banco."
echo "             CDP está limitado a 127.0.0.1 — no exponer a Internet."
echo "============================================================"
