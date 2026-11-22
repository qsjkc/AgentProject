param(
    [Parameter(Mandatory)][string]$BaselineDirectory,
    [Parameter(Mandatory)][string]$BaselineSourceCommit,
    [Parameter(Mandatory)][string]$CandidateDirectory,
    [Parameter(Mandatory)][string]$CandidateSourceCommit,
    [Parameter(Mandatory)][string]$ReportDirectory
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'X64' -or
    $env:GITHUB_REF -ne 'refs/heads/main' -or $env:GITHUB_EVENT_NAME -ne 'workflow_dispatch' -or
    $env:GITHUB_WORKFLOW -ne 'Windows Upgrade Acceptance') {
    throw 'The upgrade test requires a fresh GitHub-hosted Windows runner.'
}

. (Join-Path $PSScriptRoot 'windows-installer-common.ps1')
$projectDirectory = Join-Path $PSScriptRoot '../..'
$installDirectory = Join-Path $env:RUNNER_TEMP 'DetachymUpgradeInstall'
$executable = Join-Path $installDirectory 'Detachym.exe'
$launcher = Join-Path $PSScriptRoot 'clean-windows-installer-launch.mjs'
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
$checks = [Collections.Generic.List[object]]::new()
$report = [ordered]@{
    status = 'running'
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    operatingSystem = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber)
    checks = $checks
}

function Read-InstallerArtifact([string]$Directory, [string]$SourceCommit, [string]$Phase) {
    $packagePath = Join-Path $env:RUNNER_TEMP "detachym-$Phase-package.json"
    $source = git -C $projectDirectory show "${SourceCommit}:desktop/package.json"
    if ($LASTEXITCODE -ne 0) { throw "$Phase source package could not be read" }
    $source | Set-Content -LiteralPath $packagePath -Encoding UTF8
    $verified = python (Join-Path $projectDirectory 'deploy/verify_desktop_artifact.py') `
        --directory $Directory --package $packagePath --source-commit $SourceCommit `
        --manifest (Join-Path $Directory 'desktop-release.json') --verify
    if ($LASTEXITCODE -ne 0) { throw "$Phase installer provenance failed ($verified)" }
    return $verified | ConvertFrom-Json
}

function Invoke-UpgradeLaunch([string]$Phase, [string]$Version, [string]$Mode, [string]$Language) {
    $path = Join-Path $ReportDirectory "$Phase-launch.json"
    $arguments = @($executable, $env:APPDATA, $Version, $path, $Mode)
    if ($Language) { $arguments += $Language }
    & node $launcher @arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Phase launch check failed" }
    $launch = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
    if ($launch.status -ne 'passed' -or $launch.actualVersion -ne $Version -or -not $launch.cleanLoginPrompt -or
        $launch.language -notin @('en', 'zh-CN') -or -not $launch.profilePath) {
        throw "$Phase launch did not verify the default profile and signed-out state"
    }
    if (Get-Process -Name Detachym -ErrorAction SilentlyContinue) { throw "$Phase left Detachym running" }
    $checks.Add([ordered]@{ name = "$Phase-installed-renderers"; status = 'passed'; launch = $launch })
    return $launch
}

try {
    if ($BaselineSourceCommit -cnotmatch '^[a-f0-9]{40}$' -or $CandidateSourceCommit -cnotmatch '^[a-f0-9]{40}$' -or
        $BaselineSourceCommit -ceq $CandidateSourceCommit) { throw 'Two distinct source commits are required' }
    git -C $projectDirectory merge-base --is-ancestor $BaselineSourceCommit $CandidateSourceCommit
    if ($LASTEXITCODE -ne 0) { throw 'The baseline must be an ancestor of the candidate' }
    $baseline = Read-InstallerArtifact $BaselineDirectory $BaselineSourceCommit 'baseline'
    $candidate = Read-InstallerArtifact $CandidateDirectory $CandidateSourceCommit 'candidate'
    if ($baseline.version -eq $candidate.version) { throw 'The upgrade must change the desktop version' }
    $report.baseline = $baseline
    $report.candidate = $candidate
    $checks.Add([ordered]@{ name = 'both-installer-artifacts-verified'; status = 'passed' })

    foreach ($path in @($installDirectory, (Join-Path $env:APPDATA 'Detachym'),
        (Join-Path $env:APPDATA 'detachym-desktop'), (Join-Path $env:LOCALAPPDATA 'Programs/Detachym'),
        (Join-Path $env:ProgramFiles 'Detachym'))) {
        if (Test-Path -LiteralPath $path) { throw "Upgrade VM already contains $path" }
    }
    if ((Get-Process -Name Detachym -ErrorAction SilentlyContinue) -or @(Find-DetachymRegistration).Count -ne 0 -or
        @(Find-DetachymShortcuts @('Desktop','CommonDesktopDirectory','Programs','CommonPrograms')).Count -ne 0) {
        throw 'Upgrade VM already has Detachym processes, registrations, or shortcuts'
    }
    $checks.Add([ordered]@{ name = 'clean-windows-baseline'; status = 'passed' })

    Invoke-InstallerProcess (Join-Path $BaselineDirectory $baseline.filename) @('/S', "/D=$installDirectory")
    $first = Get-FilesAndRegistration 'baseline' $installDirectory $baseline.version
    $checks.Add($first)
    $before = Invoke-UpgradeLaunch 'baseline' $baseline.version 'set-language'

    # Let NSIS locate the registered installation and perform the in-place update.
    Invoke-InstallerProcess (Join-Path $CandidateDirectory $candidate.filename) @('/S')
    $second = Get-FilesAndRegistration 'candidate' $installDirectory $candidate.version
    if (@(Find-DetachymRegistration).Count -ne 1 -or $second.desktopShortcuts -ne $first.desktopShortcuts -or
        $second.startMenuShortcuts -ne $first.startMenuShortcuts) { throw 'Upgrade duplicated a registration or shortcut' }
    $checks.Add($second)
    $after = Invoke-UpgradeLaunch 'candidate' $candidate.version 'preserve-language' $before.language
    if ($after.profilePath -ne $before.profilePath -or $after.language -ne $before.language) {
        throw 'The in-place update did not preserve the default profile language'
    }
    $checks.Add([ordered]@{ name = 'language-preserved-in-default-profile'; status = 'passed'; language = $after.language })
    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
} finally {
    $report.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    $json = $report | ConvertTo-Json -Depth 10
    $json | Set-Content -LiteralPath (Join-Path $ReportDirectory 'windows-upgrade.json') -Encoding UTF8
    Write-Output $json
}
if ($report.status -ne 'passed') { exit 1 }
