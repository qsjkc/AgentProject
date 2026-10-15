param(
    [string]$PackageDirectory = $PSScriptRoot,
    [string]$ReportDirectory = 'C:\AcceptanceResults',
    [switch]$ValidateOnly
)
$ErrorActionPreference = 'Stop'

# Actual installation is restricted to the disposable Windows Sandbox account.
if (-not $ValidateOnly -and $env:USERNAME -ne 'WDAGUtilityAccount') {
    throw 'Run installation acceptance inside Windows Sandbox. Use -ValidateOnly to check inputs on the host.'
}
$manifest = Get-Content -Raw -LiteralPath (Join-Path $PackageDirectory 'RC2-release-manifest.json') | ConvertFrom-Json
if ($manifest.version -ne '1.1.0-rc.2' -or $manifest.filename -ne 'Detachym-1.1.0-rc.2-x64.exe') {
    throw 'This acceptance kit requires the fixed RC2 candidate.'
}
$installer = Join-Path $PackageDirectory $manifest.filename
$actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $manifest.sha256 -or (Get-Item -LiteralPath $installer).Length -ne $manifest.bytes) {
    throw 'Installer checksum or size mismatch.'
}
if ($ValidateOnly) {
    [pscustomobject]@{ status = 'inputs-validated-only'; version = $manifest.version; sha256 = $actualHash; installationExecuted = $false } | ConvertTo-Json
    exit 0
}

$installDirectory = 'C:\DetachymAcceptance'
if (Test-Path -LiteralPath $installDirectory) { throw 'Installation directory already exists; start a fresh Sandbox.' }
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
$checks = [Collections.Generic.List[object]]::new()
$report = [ordered]@{
    status = 'running'; version = $manifest.version; installerSha256 = $actualHash
    environment = 'Windows Sandbox'; checks = $checks
    publicBackendVerified = $false; sleepWakeVerified = $false; crossDayVerified = $false
}

function Invoke-InstallerProcess([string]$Executable, [string[]]$Arguments) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(120000)) {
        & taskkill.exe /PID $process.Id /T /F | Out-Null
        throw "Installer process timed out: $Executable"
    }
    if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode)" }
}

function Test-InstalledFiles {
    $executable = Join-Path $installDirectory 'Detachym.exe'
    $asar = Join-Path $installDirectory 'resources\app.asar'
    if (-not (Test-Path -LiteralPath $executable)) { throw 'Installed executable missing.' }
    if ((Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.packagedAsarSha256) {
        throw 'Installed app.asar does not match the verified candidate.'
    }
    $desktopShortcuts = @(Get-DetachymShortcuts @('Desktop', 'CommonDesktopDirectory'))
    $startMenuShortcuts = @(Get-DetachymShortcuts @('Programs', 'CommonPrograms'))
    if ($desktopShortcuts.Count -eq 0 -or $startMenuShortcuts.Count -eq 0) {
        throw 'Desktop or Start Menu shortcut missing.'
    }
    return $executable
}

function Get-DetachymShortcuts([string[]]$Folders) {
    foreach ($folder in $Folders) {
        $directory = [Environment]::GetFolderPath($folder)
        if ($directory -and (Test-Path -LiteralPath $directory)) {
            Get-ChildItem -LiteralPath $directory -Filter 'Detachym.lnk' -Recurse
        }
    }
}

try {
    Invoke-InstallerProcess $installer @('/S', "/D=$installDirectory")
    $executable = Test-InstalledFiles
    $checks.Add(@{ name = 'clean-install-files-and-shortcuts'; status = 'passed' })

    $appProcess = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden
    try {
        Start-Sleep -Seconds 5
        if ($appProcess.HasExited) { throw 'Installed application exited during startup.' }
        $checks.Add(@{ name = 'installed-process-startup'; status = 'passed'; uiVerified = $false })
    } finally {
        if (-not $appProcess.HasExited) { & taskkill.exe /PID $appProcess.Id /T /F | Out-Null }
    }

    $uninstaller = Join-Path $installDirectory 'Uninstall Detachym.exe'
    if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'NSIS uninstaller missing.' }
    Invoke-InstallerProcess $uninstaller @('/S')
    # NSIS may hand off to a temporary uninstaller process.
    $deadline = (Get-Date).AddSeconds(30)
    while ((Test-Path -LiteralPath $executable) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (Test-Path -LiteralPath $executable) { throw 'Uninstaller left the application executable behind.' }
    if (@(Get-DetachymShortcuts @('Desktop', 'CommonDesktopDirectory', 'Programs', 'CommonPrograms')).Count -ne 0) {
        throw 'Uninstaller left a desktop or Start Menu shortcut behind.'
    }
    $checks.Add(@{ name = 'uninstall'; status = 'passed' })

    Invoke-InstallerProcess $installer @('/S', "/D=$installDirectory")
    $null = Test-InstalledFiles
    $checks.Add(@{ name = 'reinstall-files-and-shortcuts'; status = 'passed' })
    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
} finally {
    $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ReportDirectory 'installation-result.json') -Encoding UTF8
}
if ($report.status -ne 'passed') { exit 1 }
