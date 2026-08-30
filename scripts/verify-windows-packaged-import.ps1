param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [Parameter(Mandatory = $true)]
  [string]$Fixture,
  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string]$Architecture
)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$fixturePath = (Resolve-Path -LiteralPath $Fixture).Path
$installedExecutable = $null
$uninstaller = $null
$profile = Join-Path ([System.IO.Path]::GetTempPath()) "overlook-release-import-smoke-$([Guid]::NewGuid().ToString('N'))"
$resultPath = Join-Path $profile 'release-import-result.txt'

function Invoke-CheckedProcess {
  param([string]$Path, [string[]]$Arguments)
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "$Path exited with code $($process.ExitCode)." }
}

function Find-InstalledFile {
  param([string]$Name)
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    $found = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs') -Filter $Name -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $found) { return $found.FullName }
    Start-Sleep -Milliseconds 500
  }
  throw "Installed file $Name was not found."
}

try {
  $actualArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString().ToLowerInvariant()
  if ($actualArchitecture -ne $Architecture) {
    throw "Native runner architecture is $actualArchitecture; expected $Architecture."
  }
  New-Item -ItemType Directory -Path $profile | Out-Null
  Invoke-CheckedProcess $installerPath @('/S')
  $installedExecutable = Find-InstalledFile 'Overlook.exe'
  $uninstaller = Find-InstalledFile 'Uninstall Overlook.exe'

  Write-Host "Launching installed executable: $installedExecutable"
  $smokeEnvironment = @{
    OVERLOOK_RELEASE_IMPORT_SMOKE_SOURCE = $fixturePath
    OVERLOOK_RELEASE_IMPORT_SMOKE_PROFILE = $profile
    OVERLOOK_RELEASE_IMPORT_SMOKE_RESULT = $resultPath
  }
  $previousEnvironment = @{}
  foreach ($entry in $smokeEnvironment.GetEnumerator()) {
    $previousEnvironment[$entry.Key] = [Environment]::GetEnvironmentVariable($entry.Key, 'Process')
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
  try {
    $process = Start-Process -FilePath $installedExecutable -ArgumentList '--overlook-release-import-smoke' -PassThru
  } finally {
    foreach ($entry in $previousEnvironment.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
  }
  $launchedCommandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue).CommandLine
  if ($null -ne $launchedCommandLine) { Write-Host "Installed process command line: $launchedCommandLine" }
  $timedOut = -not $process.WaitForExit(120000)
  if ($timedOut) {
    $process.Kill($true)
    $process.WaitForExit()
  }
  $output = if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath -Raw } else { '' }
  if ($timedOut) {
    throw "Installed Overlook import smoke exceeded 120 seconds.`n$output"
  }
  if ($process.ExitCode -ne 0 -or $output -notmatch 'overlook-release-import-smoke:ready') {
    throw "Installed import smoke failed with exit $($process.ExitCode).`n$output"
  }
  Write-Host "Windows $Architecture installed import smoke passed."
} finally {
  if ($null -ne $uninstaller -and (Test-Path -LiteralPath $uninstaller)) {
    Invoke-CheckedProcess $uninstaller @('/S')
  }
  if (Test-Path -LiteralPath $profile) {
    Remove-Item -LiteralPath $profile -Recurse -Force
  }
}
