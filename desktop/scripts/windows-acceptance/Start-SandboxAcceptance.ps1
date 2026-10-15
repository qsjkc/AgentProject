param([switch]$GenerateOnly)
$ErrorActionPreference = 'Stop'
$null = & (Join-Path $PSScriptRoot 'Run-InstallAcceptance.ps1') -PackageDirectory $PSScriptRoot -ValidateOnly
if ($LASTEXITCODE -ne 0) { throw 'Candidate input validation failed.' }
$results = Join-Path $PSScriptRoot 'results'
New-Item -ItemType Directory -Path $results -Force | Out-Null
$packageXml = [Security.SecurityElement]::Escape($PSScriptRoot)
$resultsXml = [Security.SecurityElement]::Escape($results)
$configuration = @"
<Configuration>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>$packageXml</HostFolder>
      <SandboxFolder>C:\Candidate</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>$resultsXml</HostFolder>
      <SandboxFolder>C:\AcceptanceResults</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Candidate\Run-InstallAcceptance.ps1 -PackageDirectory C:\Candidate -ReportDirectory C:\AcceptanceResults</Command>
  </LogonCommand>
</Configuration>
"@
$configurationPath = Join-Path $PSScriptRoot 'RC2-installation.wsb'
$configuration | Set-Content -LiteralPath $configurationPath -Encoding UTF8
if ($GenerateOnly) {
    Write-Output "Configuration generated only: $configurationPath"
    exit 0
}
$sandbox = Get-Command WindowsSandbox.exe -ErrorAction Stop
Start-Process -FilePath $sandbox.Source -ArgumentList ('"' + $configurationPath + '"')
Write-Output "Read the actual result from $results\installation-result.json after Sandbox finishes."
