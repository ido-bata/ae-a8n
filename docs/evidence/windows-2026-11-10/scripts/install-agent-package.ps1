# Install the packed ae-a8n into a dedicated app directory on the Windows host.
#
# Why a separate install: the agent must run from the artifact that was
# packed and tested, not from a clone or a global install that someone else
# may have changed. This is the same tarball the macOS gate was run against.
$ErrorActionPreference = 'Stop'

$app    = 'C:\Users\rebui\AppData\Local\ae-a8n\agent-app'
$tarball = 'C:\Users\rebui\AppData\Local\Temp\a8n-latest.tgz'

New-Item -ItemType Directory -Force -Path $app | Out-Null
if (-not (Test-Path (Join-Path $app 'package.json'))) {
  '{"name":"a8n-agent-app","private":true}' | Set-Content -Encoding Ascii (Join-Path $app 'package.json')
}

(Get-FileHash -Algorithm SHA256 $tarball).Hash
Push-Location $app
npm install --no-audit --no-fund $tarball 2>&1 | Select-Object -Last 4
Pop-Location

$cli = Join-Path $app 'node_modules\@ido-bata\ae-a8n\dist\cli.js'
'--- cli'
Test-Path $cli
node $cli --version
'--- agent help (first line)'
(node $cli agent --help) -split "`n" | Select-Object -First 1
