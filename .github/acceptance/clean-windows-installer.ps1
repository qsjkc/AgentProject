param(
    [Parameter(Mandatory)][string]$PackageDirectory,
    [Parameter(Mandatory)][string]$ReportDirectory,
    [Parameter(Mandatory)][string]$SourceCommit
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'X64' -or
    $env:GITHUB_REF -ne 'refs/heads/main' -or
    $env:GITHUB_EVENT_NAME -notin @('workflow_run', 'workflow_dispatch')) {
    throw 'This script requires the main CD job on a fresh GitHub-hosted Windows runner.'
}
$projectDirectory = Join-Path $PSScriptRoot '../..'
$installDirectory = Join-Path $env:RUNNER_TEMP 'DetachymCleanInstall'
$exe = Join-Path $installDirectory 'Detachym.exe'
$asar = Join-Path $installDirectory 'resources/app.asar'
$uninstaller = Join-Path $installDirectory 'Uninstall Detachym.exe'
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
$checks = [Collections.Generic.List[object]]::new()
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$report = [ordered]@{
    status = 'running'
    startedAt = $startedAt
    environment = 'GitHub-hosted fresh Windows VM'
    image = $env:ImageOS
    imageVersion = $env:ImageVersion
    operatingSystem = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber)
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    sourceCommit = $SourceCommit
    installMode = 'NSIS silent'
    checks = $checks
}
. (Join-Path $PSScriptRoot 'windows-installer-common.ps1')

function Invoke-RendererCheck([string]$Phase) {
    $profile = Join-Path $env:RUNNER_TEMP "detachym-release-$Phase-profile"
    $launchReport = Join-Path $ReportDirectory "$Phase-launch.json"
    if (Test-Path -LiteralPath $profile) { throw "$Phase test profile already exists" }
    node (Join-Path $PSScriptRoot 'clean-windows-installer-launch.mjs') $exe $profile $version $launchReport
    if ($LASTEXITCODE -ne 0) { throw "$Phase installed renderer check failed" }
    $launch = Get-Content -Raw -LiteralPath $launchReport | ConvertFrom-Json
    if ($launch.status -ne 'passed') { throw "$Phase installed renderer produced no pass" }
    $checks.Add([ordered]@{ name = "$Phase-installed-renderers"; status = 'passed'; launch = $launch })
}
try {
    $checkedOutCommit = git -C $projectDirectory rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $checkedOutCommit -cne $SourceCommit) {
        throw 'Acceptance checkout does not match the verified CD source commit'
    }
    $verifiedInstaller = python (Join-Path $projectDirectory 'deploy/verify_desktop_artifact.py') `
        --directory $PackageDirectory --package (Join-Path $projectDirectory 'desktop/package.json') `
        --source-commit $SourceCommit --manifest (Join-Path $PackageDirectory 'desktop-release.json') --verify
    if ($LASTEXITCODE -ne 0) { throw "Installer artifact provenance check failed ($verifiedInstaller)" }
    $manifest = $verifiedInstaller | ConvertFrom-Json
    $version = $manifest.version
    $installer = Join-Path $PackageDirectory $manifest.filename
    $report.version = $version
    $report.installer = $manifest.filename
    $report.installerBytes = $manifest.bytes
    $report.installerSha256 = $manifest.sha256
    $checks.Add([ordered]@{ name = 'installer-artifact-provenance'; status = 'passed' })
    foreach ($path in @(
        $installDirectory,
        (Join-Path $env:LOCALAPPDATA 'Programs/Detachym'),
        (Join-Path $env:ProgramFiles 'Detachym'),
        (Join-Path $env:APPDATA 'Detachym'),
        (Join-Path $env:APPDATA 'detachym-desktop')
    )) {
        if (Test-Path -LiteralPath $path) { throw "Windows baseline already contains $path" }
    }
    if ((Get-Process -Name Detachym -ErrorAction SilentlyContinue) -or
        @(Find-DetachymRegistration).Count -ne 0 -or
        @(Find-DetachymShortcuts @('Desktop','CommonDesktopDirectory','Programs','CommonPrograms')).Count -ne 0) {
        throw 'Windows baseline already has Detachym processes, registrations, or shortcuts'
    }
    $checks.Add([ordered]@{ name = 'clean-windows-baseline'; status = 'passed' })

    Invoke-InstallerProcess 'install' $installer @('/S', "/D=$installDirectory")
    $first = Get-FilesAndRegistration 'install' $installDirectory $version
    $checks.Add($first)
    Invoke-RendererCheck 'install'
    Invoke-InstallerProcess 'uninstall' $uninstaller @('/S')
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $executableRemoved = -not (Test-Path -LiteralPath $exe)
        $asarRemoved = -not (Test-Path -LiteralPath $asar)
        $uninstallerRemoved = -not (Test-Path -LiteralPath $uninstaller)
        $shortcutsRemoved = @(Find-DetachymShortcuts @('Desktop','CommonDesktopDirectory','Programs','CommonPrograms')).Count -eq 0
        $registrationRemoved = @(Find-DetachymRegistration).Count -eq 0
        if ($executableRemoved -and $asarRemoved -and $uninstallerRemoved -and $shortcutsRemoved -and $registrationRemoved) { break }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    if (-not ($executableRemoved -and $asarRemoved -and $uninstallerRemoved -and $shortcutsRemoved -and $registrationRemoved)) {
        throw "NSIS uninstall left executable=$(-not $executableRemoved), asar=$(-not $asarRemoved), uninstaller=$(-not $uninstallerRemoved), shortcuts=$(-not $shortcutsRemoved), registration=$(-not $registrationRemoved)"
    }
    $checks.Add([ordered]@{
        name = 'uninstall-files-shortcuts-registration'; status = 'passed'
        executableRemoved = $executableRemoved; asarRemoved = $asarRemoved; uninstallerRemoved = $uninstallerRemoved
        shortcutsRemoved = $shortcutsRemoved; registrationRemoved = $registrationRemoved
    })

    Invoke-InstallerProcess 'reinstall' $installer @('/S', "/D=$installDirectory")
    $second = Get-FilesAndRegistration 'reinstall' $installDirectory $version
    if ($first.asarSha256 -ne $second.asarSha256 -or $first.applicationSha256 -ne $second.applicationSha256) {
        throw 'Reinstalled application payload differs from initial install'
    }
    $checks.Add($second)
    Invoke-RendererCheck 'reinstall'
    $report.status = 'passed'
}
catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
    if ($_.Exception.Data.Contains('installerFailure')) {
        $report.installerFailure = $_.Exception.Data['installerFailure']
    }
}
finally {
    $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $json = $report | ConvertTo-Json -Depth 12
    $json | Set-Content -LiteralPath (Join-Path $ReportDirectory 'windows-installation.json') -Encoding UTF8
    Write-Output $json
}
if ($report.status -ne 'passed') { exit 1 }
