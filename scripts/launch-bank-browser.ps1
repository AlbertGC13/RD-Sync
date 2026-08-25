# launch-bank-browser.ps1
#
# Launches Brave/Chromium with a DEDICATED persistent profile and a DEDICATED
# loopback CDP port for ONE bank portal used by RD-Sync.
#
# USAGE:
#   .\scripts\launch-bank-browser.ps1 <bank_code>
#   .\scripts\launch-bank-browser.ps1 -BankCode bhd_personal -DryRun
#
# Environment (per portal first, then global):
#   RD_SYNC_BANK_<PORTAL>_CDP_URL      / RD_SYNC_CDP_URL      (Popular only)
#   RD_SYNC_BANK_<PORTAL>_PROFILE_DIR  / RD_SYNC_BANK_BROWSER_PROFILE_DIR
#   RD_SYNC_BANK_<PORTAL>_START_URL    / RD_SYNC_BANK_BROWSER_START_URL
#   RD_SYNC_BANK_BROWSER_BIN           — override the browser binary path
#
# The CDP URL is the SINGLE source of truth for the debug port and is shared
# verbatim with the worker (resolveBankBrowserEnv). There is NO DEBUG_PORT knob.
#
# SECURITY: CDP binds to loopback ONLY. This script never reads, stores, or
# types credentials; the operator logs in manually and completes MFA.

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$BankCode,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

. "$PSScriptRoot\lib\bank-portal-endpoint.ps1"

# Start URLs VERIFIED against each portal's runtime configuration. A portal with
# no verified URL opens about:blank — it NEVER inherits another portal's URL,
# which would send the operator to log in at the wrong bank.
$VERIFIED_PORTAL_START_URLS = @{
    "popular"      = "https://ib.bpd.com.do"
    "bhd_personal" = "https://ibp.bhd.com.do/#/login"
}

function Write-ErrLine([string]$message) {
    [Console]::Error.WriteLine($message)
}

function Exit-WithFailure($result) {
    Write-ErrLine "ERROR: $($result.message)"
    exit 1
}

# Only https origins and about:blank may reach the browser argv. javascript:,
# data:, file: and plain http: are refused: the launcher hands this URL to a
# browser holding a bank session.
function Test-SafeStartUrl([string]$Url) {
    if ($Url -eq "about:blank") { return $true }
    if ($Url -notmatch '^https://[^\s"'']+$') { return $false }

    try {
        $parsed = [Uri]$Url
    } catch {
        return $false
    }
    return $parsed.Scheme -eq "https" -and -not [string]::IsNullOrWhiteSpace($parsed.Host)
}

# ---------------------------------------------------------------------------
# 1. Portal identity and CDP endpoint (scripts/lib/bank-portal-endpoint.ps1).
# ---------------------------------------------------------------------------
$identity = Resolve-BankPortalCode $BankCode
if (-not $identity.ok) { Exit-WithFailure $identity }
$BankCode = $identity.bankCode

$endpoint = Resolve-PortalCdpEndpoint $BankCode
if (-not $endpoint.ok) { Exit-WithFailure $endpoint }

$cdpPort = $endpoint.cdpPort
$cdpBindAddress = $endpoint.cdpBind
$cdpProbeHost = if ($cdpBindAddress -eq "::1") { "[::1]" } else { "127.0.0.1" }
$bankPrefix = Get-BankEnvPrefix $BankCode

# ---------------------------------------------------------------------------
# 2. Profile directory — one persistent profile per portal.
#      1. Per-portal RD_SYNC_BANK_<PORTAL>_PROFILE_DIR — used VERBATIM.
#      2. Global RD_SYNC_BANK_BROWSER_PROFILE_DIR — portal-SCOPED, so one
#         global override can never collapse two portals onto one profile.
#      3. Default %LOCALAPPDATA%\rd-sync\bank-browser\<bank_code>.
# ---------------------------------------------------------------------------
$perBankProfileDir = Get-BankEnvValue ($bankPrefix + "PROFILE_DIR")
$globalProfileDir = Get-BankEnvValue "RD_SYNC_BANK_BROWSER_PROFILE_DIR"

if ($perBankProfileDir) {
    $profileDir = $perBankProfileDir.TrimEnd("\", "/")
} elseif ($globalProfileDir) {
    $profileDir = Join-Path ($globalProfileDir.TrimEnd("\", "/")) $BankCode
} else {
    $localAppData = Get-BankEnvValue "LOCALAPPDATA"
    if (-not $localAppData) {
        Write-ErrLine "ERROR: LOCALAPPDATA no esta definida y no hay directorio de perfil configurado."
        exit 1
    }
    $profileDir = Join-Path (Join-Path (Join-Path $localAppData "rd-sync") "bank-browser") $BankCode
}

# ---------------------------------------------------------------------------
# 3. Start URL — per portal, then global, then the VERIFIED map, then blank.
# ---------------------------------------------------------------------------
$startUrl = Get-BankEnvValue ($bankPrefix + "START_URL")
if (-not $startUrl) { $startUrl = Get-BankEnvValue "RD_SYNC_BANK_BROWSER_START_URL" }
if (-not $startUrl) { $startUrl = $VERIFIED_PORTAL_START_URLS[$BankCode] }
if (-not $startUrl) {
    $startUrl = "about:blank"
    Write-ErrLine "ADVERTENCIA: no hay URL inicial verificada para '$BankCode'; se abre una pestana en blanco."
    Write-ErrLine "             Defina '$($bankPrefix)START_URL' con la URL del portal."
}

$startUrl = $startUrl.Trim()
if (-not (Test-SafeStartUrl $startUrl)) {
    Write-ErrLine "ERROR: la URL inicial debe ser https:// o about:blank."
    exit 1
}

# ---------------------------------------------------------------------------
# 4. Resolved plan. -DryRun stops here: nothing is created, no browser runs.
# ---------------------------------------------------------------------------
Write-Output "plan.bankCode=$BankCode"
Write-Output "plan.cdpUrl=$($endpoint.cdpUrl)"
Write-Output "plan.cdpPort=$cdpPort"
Write-Output "plan.cdpBind=$cdpBindAddress"
Write-Output "plan.profileDir=$profileDir"
Write-Output "plan.startUrl=$startUrl"

if ($DryRun) { exit 0 }

Write-ErrLine "ERROR: la ejecucion del navegador se incorpora en el siguiente slice del lanzador."
exit 1
