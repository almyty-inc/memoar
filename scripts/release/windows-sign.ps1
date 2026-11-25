# Authenticode signing for release executables.
#
#   windows-sign.ps1 -StatusFile <path> -Files <exe>[,<exe>...]
#
# A file that already carries a valid signature, for example from the Azure
# Trusted Signing step that runs before this one, is verified and recorded.
# Otherwise the file is signed with WINDOWS_CERT_PFX (base64 of a .pfx) and
# WINDOWS_CERT_PASSWORD through signtool, timestamped by
# WINDOWS_TIMESTAMP_URL (default http://timestamp.digicert.com).
#
# Missing credentials are not an error. The file stays unsigned, the status file
# says so, and the job log carries a warning annotation. Set
# MEMOAR_REQUIRE_SIGNING=true to turn that into a failure. Credentials that are
# present but wrong always fail.
param(
  [Parameter(Mandatory = $true)] [string] $StatusFile,
  [Parameter(Mandatory = $true)] [string[]] $Files
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Status([string] $line) {
  Add-Content -Path $StatusFile -Value $line -Encoding utf8
}

function Find-SignTool {
  $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $host_arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $found = Get-ChildItem -Path $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.Directory.Name -eq $host_arch } |
    Sort-Object { $_.Directory.Parent.Name } -Descending |
    Select-Object -First 1
  if (-not $found) { throw "signtool.exe was not found under $kits" }
  return $found.FullName
}

function Assert-Valid([string] $file) {
  $signature = Get-AuthenticodeSignature -FilePath $file
  if ($signature.Status -ne 'Valid') {
    throw "$file has signature status $($signature.Status): $($signature.StatusMessage)"
  }
  return $signature.SignerCertificate.Subject
}

$pfxPath = $null
try {
  foreach ($file in $Files) {
    $existing = Get-AuthenticodeSignature -FilePath $file
    if ($existing.Status -eq 'Valid') {
      $subject = $existing.SignerCertificate.Subject
      Write-Host "$file is already signed by $subject"
      Write-Status "signature: Authenticode ($subject)"
      continue
    }

    if (-not $env:WINDOWS_CERT_PFX -or -not $env:WINDOWS_CERT_PASSWORD) {
      $reason = 'neither Azure Trusted Signing nor WINDOWS_CERT_PFX and WINDOWS_CERT_PASSWORD is configured'
      Write-Status "signature: none ($reason)"
      if ($env:MEMOAR_REQUIRE_SIGNING -eq 'true') {
        Write-Host "::error title=Windows signing::$file is unsigned: $reason, and MEMOAR_REQUIRE_SIGNING is true"
        exit 1
      }
      Write-Host "::warning title=Windows signing::$file is unsigned: $reason"
      continue
    }

    if (-not $pfxPath) {
      $pfxPath = Join-Path ($env:RUNNER_TEMP ?? [IO.Path]::GetTempPath()) 'memoar-signing.pfx'
      [IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:WINDOWS_CERT_PFX))
    }
    $timestamp = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
    $signtool = Find-SignTool
    & $signtool sign /fd SHA256 /td SHA256 /tr $timestamp /f $pfxPath /p $env:WINDOWS_CERT_PASSWORD /d 'Memoar' $file
    if ($LASTEXITCODE -ne 0) { throw "signtool sign failed for $file with exit code $LASTEXITCODE" }
    & $signtool verify /pa /v $file
    if ($LASTEXITCODE -ne 0) { throw "signtool verify failed for $file with exit code $LASTEXITCODE" }
    $subject = Assert-Valid $file
    Write-Status "signature: Authenticode ($subject)"
  }
}
finally {
  if ($pfxPath -and (Test-Path $pfxPath)) { Remove-Item -Force $pfxPath }
}
