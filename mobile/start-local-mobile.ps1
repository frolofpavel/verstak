param(
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $Root

function Find-LanIp {
  $configs = Get-NetIPConfiguration | Where-Object {
    $_.IPv4Address -and $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up'
  }
  $preferred = $configs | Where-Object {
    $_.InterfaceAlias -match 'Wi-Fi|Wireless'
  } | Select-Object -First 1
  if (-not $preferred) { $preferred = $configs | Select-Object -First 1 }
  if ($preferred) { return $preferred.IPv4Address.IPAddress }

  $fallback = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*'
  } | Select-Object -First 1
  if ($fallback) { return $fallback.IPAddress }
  return 'localhost'
}

function Start-MobileWindow($Title, $Command) {
  $script = "`$Host.UI.RawUI.WindowTitle = '$Title'`n$Command"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  Start-Process powershell.exe -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-NoExit',
    '-EncodedCommand', $encoded
  ) -WindowStyle Normal
}

function Find-FreePort($StartPort) {
  for ($port = $StartPort; $port -lt ($StartPort + 100); $port++) {
    $listener = $null
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $port)
      $listener.Start()
      return $port
    } catch {
    } finally {
      if ($listener) { $listener.Stop() }
    }
  }
  throw "No free port found starting at $StartPort"
}

if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules\.bin\electron-vite.cmd'))) {
  throw "Project dependencies not found. node_modules must exist in this worktree."
}

$Token = "verstak-local-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$Ip = Find-LanIp
$RelayPort = Find-FreePort 8787
$PwaPort = Find-FreePort 5180
$RelayUrl = "http://$Ip`:$RelayPort"
$LocalRelayUrl = "http://localhost:$RelayPort"
$MobileUrl = "http://$Ip`:$PwaPort/?relayUrl=$([uri]::EscapeDataString($RelayUrl))&accountId=local&deviceId=desktop&token=$([uri]::EscapeDataString($Token))"
$LinkFile = Join-Path $PSScriptRoot 'last-local-mobile-link.txt'

Write-Host ''
Write-Host 'Verstak Mobile local launcher' -ForegroundColor Cyan
Write-Host 'Workspace:' $Root
Write-Host 'Computer IP:' $Ip
Write-Host 'Relay port:' $RelayPort
Write-Host 'Mobile page port:' $PwaPort
Write-Host ''
if ($SelfTest) {
  Write-Host 'SelfTest OK. Mobile URL would be:' -ForegroundColor Green
  Write-Host $MobileUrl -ForegroundColor Cyan
  exit 0
}

Write-Host 'Building mobile relay...' -ForegroundColor Yellow
npm.cmd run mobile:relay:build

$relayCommand = @"
Set-Location -LiteralPath "$Root"
`$env:VERSTAK_MOBILE_RELAY_TOKEN="$Token"
`$env:PORT="$RelayPort"
npm.cmd run mobile:relay:start
"@

$desktopCommand = @"
Set-Location -LiteralPath "$Root"
`$env:VERSTAK_MOBILE_RELAY_URL="$LocalRelayUrl"
`$env:VERSTAK_MOBILE_RELAY_TOKEN="$Token"
`$env:VERSTAK_MOBILE_ACCOUNT_ID="local"
`$env:VERSTAK_MOBILE_DEVICE_ID="desktop"
`$env:VERSTAK_DEV_USER_DATA_DIR="`$env:TEMP\verstak-mobile-smoke-profile"
node_modules\.bin\electron-vite.cmd dev
"@

$pwaCommand = @"
Set-Location -LiteralPath "$Root"
npm.cmd run mobile:dev -- --host 0.0.0.0 --port $PwaPort --strictPort
"@

Start-MobileWindow 'Verstak Mobile Relay' $relayCommand
Start-Sleep -Seconds 2
Start-MobileWindow 'Verstak Desktop Dev' $desktopCommand
Start-Sleep -Seconds 2
Start-MobileWindow 'Verstak Mobile PWA' $pwaCommand

$MobileUrl | Set-Content -LiteralPath $LinkFile -Encoding UTF8
Start-Process $MobileUrl

Write-Host ''
Write-Host 'Ready. Open this URL on the phone:' -ForegroundColor Green
Write-Host $MobileUrl -ForegroundColor Cyan
Write-Host ''
Write-Host 'URL saved to:' $LinkFile
Write-Host 'The page will try to connect automatically. If it does not, press Connect.'
Write-Host 'Keep the three service windows open while testing.'
Write-Host 'If the phone cannot open the URL, check that it is on the same Wi-Fi network.'
Write-Host ''
Write-Host 'Session token:' $Token
Write-Host ''
