#!/usr/bin/env bash
#
# launch-bank-browser.sh
#
# Launches Brave/Chromium with a DEDICATED persistent profile for a specific
# bank session used by RD-Sync on a Linux server.
#
# The browser exposes Chrome DevTools Protocol (CDP) on loopback ONLY so the
# RD-Sync worker can attach read-only. CDP is NEVER bound to 0.0.0.0 — exposing
# it to the network would let anyone drive the logged-in bank session.
#
# After the browser opens, an admin must log in to the bank portal manually
# (including MFA). RD-Sync does NOT automate login or MFA, and does NOT
# attempt to evade the bank's anti-bot defences.
#
# Usage:
#   ./scripts/launch-bank-browser.sh [BANK_CODE]
#
# Environment variables (all optional):
#   RD_SYNC_BANK_BROWSER_BIN          — override browser binary path
#   RD_SYNC_CDP_URL                   — global CDP endpoint (loopback only)
#   RD_SYNC_BANK_BROWSER_PROFILE_DIR  — persistent profile directory (global; bank-scoped)
#   RD_SYNC_BANK_BROWSER_START_URL    — initial URL (default https://ib.bpd.com.do)
#   RD_SYNC_BANK_BROWSER_LOG_FILE     — stdout/stderr log file
#
# Per-bank overrides use RD_SYNC_BANK_<BANK>_{CDP_URL,PROFILE_DIR,START_URL}.
# The CDP URL is the SINGLE source of truth for the debug port and is shared
# verbatim with the worker (resolveBankBrowserEnv). There is NO DEBUG_PORT knob:
# the port ALWAYS comes from the resolved CDP URL so the launcher and worker can
# never disagree. When no CDP URL is configured, both fall back to ONE shared
# default (DEFAULT_CDP_URL below), which must equal the worker's DEFAULT_CDP_URL
# in src/worker/scraper/browser-runtime.ts.
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

# Per-bank variable resolution with global fallback.
BANK_CODE="${1:-${BANK_CODE:-}}"
BANK_PREFIX=""

if [[ -n "$BANK_CODE" ]]; then
  if [[ ! "$BANK_CODE" =~ ^[[:alnum:]_]+$ ]]; then
    echo "ERROR: el código de banco solo puede contener letras, números y guion bajo." >&2
    exit 1
  fi
  BANK_PREFIX="RD_SYNC_BANK_${BANK_CODE^^}_"  # uppercase for env var name
else
  # MEDIUM-3: running WITHOUT a bank code while a per-bank
  # RD_SYNC_BANK_<BANK>_CDP_URL override exists means that override is silently
  # ignored — resolution falls back to the global/default CDP URL, so the
  # launcher may bind a different port than the worker polls for that bank.
  # Warn (never fail) so the operator re-runs with the matching bank code. Only
  # the variable NAME is printed; the URL value is never echoed (no leakage).
  while IFS= read -r perBankCdpVar; do
    [[ -z "$perBankCdpVar" ]] && continue
    echo "ADVERTENCIA: '${perBankCdpVar}' está definida pero el lanzador se ejecutó SIN código de banco." >&2
    echo "             Se usará la URL CDP global/por defecto y se ignorará la configuración por banco," >&2
    echo "             por lo que el lanzador podría abrir un puerto distinto del que el worker consulta." >&2
    echo "             Vuelva a ejecutar con el código de banco correspondiente (p. ej. ./scripts/launch-bank-browser.sh popular)." >&2
  done < <(compgen -v 2>/dev/null | grep -E '^RD_SYNC_BANK_[A-Za-z0-9_]+_CDP_URL$' || true)
fi

resolveBankVar() {
  local perBankKey="${BANK_PREFIX}$1"
  local globalKey="$2"
  local defaultVal="${3:-}"

  if [[ -n "$BANK_CODE" && -n "${!perBankKey:-}" ]]; then
    echo "${!perBankKey}"
  elif [[ -n "${!globalKey:-}" ]]; then
    echo "${!globalKey}"
  else
    echo "$defaultVal"
  fi
}

parsedCdpPort=""
cdpBindAddress="127.0.0.1"
cdpProbeHost="127.0.0.1"

