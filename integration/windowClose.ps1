# Opens a real VS Code window with Kill Stack loaded, starts one server inside
# the open folder and one outside, closes the window the way clicking X does,
# and checks which servers survived. Exits 1 if the result is wrong.
param(
  [Parameter(Mandatory = $true)][string]$Code,
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][ValidateSet("on", "off")][string]$KillOnExit,
  [int]$StartupSeconds = 25
)

$ErrorActionPreference = "Stop"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$base = Join-Path $env:TEMP ("ks-windowclose-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$ws = Join-Path $base "ws"
$outside = Join-Path $base "outside"
$userData = Join-Path $base "user-data"
New-Item -ItemType Directory -Force $ws, $outside, (Join-Path $userData "User") | Out-Null

Set-Content (Join-Path $ws "server.js") "setInterval(() => {}, 1000);"
Set-Content (Join-Path $outside "server.js") "setInterval(() => {}, 1000);"
$enabled = if ($KillOnExit -eq "on") { "true" } else { "false" }
Set-Content (Join-Path $userData "User\settings.json") "{ `"killStack.killOnExit`": $enabled, `"security.workspace.trust.enabled`": false }"

function Get-CodeProcesses {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Code }
}

function Test-Alive([int]$ProcessId) {
  [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# Started from this script, not from VS Code, so only Kill Stack can stop them.
$insideServer = Start-Process node -ArgumentList "`"$ws\server.js`"", "--port", "9401" -PassThru -WindowStyle Hidden
$outsideServer = Start-Process node -ArgumentList "`"$outside\server.js`"", "--port", "9402" -PassThru -WindowStyle Hidden

$failed = $false
try {
  Start-Process $Code -ArgumentList @(
    "--user-data-dir", "`"$userData`"",
    "--extensions-dir", "`"$base\extensions`"",
    "--extensionDevelopmentPath=`"$Repo`"",
    "--new-window",
    "`"$ws`""
  ) | Out-Null

  # Wait for the window, then give the extension time to activate.
  $window = $null
  $deadline = (Get-Date).AddSeconds(90)
  while (-not $window -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    $window = Get-CodeProcesses |
      ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Select-Object -First 1
  }
  if (-not $window) {
    throw "VS Code window did not appear"
  }
  Start-Sleep -Seconds $StartupSeconds

  # Same message the X button sends.
  [void]$window.CloseMainWindow()

  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-CodeProcesses) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Get-CodeProcesses) {
    throw "VS Code did not exit after the window was closed"
  }
  Start-Sleep -Seconds 3

  $insideAlive = Test-Alive $insideServer.Id
  $outsideAlive = Test-Alive $outsideServer.Id
  Write-Host "kill on exit $KillOnExit -> inside alive: $insideAlive, outside alive: $outsideAlive"

  $expectInsideAlive = $KillOnExit -eq "off"
  if ($insideAlive -ne $expectInsideAlive) {
    Write-Host "FAIL: server in the open folder should be $(if ($expectInsideAlive) { 'running' } else { 'stopped' })"
    $failed = $true
  }
  if (-not $outsideAlive) {
    Write-Host "FAIL: server outside the open folder should keep running"
    $failed = $true
  }
}
catch {
  Write-Host "FAIL: $_"
  $failed = $true
}
finally {
  foreach ($server in $insideServer, $outsideServer) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
  Get-CodeProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue
}

if ($failed) { exit 1 }
Write-Host "PASS"
