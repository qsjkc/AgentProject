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
function Find-DetachymShortcuts([string[]]$Folders) {
    foreach ($folder in $Folders) {
        $path = [Environment]::GetFolderPath($folder)
        if ($path -and (Test-Path -LiteralPath $path)) {
            Get-ChildItem -LiteralPath $path -Recurse -Filter 'Detachym.lnk' -File -ErrorAction SilentlyContinue
        }
    }
}
function Find-DetachymRegistration {
    $keys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($key in $keys) {
        Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
            Where-Object DisplayName -Match '^Detachym(?:$|\s)'
    }
}
function Invoke-InstallerProcess([string]$Executable, [string[]]$Arguments) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(120000)) {
        & taskkill.exe /PID $process.Id /T /F | Out-Null
        throw "NSIS timed out ($Executable)"
    }
    if ($process.ExitCode -ne 0) {
        throw "NSIS failed with exit code $($process.ExitCode) ($Executable)"
    }
}
function Get-FilesAndRegistration([string]$Phase) {
    foreach ($path in @($exe, $asar, $uninstaller)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$Phase omitted $path" }
    }
    $desktopShortcuts = @(Find-DetachymShortcuts @('Desktop', 'CommonDesktopDirectory'))
    $programShortcuts = @(Find-DetachymShortcuts @('Programs', 'CommonPrograms'))
    if ($desktopShortcuts.Count -lt 1 -or $programShortcuts.Count -lt 1) {
        throw "$Phase omitted Desktop or Start Menu shortcut"
    }
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($shortcut in ($desktopShortcuts + $programShortcuts)) {
            if ($shell.CreateShortcut($shortcut.FullName).TargetPath -ne $exe) {
                throw "$Phase registered a shortcut targeting another executable"
            }
        }
    }
    finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    $registration = @(Find-DetachymRegistration | Where-Object { $_.UninstallString -like "*$uninstaller*" })
    if ($registration.Count -ne 1 -or $registration[0].DisplayVersion -ne $version) {
        throw "$Phase did not register the expected uninstaller and version"
    }
    return [ordered]@{
        name = "$Phase-files-shortcuts-registration"
        status = 'passed'
        asarSha256 = (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash.ToLowerInvariant()
        applicationSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
        desktopShortcuts = $desktopShortcuts.Count
        startMenuShortcuts = $programShortcuts.Count
        uninstallRegistration = $registration[0].DisplayVersion
    }
}
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

    Invoke-InstallerProcess $installer @('/S', "/D=$installDirectory")
    $first = Get-FilesAndRegistration 'install'
    $checks.Add($first)
    Invoke-RendererCheck 'install'
    Invoke-InstallerProcess $uninstaller @('/S')
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

    Invoke-InstallerProcess $installer @('/S', "/D=$installDirectory")
    $second = Get-FilesAndRegistration 'reinstall'
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
}
finally {
    $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $json = $report | ConvertTo-Json -Depth 12
    $json | Set-Content -LiteralPath (Join-Path $ReportDirectory 'windows-installation.json') -Encoding UTF8
    Write-Output $json
}
if ($report.status -ne 'passed') { exit 1 }
