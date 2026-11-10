# Create the approved channel root and key file on the Windows host.
#
# Scope (approved by the user before this ran):
#   C:\Users\rebui\AppData\Local\ae-a8n\channel\   - the channel both sides read
#   C:\Users\rebui\AppData\Local\ae-a8n\agent.key  - the shared HMAC key
# Inheritance is removed so no other principal on the box can read the key;
# only the account that runs the agent, SYSTEM and Administrators keep access.
# Deletion: Stop-Process the agent, then remove the two paths above.
$ErrorActionPreference = 'Stop'

$root    = 'C:\Users\rebui\AppData\Local\ae-a8n'
$channel = Join-Path $root 'channel'
$key     = Join-Path $root 'agent.key'
$staged  = 'C:\Users\rebui\AppData\Local\Temp\a8n-agent.key'

New-Item -ItemType Directory -Force -Path $channel | Out-Null
Move-Item -Force $staged $key

icacls $channel /inheritance:r | Out-Null
icacls $channel /grant 'UUU\basic:(OI)(CI)F' 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
icacls $key /inheritance:r | Out-Null
icacls $key /grant 'UUU\basic:F' 'SYSTEM:F' 'BUILTIN\Administrators:F' | Out-Null

'--- icacls channel'
icacls $channel
'--- icacls key'
icacls $key
'--- key file'
Get-Item $key | Select-Object FullName, Length
(Get-FileHash -Algorithm SHA256 $key).Hash
'--- staged copy removed'
Test-Path $staged
