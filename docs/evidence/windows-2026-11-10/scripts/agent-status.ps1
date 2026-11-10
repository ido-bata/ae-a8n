# Who is running, and what has the agent logged?
$ErrorActionPreference = 'Stop'
$channel = 'C:\Users\rebui\AppData\Local\ae-a8n\channel'

'--- agent processes'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*--channel*' } |
  Select-Object ProcessId, SessionId, CreationDate | Format-Table -AutoSize

'--- agent log'
$log = 'C:\Users\rebui\AppData\Local\ae-a8n\logs\agent.log'
if (Test-Path $log) { Get-Content $log -Tail 20 } else { 'no log' }

'--- presence'
$p = Join-Path $channel 'agents\ae-a8n.json'
if (Test-Path $p) {
  "mtime=$((Get-Item $p).LastWriteTime.ToString('o'))"
  "now=$((Get-Date).ToString('o'))"
}

'--- agent-runs'
Get-ChildItem (Join-Path $channel 'agent-runs') -ErrorAction SilentlyContinue |
  Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
