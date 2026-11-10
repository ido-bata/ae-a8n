# Start the agent on the Windows host and show what it wrote.
#
# The agent is started from the installed tarball with --hidden, so it has no
# console window. A launcher exit 0 is NOT success: this script therefore
# prints the log, the presence file the agent signed and its mtime, and the
# agent process itself. Presence is the only thing that says "ready".
param(
  [string]$Nonce = 'MANUAL'
)

$ErrorActionPreference = 'Stop'
$a8n     = 'C:\Users\rebui\AppData\Local\ae-a8n'
$channel = Join-Path $a8n 'channel'
$key     = Join-Path $a8n 'agent.key'
$log     = Join-Path $a8n 'logs\agent.log'
$cli     = Join-Path $a8n 'agent-app\node_modules\@ido-bata\ae-a8n\dist\cli.js'

"--- agent already running?"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '* agent *' -and $_.CommandLine -like '*--channel*' } |
  Select-Object ProcessId, CreationDate

"--- start at $((Get-Date).ToString('HH:mm:ss'))"
node $cli agent --hidden --channel $channel --key-file $key --host UUU --user basic
"launcher_exit=$LASTEXITCODE"

Start-Sleep -Seconds 6

"--- agent process"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '* agent *' -and $_.CommandLine -like '*--channel*' } |
  Select-Object ProcessId, SessionId, CreationDate

"--- conhost children of that agent"
$agents = (Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '* agent *' -and $_.CommandLine -like '*--channel*' }).ProcessId
$consoleCount = 0
foreach ($id in $agents) {
  $consoleCount += (Get-CimInstance Win32_Process -Filter "Name='conhost.exe'" |
    Where-Object { $_.ParentProcessId -eq $id }).Count
}
"agent_conhost_children=$consoleCount"

"--- presence written by the agent"
Get-ChildItem -Path (Join-Path $channel 'presence') -ErrorAction SilentlyContinue |
  Select-Object Name, Length, LastWriteTime

"--- log tail"
if (Test-Path $log) {
  Get-Content $log -Tail 15
} else {
  "no log at $log"
}
