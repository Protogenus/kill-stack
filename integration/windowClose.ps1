# Opens a real VS Code window with Kill Stack loaded, starts a server in the
# open folder, one elsewhere, and one on the ignore list, closes the window the
# way clicking X does, and checks which servers survived. Exits 1 if wrong.
param(
  [Parameter(Mandatory = $true)][string]$Code,
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][ValidateSet("on", "off")][string]$KillOnExit,
  [int]$StartupSeconds = 25
)

$ErrorActionPreference = "Stop"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# Kill On Exit stops every server on the machine. This limits it to the servers
# this script starts, so a local run never kills your own servers.
$env:KILLSTACK_TEST_ONLY_MATCH = "ks-windowclose-"

$base = Join-Path $env:TEMP ("ks-windowclose-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$ws = Join-Path $base "ws"
$elsewhere = Join-Path $base "elsewhere"
$kept = Join-Path $base "kept-server"
$userData = Join-Path $base "user-data"
New-Item -ItemType Directory -Force $ws, $elsewhere, $kept, (Join-Path $userData "User") | Out-Null

foreach ($dir in $ws, $elsewhere, $kept) {
  Set-Content (Join-Path $dir "server.js") "setInterval(() => {}, 1000);"
}
$enabled = if ($KillOnExit -eq "on") { "true" } else { "false" }
Set-Content (Join-Path $userData "User\settings.json") "{ `"killStack.killOnExit`": $enabled, `"killStack.ignorePatterns`": [`"kept-server`"], `"security.workspace.trust.enabled`": false }"

function Get-CodeProcesses {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Code }
}

function Test-Alive([int]$ProcessId) {
  [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Start-Server([string]$Dir, [int]$Port) {
  Start-Process node -ArgumentList "`"$Dir\server.js`"", "--port", "$Port" -PassThru -WindowStyle Hidden
}

# Started from this script, not from VS Code, so only Kill Stack can stop them.
$inFolder = Start-Server $ws 9401
$elsewhereServer = Start-Server $elsewhere 9402
$keptServer = Start-Server $kept 9403

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

  $inFolderAlive = Test-Alive $inFolder.Id
  $elsewhereAlive = Test-Alive $elsewhereServer.Id
  $keptAlive = Test-Alive $keptServer.Id
  Write-Host "kill on exit $KillOnExit -> in folder: $inFolderAlive, elsewhere: $elsewhereAlive, ignored: $keptAlive"

  # With Kill On Exit on, every server except the ignored one should stop.
  $expectAlive = $KillOnExit -eq "off"
  $state = if ($expectAlive) { "running" } else { "stopped" }
  if ($inFolderAlive -ne $expectAlive) {
    Write-Host "FAIL: server in the open folder should be $state"
    $failed = $true
  }
  if ($elsewhereAlive -ne $expectAlive) {
    Write-Host "FAIL: server outside the open folder should be $state"
    $failed = $true
  }
  if (-not $keptAlive) {
    Write-Host "FAIL: ignored server should keep running"
    $failed = $true
  }
}
catch {
  Write-Host "FAIL: $_"
  $failed = $true
}
finally {
  foreach ($server in $inFolder, $elsewhereServer, $keptServer) {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  }
  Get-CodeProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $base -ErrorAction SilentlyContinue
}

if ($failed) { exit 1 }
Write-Host "PASS"
