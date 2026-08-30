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

  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $installedExecutable
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in @(
    '--overlook-release-import-smoke',
    "--overlook-release-import-source=$fixturePath",
    "--overlook-release-import-profile=$profile",
    "--user-data-dir=$profile"
  )) {
    [void]$start.ArgumentList.Add($argument)
  }
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Installed Overlook process did not start.' }
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(120000)) {
    $process.Kill($true)
    throw 'Installed Overlook import smoke exceeded 120 seconds.'
  }
  $output = $stdout.GetAwaiter().GetResult()
  $errorOutput = $stderr.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0 -or $output -notmatch 'overlook-release-import-smoke:ready') {
    throw "Installed import smoke failed with exit $($process.ExitCode).`n$output$errorOutput"
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
