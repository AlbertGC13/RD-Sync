# launch-bank-browser.ps1
#
# PURPOSE: Launches Brave Browser with a DEDICATED persistent profile for the
# bank session used by RD-Sync.
#
# WHY A DEDICATED PROFILE:
#   - Cookies and session data survive browser restarts, so MFA re-login is
#     required less frequently.
#   - Isolates the bank session from personal browsing data.
#   - Never browse personal sites in this profile — keep it bank-only.
#
# USAGE:
#   .\scripts\launch-bank-browser.ps1
#
# After Brave opens, log in to the bank portal manually (including MFA).
# RD-Sync will attach to the running browser via CDP on port 9222.

$profileDir = "$env:LOCALAPPDATA\rd-sync\bank-browser"
$debugPort = 9222

# Detect Brave at the two standard install locations.
$bravePaths = @(
    "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
    "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe"
)

$bravePath = $null
foreach ($path in $bravePaths) {
    if (Test-Path $path) {
        $bravePath = $path
        break
    }
}

if (-not $bravePath) {
    Write-Error @"
Brave Browser not found at either of the expected locations:
  $($bravePaths -join "`n  ")

Install Brave from https://brave.com/download and run this script again.
"@
    exit 1
}

Write-Host "Launching Brave with dedicated bank profile..."
Write-Host "  Profile dir : $profileDir"
Write-Host "  CDP port    : $debugPort"
Write-Host ""
Write-Host "After Brave opens, log in to the bank portal and complete MFA."
Write-Host "RD-Sync will attach automatically on the next scheduled or manual scrape."

Start-Process -FilePath $bravePath -ArgumentList @(
    "--user-data-dir=`"$profileDir`"",
    "--remote-debugging-port=$debugPort",
    "--no-first-run"
)
