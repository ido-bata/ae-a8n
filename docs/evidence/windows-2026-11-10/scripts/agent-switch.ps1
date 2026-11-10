# Stop or start the agent by command line, without touching any other node.
param(
  [ValidateSet('stop', 'start')]
  [string]$Action = 'stop'
)

$ErrorActionPreference = 'Stop'
$a8n     = 'C:\Users\rebui\AppData\Local\ae-a8n'
$channel = Join-Path $a8n 'channel'
$key     = Join-Path $a8n 'agent.key'
$cli     = Join-Path $a8n 'agent-app\node_modules\@ido-bata\ae-a8n\dist\cli.js'

$agents = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '* agent *' -and $_.CommandLine -like '*--channel*' }

if ($Action -eq 'stop') {
  foreach ($agent in $agents) {
    "stopping pid=$($agent.ProcessId)"
    Stop-Process -Id $agent.ProcessId -Force
  }
  Start-Sleep -Seconds 2
} else {
  if ($agents.Count -gt 0) {
    "already running: pid=$(($agents | ForEach-Object ProcessId) -join ',')"
  } else {
    node $cli agent --hidden --channel $channel --key-file $key --host UUU --user basic
    "launcher_exit=$LASTEXITCODE"
    Start-Sleep -Seconds 4
  }
}

"--- agents now"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '* agent *' -and $_.CommandLine -like '*--channel*' } |
  Select-Object ProcessId, CreationDate
"--- presence"
(Get-Item (Join-Path $channel 'agents\ae-a8n.json')).LastWriteTime.ToString('o')
"--- now"
(Get-Date).ToString('o')
