param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [switch]$RequireSignature
)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$registryKeys = @(
  'Software\Google\Chrome\NativeMessagingHosts\com.qwts.overlook.interop',
  'Software\Chromium\NativeMessagingHosts\com.qwts.overlook.interop',
  'Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.qwts.overlook.interop',
  'Software\Microsoft\Edge\NativeMessagingHosts\com.qwts.overlook.interop'
)
$installedExecutable = $null
$uninstaller = $null

function Invoke-CheckedProcess {
  param([string]$Path, [string[]]$Arguments)
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "$Path exited with code $($process.ExitCode)."
  }
}

function Get-NativeHostValues {
  $values = @()
  foreach ($keyPath in $registryKeys) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)
    try {
      $values += if ($null -eq $key) { $null } else { $key.GetValue('', $null) }
    } finally {
      if ($null -ne $key) { $key.Dispose() }
    }
  }
  return $values
}

function Assert-NoNativeHostValues {
  foreach ($value in Get-NativeHostValues) {
    if ($null -ne $value) { throw "Native-host registry cleanup left $value behind." }
  }
}

function Assert-ValidSignature {
  param([string]$Path)
  if (-not $RequireSignature) { return }
  $signature = Get-AuthenticodeSignature -FilePath $Path
  if ($signature.Status -ne 'Valid') {
    throw "$Path has Authenticode status $($signature.Status): $($signature.StatusMessage)"
  }
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
  Assert-ValidSignature $installerPath

  # First install and in-place reinstall exercise the same stable NSIS identity
  # used by upgrades. The second pass must retain one canonical executable.
  Invoke-CheckedProcess $installerPath @('/S')
  $installedExecutable = Find-InstalledFile 'Overlook.exe'
  Assert-ValidSignature $installedExecutable
  Invoke-CheckedProcess $installerPath @('/S')
  $upgradedExecutable = Find-InstalledFile 'Overlook.exe'
  if ($upgradedExecutable -ne $installedExecutable) {
    throw 'The in-place upgrade changed the installed executable identity.'
  }

  Invoke-CheckedProcess $installedExecutable @('--register-native-host')
  $values = @(Get-NativeHostValues)
  if ($values.Count -ne 4 -or $values.Where({ $null -eq $_ }).Count -ne 0) {
    throw 'Native-host registration did not populate all four current-user browser keys.'
  }
  $manifestPath = [string]$values[0]
  foreach ($value in $values) {
    if ([string]$value -ne $manifestPath) { throw 'Browser registry values disagree on the owned manifest.' }
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ([System.IO.Path]::GetFullPath([string]$manifest.path) -ne [System.IO.Path]::GetFullPath($installedExecutable)) {
    throw 'The native-host manifest does not point to the installed signed executable.'
  }
  if ($manifest.allowed_origins.Count -ne 1 -or [string]$manifest.allowed_origins[0] -notmatch '^chrome-extension://[a-p]{32}/$') {
    throw 'The native-host manifest does not contain the exact released extension origin.'
  }

  # Disable removes only this exact registration and its versioned manifest.
  Invoke-CheckedProcess $installedExecutable @('--unregister-native-host')
  Assert-NoNativeHostValues
  if (Test-Path -LiteralPath $manifestPath) { throw 'Disable left the owned native-host manifest behind.' }

  # Re-register, then prove the NSIS uninstall hook runs cleanup before deleting
  # the executable that owns it.
  Invoke-CheckedProcess $installedExecutable @('--register-native-host')
  $manifestPath = [string](@(Get-NativeHostValues)[0])
  $uninstaller = Find-InstalledFile 'Uninstall Overlook.exe'
  Invoke-CheckedProcess $uninstaller @('/S')
  Assert-NoNativeHostValues
  if (Test-Path -LiteralPath $manifestPath) { throw 'Uninstall left the owned native-host manifest behind.' }
  if (Test-Path -LiteralPath $installedExecutable) { throw 'Uninstall left the application executable behind.' }
} finally {
  if ($null -ne $installedExecutable -and (Test-Path -LiteralPath $installedExecutable)) {
    Invoke-CheckedProcess $installedExecutable @('--unregister-native-host')
  }
  if ($null -ne $uninstaller -and (Test-Path -LiteralPath $uninstaller)) {
    Invoke-CheckedProcess $uninstaller @('/S')
  }
}

Write-Host 'Windows live-local install, upgrade, disable, and uninstall smoke passed.'
