# Run the repository's own gate on the Windows host against a pushed commit.
#
# The archive is taken from a fresh fetch, so this measures the commit that
# was pushed, not whatever the clone's working tree happens to hold.
# git writes progress to stderr; with $ErrorActionPreference='Stop' that
# aborts the script, so this file checks exit codes instead.
param(
  [string]$Ref = 'integration/win-cli',
  [string]$Tag = 'head'
)

$ErrorActionPreference = 'Continue'
$source = 'C:\Users\rebui\work\ae-a8n'
$gate   = "C:\Users\rebui\AppData\Local\Temp\a8n-gate-$Tag"

git -C $source fetch origin "+refs/heads/$Ref`:refs/remotes/origin/$Ref" 2>$null
$fetched = git -C $source rev-parse "refs/remotes/origin/$Ref"
if ($LASTEXITCODE -ne 0) { throw "fetch of $Ref failed" }
$sha = $fetched.Trim()
"commit=$sha"

if (Test-Path $gate) { Remove-Item -Recurse -Force $gate }
New-Item -ItemType Directory -Force -Path $gate | Out-Null
# A pipe into tar does not work from PowerShell here; zip then expand.
$zip = "$gate.zip"
git -C $source archive --format=zip -o $zip $sha
if ($LASTEXITCODE -ne 0) { throw "archive of $sha failed" }
Expand-Archive -Path $zip -DestinationPath $gate -Force

Push-Location $gate
npm ci --no-audit --no-fund 2>&1 | Select-Object -Last 2
"ci_exit=$LASTEXITCODE"
npm run check 2>&1 | Tee-Object -FilePath (Join-Path $gate 'gate.log') | Select-Object -Last 25
"gate_exit=$LASTEXITCODE"
Pop-Location
Get-Content (Join-Path $gate 'gate.log') | Select-String -Pattern 'Test Files|Tests ' | Select-Object -Last 2
