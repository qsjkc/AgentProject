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

function Get-FilesAndRegistration([string]$Phase, [string]$InstallDirectory, [string]$Version) {
    $exe = Join-Path $InstallDirectory 'Detachym.exe'
    $asar = Join-Path $InstallDirectory 'resources/app.asar'
    $uninstaller = Join-Path $InstallDirectory 'Uninstall Detachym.exe'
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
    if ($registration.Count -ne 1 -or $registration[0].DisplayVersion -ne $Version) {
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
