# Installs the Memoar CLI on Windows from a GitHub Release.
#
#   irm https://github.com/almyty-inc/memoar/releases/latest/download/install.ps1 | iex
#
# It picks the x64 or ARM64 binary, downloads it with its .sha256 sidecar,
# refuses it when the digest does not match, moves it into place, and adds the
# install directory to the user's PATH.
#
# Settings come from the environment, because `irm | iex` cannot pass
# parameters:
#
#   MEMOAR_VERSION          a release such as 0.4.0 (default: the latest release)
#   MEMOAR_INSTALL_DIR      default: %LOCALAPPDATA%\Programs\Memoar\bin
#   MEMOAR_DOWNLOAD_BASE    a mirror laid out as <base>/v<version>/<asset>,
#                           which needs MEMOAR_VERSION
#   MEMOAR_NO_MODIFY_PATH=1 leave PATH alone
#   MEMOAR_ARCH             x64 or arm64, to override detection
#   MEMOAR_PRINT_ASSET=1, MEMOAR_PRINT_URL=1   print the choice and exit
#
# Errors are thrown rather than passed to `exit`, which would close the shell
# that ran `iex`.

function Install-Memoar {
  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version 2.0

  $releases = 'https://github.com/almyty-inc/memoar/releases'
  $version = "$env:MEMOAR_VERSION".TrimStart('v')
  $base = "$env:MEMOAR_DOWNLOAD_BASE".TrimEnd('/')

  $arch = "$env:MEMOAR_ARCH"
  if (-not $arch) {
    try {
      $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    } catch {
      # Windows PowerShell on an old .NET Framework. A 32-bit shell on a
      # 64-bit system reports its own architecture in PROCESSOR_ARCHITECTURE
      # and the system's in PROCESSOR_ARCHITEW6432.
      $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    }
  }
  switch -Regex ($arch) {
    '^(?i)(arm64|aarch64)$' { $target = 'aarch64-pc-windows-msvc' }
    '^(?i)(x64|amd64|x86_64)$' { $target = 'x86_64-pc-windows-msvc' }
    default { throw "memoar: unsupported architecture: $arch" }
  }
  $asset = "memoar-$target.exe"
  if ($env:MEMOAR_PRINT_ASSET -eq '1') { Write-Output $asset; return }

  if ($base) {
    if (-not $version) { throw 'memoar: MEMOAR_DOWNLOAD_BASE needs MEMOAR_VERSION, because a mirror has no latest' }
    $url = "$base/v$version/$asset"
  } elseif ($version) {
    $url = "$releases/download/v$version/$asset"
  } else {
    $url = "$releases/latest/download/$asset"
  }
  if ($env:MEMOAR_PRINT_URL -eq '1') { Write-Output $url; return }

  $installDir = "$env:MEMOAR_INSTALL_DIR"
  if (-not $installDir) {
    if (-not $env:LOCALAPPDATA) { throw 'memoar: set MEMOAR_INSTALL_DIR, there is no LOCALAPPDATA' }
    $installDir = Join-Path $env:LOCALAPPDATA 'Programs\Memoar\bin'
  }

  # Windows PowerShell 5.1 still defaults to TLS 1.0, which GitHub refuses.
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  }

  $scratch = Join-Path ([IO.Path]::GetTempPath()) ("memoar-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $scratch | Out-Null
  try {
    $binary = Join-Path $scratch $asset
    $sidecar = "$binary.sha256"
    Write-Host "memoar: downloading $url"
    $previous = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $binary
      Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile $sidecar
    } finally {
      $ProgressPreference = $previous
    }

    $first = (Get-Content -Path $sidecar -TotalCount 1)
    if ("$first" -notmatch '^([0-9a-fA-F]{64})(\s|$)') { throw 'memoar: checksum file did not contain SHA-256' }
    $expected = $Matches[1].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $binary).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "memoar: binary checksum mismatch: expected $expected, got $actual" }

    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $destination = Join-Path $installDir 'memoar.exe'
    $staged = Join-Path $installDir ".memoar-install-$PID.exe"
    Copy-Item -Path $binary -Destination $staged -Force
    try {
      Move-Item -Path $staged -Destination $destination -Force
    } catch {
      Remove-Item -Force -ErrorAction SilentlyContinue $staged
      throw "memoar: could not replace $destination, is memoar still running? $($_.Exception.Message)"
    }
  } finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $scratch
  }

  $reported = $null
  try { $reported = (& $destination --version 2>$null | Select-Object -First 1) } catch { $reported = $null }
  if (-not $reported) { $reported = if ($version) { "Memoar $version" } else { 'Memoar (latest)' } }
  Write-Host "Installed $reported at $destination"

  $separator = [IO.Path]::PathSeparator
  $onPath = ("$env:Path" -split [regex]::Escape($separator)) -contains $installDir
  if ($onPath) { return }
  if ($env:MEMOAR_NO_MODIFY_PATH -eq '1' -or -not $IsWindowsHost) {
    Write-Host "memoar: $installDir is not on your PATH. Add it to run memoar by name."
    return
  }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = if ($userPath) { $userPath -split ';' } else { @() }
  if ($entries -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable('Path', (($entries + $installDir) -join ';').Trim(';'), 'User')
    Write-Host "memoar: added $installDir to your user PATH. Open a new terminal to use it."
  }
  $env:Path = "$env:Path;$installDir"
}

$IsWindowsHost = [System.Environment]::OSVersion.Platform -eq 'Win32NT'
Install-Memoar
