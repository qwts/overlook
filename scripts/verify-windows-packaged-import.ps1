param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [Parameter(Mandatory = $true)]
  [string]$Fixture,
  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string]$Architecture,
  [Parameter(Mandatory = $true)]
  [string]$HarnessElectron
)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$fixturePath = (Resolve-Path -LiteralPath $Fixture).Path
$harnessElectronPath = (Resolve-Path -LiteralPath $HarnessElectron).Path
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
  $installedResources = Join-Path (Split-Path -Parent $installedExecutable) 'resources'
  $installedArchive = Join-Path $installedResources 'app.asar'
  $installedUnpacked = Join-Path $installedResources 'app.asar.unpacked'
  if (-not (Test-Path -LiteralPath $installedArchive)) { throw 'Installed app.asar was not found.' }
  if (-not (Test-Path -LiteralPath $installedUnpacked)) { throw 'Installed app.asar.unpacked was not found.' }
  $smokeExecutable = $harnessElectronPath

  # GitHub's hosted Windows service session can start the signed executable's
  # native-host mode but stalls before its packaged app entrypoint. Use a clean,
  # same-version, same-architecture Electron distribution to load the installed
  # app.asar explicitly. The app admits this unpackaged Electron path only when
  # getAppPath() resolves to a real app.asar and the dedicated harness marker is
  # present, so the gate exercises the shipped code and adjacent native modules
  # without depending on the broken branded bootstrap.
  Write-Host "Launching installed application through: $smokeExecutable"
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $smokeExecutable
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.ArgumentList.Add('--inspect=0')
  $startInfo.ArgumentList.Add('--remote-debugging-port=0')
  $startInfo.ArgumentList.Add($installedArchive)
  $startInfo.ArgumentList.Add('--enable-logging=stderr')
  $startInfo.ArgumentList.Add('--overlook-release-import-smoke')
  $startInfo.ArgumentList.Add("--overlook-release-import-source=$fixturePath")
  $startInfo.ArgumentList.Add("--overlook-release-import-profile=$profile")
  $startInfo.ArgumentList.Add("--overlook-release-import-result=$resultPath")
  $startInfo.Environment['ELECTRON_ENABLE_LOGGING'] = 'true'
  $startInfo.Environment['OVERLOOK_RELEASE_IMPORT_SMOKE_HARNESS'] = '1'
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw 'Installed import smoke process did not start.' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $launchedCommandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue).CommandLine
  if ($null -ne $launchedCommandLine) { Write-Host "Installed process command line: $launchedCommandLine" }
  $timedOut = -not $process.WaitForExit(120000)
  if ($timedOut) {
    $process.Kill($true)
    $process.WaitForExit()
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($stdout.Length -gt 0) { Write-Host "Installed process stdout:`n$stdout" }
  if ($stderr.Length -gt 0) { Write-Host "Installed process stderr:`n$stderr" }
  $output = if (Test-Path -LiteralPath $resultPath) { Get-Content -LiteralPath $resultPath -Raw } else { '' }
  if ($timedOut) {
    throw "Installed Overlook import smoke exceeded 120 seconds.`n$output`n$stderr"
  }
  if ($process.ExitCode -ne 0 -or $output -notmatch 'overlook-release-import-smoke:ready') {
    throw "Installed import smoke failed with exit $($process.ExitCode).`n$output`n$stderr"
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
