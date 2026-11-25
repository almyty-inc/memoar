# Installs, inspects and removes a real Scheduled Task for a scratch
# configuration under a unique name. The Windows half of service-smoke.sh.
#
#   pwsh agent/scripts/service-smoke.ps1 -Memoar C:\path\to\memoar.exe
#
# It never touches the default configuration: every command names scratch
# directories, and the task is \Memoar\smoke-<pid>.
param([Parameter(Mandatory = $true)][string]$Memoar)
$ErrorActionPreference = 'Stop'

$root = Join-Path ([IO.Path]::GetTempPath()) "memoar-service-smoke-$PID"
$name = "smoke-$PID"
$dirs = @('--config-dir', "$root\config", '--data-dir', "$root\data", '--capture-home', "$root\home")

function M([string[]]$arguments) {
  $output = & $Memoar --json @arguments @dirs
  return ($output | Out-String | ConvertFrom-Json)
}

function Status { return (M @('service', 'status', '--name', $name)).data }

function Fail([string]$why) {
  Write-Host "service-smoke: FAIL: $why"
  Write-Host '--- service status'
  & $Memoar --json service status --name $name @dirs
  Write-Host '--- agent.log'
  Get-Content -ErrorAction SilentlyContinue "$root\data\logs\agent.log"
  exit 1
}

function ChildPid {
  $state = Get-Content -Raw "$root\data\service-state.json" | ConvertFrom-Json
  return $state.childPid
}

function WaitFor([int]$seconds, [scriptblock]$condition) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $condition) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

try {
  New-Item -ItemType Directory -Force -Path "$root\config", "$root\home" | Out-Null
  # A configuration pointed at an address nothing listens on. Not a secret.
  Set-Content -Path "$root\config\config.json" -Encoding ascii -Value '{"contractVersion":"0.3.0","endpoint":"http://127.0.0.1:9/v1","machineId":"00000000-0000-7000-8000-000000000001","installationId":"","disabledSources":[]}'
  Set-Content -Path "$root\config\credentials.json" -Encoding ascii -Value '{"accessToken":"service-smoke-placeholder"}'

  Write-Host "service-smoke: installing $name"
  $installed = M @('service', 'install', '--name', $name)
  $installed | ConvertTo-Json -Depth 6 | Write-Host
  if (-not $installed.ok -or -not $installed.data.installed) { Fail 'install did not report installed' }
  & schtasks /Query /TN "\Memoar\$name" | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'no scheduled task' }
  $action = (Get-ScheduledTask -TaskPath '\Memoar\' -TaskName $name).Actions[0]
  if ($action.Execute -notlike '*conhost.exe' -or $action.Arguments -notlike '--headless *') {
    Fail "the task does not run headless: $($action.Execute) $($action.Arguments)"
  }

  if (-not (WaitFor 60 { (Status).running -eq $true })) { Fail 'the service did not start' }
  if (-not (WaitFor 20 { Select-String -Quiet -Path "$root\data\logs\agent.log" -Pattern "service: $name started" })) {
    Fail 'no start line in the log'
  }
  Write-Host 'service-smoke: running'

  $first = ChildPid
  if (-not $first) { Fail 'no watch process recorded' }
  Stop-Process -Id $first -Force
  $script:second = $null
  if (-not (WaitFor 60 { $script:second = ChildPid; $script:second -and $script:second -ne $first })) {
    Fail 'the killed watch was not restarted'
  }
  Write-Host "service-smoke: the watch was restarted after a crash ($first, then $script:second)"

  Remove-Item "$root\config\credentials.json"
  Stop-Process -Id $script:second -Force
  if (-not (WaitFor 90 { (Status).running -eq $false })) { Fail 'the service kept running signed out' }
  $stopped = Status
  $stopped | ConvertTo-Json -Depth 6 | Write-Host
  if ($stopped.backgroundCapture.state -ne 'stopped') { Fail 'backgroundCapture is not stopped' }
  if ($stopped.backgroundCapture.summary -notlike 'background capture stopped: Memoar is not initialized*') {
    Fail 'the reason is not named'
  }

  Start-Sleep -Seconds 75
  if ((Status).running -ne $false) { Fail 'the service was started again' }
  $starts = @(Select-String -Path "$root\data\logs\agent.log" -Pattern "service: $name started").Count
  if ($starts -ne 1) { Fail "the service started $starts times" }
  Write-Host 'service-smoke: stopped and stayed stopped'

  $removed = M @('service', 'uninstall', '--name', $name)
  $removed | ConvertTo-Json -Depth 6 | Write-Host
  if (-not $removed.data.removed) { Fail 'uninstall did not remove it' }
  & schtasks /Query /TN "\Memoar\$name" 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Fail 'the task is still there' }
  if ((Status).installed) { Fail 'still installed after uninstall' }
  $left = Get-CimInstance Win32_Process -Filter "Name = 'memoar.exe'" |
    Where-Object { $_.CommandLine -like "*$root*" }
  if ($left) { Fail "processes outlived the uninstall: $($left.ProcessId -join ', ')" }
  Write-Host 'service-smoke: OK'
} finally {
  & $Memoar service uninstall --name $name @dirs 2>$null | Out-Null
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $root
}