parseLoopbackCdpUrl() {
  local rawUrl="$1"
  local host=""
  local port=""

  if [[ ! "$rawUrl" =~ ^http://(\[[^]]+\]|[^/@:?#/]+):([0-9]+)$ ]]; then
    echo "ERROR: RD-Sync CDP URL debe tener formato http://loopback:puerto." >&2
    exit 1
  fi

  host="${BASH_REMATCH[1],,}"
  port="${BASH_REMATCH[2]}"

  case "$host" in
    "127.0.0.1"|"localhost")
      cdpBindAddress="127.0.0.1"
      cdpProbeHost="127.0.0.1"
      ;;
    "::1"|"[::1]")
      cdpBindAddress="::1"
      cdpProbeHost="[::1]"
      ;;
    *)
      echo "ERROR: RD-Sync CDP URL debe usar loopback (127.0.0.1, localhost o ::1)." >&2
      exit 1
      ;;
  esac

  parsedCdpPort="$port"
}

# Bank-scoped profile dir (H1 / MEDIUM-1). Each bank MUST get its own Chromium
# profile: a shared profile trips the Chromium singleton lock and ignores the
# per-bank --remote-debugging-port, silently sharing one logged-in session
# across banks and defeating isolation.
#
# Resolution precedence:
#   1. Per-bank RD_SYNC_BANK_<BANK>_PROFILE_DIR — used VERBATIM (operator chose
#      this exact path for this exact bank).
#   2. Global RD_SYNC_BANK_BROWSER_PROFILE_DIR — bank-SCOPED by appending
#      "/<bank>" when a bank code is set, so a single global override can never
#      collapse two banks onto one profile dir.
#   3. Built-in default ~/.local/share/rd-sync/bank-browser[/<bank>].
defaultProfileDir="$HOME/.local/share/rd-sync/bank-browser"
if [[ -n "$BANK_CODE" ]]; then
  defaultProfileDir="${defaultProfileDir}/${BANK_CODE,,}"
fi

perBankProfileKey="${BANK_PREFIX}PROFILE_DIR"
if [[ -n "$BANK_CODE" && -n "${!perBankProfileKey:-}" ]]; then
  profileDir="${!perBankProfileKey}"
elif [[ -n "${RD_SYNC_BANK_BROWSER_PROFILE_DIR:-}" ]]; then
  profileDir="${RD_SYNC_BANK_BROWSER_PROFILE_DIR%/}"
  if [[ -n "$BANK_CODE" ]]; then
    profileDir="${profileDir}/${BANK_CODE,,}"
  fi
else
  profileDir="$defaultProfileDir"
fi

# CDP URL is the GENUINE single source of truth for the debug port (H2). The
# port is ALWAYS derived from the resolved CDP URL so the launcher and the
# worker's resolveBankBrowserEnv can never disagree. There is no DEBUG_PORT knob.
#
# DEFAULT_CDP_URL is the ONE shared fallback used when neither a per-bank nor a
# global CDP URL is configured. It MUST equal the worker's DEFAULT_CDP_URL in
# src/worker/scraper/browser-runtime.ts; a parity test enforces the port match.
# RD-Sync shared default CDP URL: http://127.0.0.1:9222
DEFAULT_CDP_URL="http://127.0.0.1:9222"

cdpUrl="$(resolveBankVar 'CDP_URL' 'RD_SYNC_CDP_URL' "$DEFAULT_CDP_URL")"
parseLoopbackCdpUrl "$cdpUrl"
debugPort="$parsedCdpPort"

startUrl="$(resolveBankVar 'START_URL' 'RD_SYNC_BANK_BROWSER_START_URL' 'https://ib.bpd.com.do')"
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
  curl -fsS "http://${cdpProbeHost}:${debugPort}/json/version" >/dev/null 2>&1
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
echo "  Puerto CDP : $debugPort (${cdpBindAddress} únicamente)"
echo "  URL inicial: $startUrl"
echo "  Log        : $logFile"
echo ""

# Build the launch argv ONCE so the browser exec and the recorded audit line
# share a single source of truth (the human banner above could otherwise drift
# from the real flags). CDP is bound to loopback only.
launchArgs=(
  --user-data-dir="$profileDir"
  --remote-debugging-address="$cdpBindAddress"
  --remote-debugging-port="$debugPort"
  --no-first-run
  --new-window "$startUrl"
)

# Record the exact launch argv SYNCHRONOUSLY from this (non-detached) process so
# the line is durable even on filesystems where a detached child's async write
# could be lost on shell teardown. This is the real argv passed to the browser.
{
  printf 'launch argv:'
  printf ' %s' "${launchArgs[@]}"
  printf '\n'
} >>"$logFile"

# Launch detached. stdout/stderr are redirected to the log file so this script
# can exit without killing the browser.
nohup "$browserBin" "${launchArgs[@]}" >>"$logFile" 2>&1 &

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
echo "             CDP está limitado a loopback — no exponer a Internet."
echo "============================================================"
