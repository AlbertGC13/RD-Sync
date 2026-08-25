# bank-portal-endpoint.ps1
#
# Portal identity and CDP endpoint resolution shared by the Windows bank
# browser launcher. Dot-source it:
#
#   . "$PSScriptRoot\lib\bank-portal-endpoint.ps1"
#
# Every function here only reads env vars and returns a result object: nothing
# is launched or mutated, so the rules stay testable without a browser.
#
# WHY EACH PORTAL NEEDS ITS OWN LOOPBACK PORT: two portals sharing one CDP port
# let the worker attach to the WRONG portal's authenticated session, and two
# portals sharing one Chromium profile trip the singleton lock — the second
# launch reuses the first browser and silently ignores its own
# --remote-debugging-port. Both failures are silent, so they are refused here.

# Canonical portal identities. MUST match bankPortalIdentities in
# src/modules/bank-adapters/bank-identities.ts; a parity test enforces it.
$KNOWN_PORTAL_CODES = @(
    "popular",
    "bhd_personal",
    "bhd_empresarial",
    "banreservas_personas",
    "banreservas_empresas"
)

# Only this portal may inherit the global/shared CDP endpoint. Every other
# portal MUST declare its own loopback port.
$SHARED_ENDPOINT_PORTAL = "popular"

# RD-Sync shared default CDP URL. MUST equal the worker's DEFAULT_CDP_URL in
# src/worker/scraper/browser-runtime.ts; a parity test enforces the origin.
$DEFAULT_CDP_URL = "http://127.0.0.1:9222"

$CDP_URL_PATTERN = '^http://(\[[^\]]+\]|[^/@:?#]+):([0-9]{1,5})$'
$LOOPBACK_HOSTS = @("127.0.0.1", "localhost", "::1", "[::1]")

function Get-BankEnvValue([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    return $value
}

function Get-BankEnvPrefix([string]$PortalCode) {
    return "RD_SYNC_BANK_" + $PortalCode.ToUpperInvariant() + "_"
}

# Returns the loopback port of a CDP URL, or 0 when it is not a well-formed
# http loopback origin with a port in 1-65535.
function Get-LoopbackCdpPort([string]$Url) {
    if ([string]::IsNullOrWhiteSpace($Url)) { return 0 }
    if ($Url.Trim() -notmatch $CDP_URL_PATTERN) { return 0 }

    $urlHost = $Matches[1].ToLowerInvariant()
    $rawPort = $Matches[2]

    if ($LOOPBACK_HOSTS -notcontains $urlHost) { return 0 }
    if ($rawPort -match '^0') { return 0 }

    $port = 0
    if (-not [int]::TryParse($rawPort, [ref]$port)) { return 0 }
    if ($port -lt 1 -or $port -gt 65535) { return 0 }
    return $port
}

function Get-CdpBindAddress([string]$Url) {
    if ($Url.Trim() -match $CDP_URL_PATTERN -and $LOOPBACK_HOSTS -contains $Matches[1].ToLowerInvariant()) {
        if (@("::1", "[::1]") -contains $Matches[1].ToLowerInvariant()) { return "::1" }
    }
    return "127.0.0.1"
}

function New-PortalEndpointFailure([string]$Code, [string]$Message) {
    return [pscustomobject]@{
        ok      = $false
        error   = $Code
        message = $Message
    }
}

# Normalizes and validates a portal identity. Fails with `missing_bank_code` or
# `unknown_portal`: an unknown identity is refused outright, never guessed and
# never silently mapped onto another portal.
function Resolve-BankPortalCode([string]$BankCode) {
    if ([string]::IsNullOrWhiteSpace($BankCode)) {
        $BankCode = Get-BankEnvValue "BANK_CODE"
    }

    if ([string]::IsNullOrWhiteSpace($BankCode)) {
        return New-PortalEndpointFailure "missing_bank_code" `
            "Falta el codigo de portal (BANK_CODE). Portales: $($KNOWN_PORTAL_CODES -join ', ')"
    }

    $normalized = $BankCode.Trim().ToLowerInvariant()
    if ($KNOWN_PORTAL_CODES -notcontains $normalized) {
        return New-PortalEndpointFailure "unknown_portal" `
            "'$normalized' no es un portal conocido de RD-Sync. Portales: $($KNOWN_PORTAL_CODES -join ', ')"
    }

    return [pscustomobject]@{ ok = $true; error = $null; message = $null; bankCode = $normalized }
}

# Resolves the loopback CDP endpoint for one portal. Precedence:
# RD_SYNC_BANK_<PORTAL>_CDP_URL, then — for the shared-endpoint portal ONLY —
# RD_SYNC_CDP_URL and finally DEFAULT_CDP_URL. Failure codes:
# `missing_endpoint` (non-Popular portal with no endpoint of its own),
# `invalid_endpoint` (not an http loopback origin / port outside 1-65535),
# `port_collision` (another known portal already claims that port).
function Resolve-PortalCdpEndpoint([string]$BankCode) {
    $prefix = Get-BankEnvPrefix $BankCode
    $perBankKey = $prefix + "CDP_URL"
    $cdpUrl = Get-BankEnvValue $perBankKey

    if (-not $cdpUrl) {
        if ($BankCode -ne $SHARED_ENDPOINT_PORTAL) {
            return New-PortalEndpointFailure "missing_endpoint" `
                ("'$perBankKey' no esta definida. Los portales distintos de " +
                 "'$SHARED_ENDPOINT_PORTAL' exigen un endpoint CDP loopback propio; heredar el " +
                 "endpoint global haria que dos portales compartan una misma sesion.")
        }

        $cdpUrl = Get-BankEnvValue "RD_SYNC_CDP_URL"
        if (-not $cdpUrl) { $cdpUrl = $DEFAULT_CDP_URL }
    }

    $cdpUrl = $cdpUrl.Trim()
    $cdpPort = Get-LoopbackCdpPort $cdpUrl
    if ($cdpPort -eq 0) {
        return New-PortalEndpointFailure "invalid_endpoint" `
            ("La URL CDP debe ser http://loopback:puerto (127.0.0.1, localhost o ::1) con un " +
             "puerto entre 1 y 65535, sin ruta, credenciales ni query.")
    }

    foreach ($otherCode in $KNOWN_PORTAL_CODES) {
        if ($otherCode -eq $BankCode) { continue }
        $otherUrl = Get-BankEnvValue ((Get-BankEnvPrefix $otherCode) + "CDP_URL")
        if (-not $otherUrl) { continue }
        if ((Get-LoopbackCdpPort $otherUrl) -eq $cdpPort) {
            return New-PortalEndpointFailure "port_collision" `
                "El puerto CDP $cdpPort ya esta asignado al portal '$otherCode'. Cada portal necesita un puerto propio."
        }
    }

    return [pscustomobject]@{
        ok       = $true
        error    = $null
        message  = $null
        bankCode = $BankCode
        cdpUrl   = $cdpUrl
        cdpPort  = $cdpPort
        cdpBind  = (Get-CdpBindAddress $cdpUrl)
    }
}
