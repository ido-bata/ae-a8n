/**
 * The PowerShell observation script the Windows GUI probe runs (#282).
 *
 * Vehicle decision (recorded for the PR): Windows PowerShell 5.1
 * (`powershell.exe`, inbox on every supported Windows 11 host) driving two
 * OS-native sources — Win32 user32 enumeration via `Add-Type` P/Invoke, and
 * UI Automation through the inbox `UIAutomationClient`/`UIAutomationTypes`
 * .NET assemblies. No npm dependency, no native binary, no installer: the
 * same vehicle `src/platform/windows/probe.ts` already uses for read-only
 * host facts, extended to the GUI surface the supervision contract needs.
 *
 * Output contract: newline-delimited JSON records on stdout, one per line,
 * so a killed or timed-out observer still leaves the records it already
 * proved on the wire:
 *
 *   {"type":"meta", ...}        process existence/responsiveness/session
 *   {"type":"session", ...}     foreground pid + GUI session lock evidence
 *   {"type":"window", ...}      one Win32 census row per top-level window
 *   {"type":"uia", ...}         one UIA result per window (joined by hwnd)
 *   {"type":"uia-unavailable"}  UIA assemblies could not be loaded
 *   {"type":"census-error"}     the Win32 census itself failed
 *   {"type":"done", ...}        counts + truncation flag
 *
 * The script is observation-only: it reads window state, sends one
 * `WM_NULL` liveness probe per window (the same message `tasklist /V`
 * effectively relies on), and never posts input, never calls
 * `SetWindowPos`/`ShowWindow`/`SendInput`, and never opens a handle with
 * write intent. UIA reads the control tree only — no `Invoke`, no
 * `SetFocus`, no pattern that mutates.
 *
 * Embedded as a string constant (repo convention for Windows helpers — see
 * `probe.ts`, `session.ts`, `executor.ts`) rather than a `.ps1` file:
 * `dist/` is the only shipped payload and `host/` is reserved for the
 * ExtendScript host scripts, so an inlined script cannot go missing from a
 * packed install and cannot drift from the TypeScript that interprets it.
 */

/**
 * Build the observation script for one target pid. The pid is interpolated
 * as a validated integer; callers must check it before calling.
 */
export function windowsGuiObserveScript(pid: number): string {
  return `
$ErrorActionPreference = 'Continue'
$script:targetPid = ${pid}
$script:maxWindows = 128
$script:maxUiaElements = 300
$script:maxUiaDepth = 6
# The observer bounds itself: a hung or merely slow target must not hold the
# probe past its budget. When the deadline passes mid-census or mid-UIA the
# script stops enumerating and still emits the done record with the
# partial-evidence flags, so the probe reports degraded evidence instead of
# a killed process that left no closing record (#324).
$script:deadline = [DateTime]::UtcNow.AddSeconds(20)
$script:censusTimedOut = $false
$script:uiaTimedOut = $false

function Write-Record($record) {
  [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 8))
}

# --- meta: process identity, emitted before any GUI dependency -----------
$proc = Get-Process -Id $script:targetPid -ErrorAction SilentlyContinue
$meta = [ordered]@{ type = 'meta'; pid = $script:targetPid }
if ($null -eq $proc) {
  $meta.exists = $false
} else {
  $meta.exists = $true
  $meta.responding = $null
  try { $meta.responding = [bool]$proc.Responding } catch {}
  try { $meta.sessionId = [int]$proc.SessionId } catch {}
  try { $meta.startTime = $proc.StartTime.ToUniversalTime().ToString('o') } catch {}
  try { $meta.imageName = [string]$proc.ProcessName } catch {}
}
Write-Record $meta

# --- Win32 census via Add-Type P/Invoke ----------------------------------
$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AeA8nWin32 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll")] public static extern bool SendMessageTimeout(IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
} catch {
  Write-Record ([ordered]@{ type = 'census-error'; error = [string]$_.Exception.Message })
  Write-Record ([ordered]@{ type = 'done'; windows = 0; uiaOk = 0; uiaFailed = 0; truncated = $false; timedOut = $false; censusComplete = $false; uiaComplete = $false })
  exit 0
}

# --- session record: foreground window + lock evidence -------------------
$session = [ordered]@{ type = 'session' }
try {
  $fg = [AeA8nWin32]::GetForegroundWindow()
  $fgPid = [uint32]0
  [void][AeA8nWin32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $session.foregroundPid = [int]$fgPid
} catch { $session.foregroundPid = $null }
# GUI session lock: LogonUI.exe runs on the secure desktop while a session
# is locked or transitioning through sign-in. Best-effort evidence scoped
# to the target's session id; unreadable stays null, never guessed.
try {
  $logon = @(Get-Process -Name LogonUI -ErrorAction SilentlyContinue)
  if ($null -ne $meta.sessionId) {
    $session.locked = [bool]($logon | Where-Object { $_.SessionId -eq $meta.sessionId })
  } elseif ($logon.Count -gt 0) {
    $session.locked = $true
  } else {
    $session.locked = $false
  }
} catch { $session.locked = $null }
Write-Record $session

# --- Win32 window census --------------------------------------------------
$script:candidates = New-Object System.Collections.ArrayList
$enumCb = [AeA8nWin32+EnumProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  $wpid = [uint32]0
  [void][AeA8nWin32]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
  if ([int]$wpid -eq $script:targetPid) {
    [void]$script:candidates.Add($hWnd)
  }
  return $true
}
[void][AeA8nWin32]::EnumWindows($enumCb, [IntPtr]::Zero)

$truncated = $script:candidates.Count -gt $script:maxWindows
$targets = @()
for ($i = 0; $i -lt $script:candidates.Count -and $targets.Count -lt $script:maxWindows; $i++) {
  $targets += $script:candidates[$i]
}

$SMTO_ABORTIFHUNG = 0x0002
$SMTO_BLOCK = 0x0001
foreach ($h in $targets) {
  # Per-window work is bounded twice: SendMessageTimeout caps each liveness
  # probe, and this deadline caps the census as a whole.
  if ([DateTime]::UtcNow -gt $script:deadline) { $script:censusTimedOut = $true; break }
  $title = New-Object System.Text.StringBuilder 1024
  [void][AeA8nWin32]::GetWindowText($h, $title, 1024)
  $class = New-Object System.Text.StringBuilder 256
  [void][AeA8nWin32]::GetClassName($h, $class, 256)
  $rect = New-Object AeA8nWin32+RECT
  [void][AeA8nWin32]::GetWindowRect($h, [ref]$rect)
  $owner = [AeA8nWin32]::GetWindow($h, 4)  # GW_OWNER
  $ownerPid = [uint32]0
  $ownerHwnd = '0'
  $ownerEnabled = $null
  if ($owner -ne [IntPtr]::Zero) {
    $ownerHwnd = [string]$owner.ToInt64()
    [void][AeA8nWin32]::GetWindowThreadProcessId($owner, [ref]$ownerPid)
    try { $ownerEnabled = [bool][AeA8nWin32]::IsWindowEnabled($owner) } catch {}
  }
  $hpid = [uint32]0
  $tid = [AeA8nWin32]::GetWindowThreadProcessId($h, [ref]$hpid)
  # SendMessageTimeout(WM_NULL): the same liveness question tasklist /V
  # answers at process level, asked per window. 1 s bound per window.
  $responding = $null
  $res = [UIntPtr]::Zero
  try {
    $ok = [AeA8nWin32]::SendMessageTimeout($h, 0, [UIntPtr]::Zero, [IntPtr]::Zero, ($SMTO_ABORTIFHUNG -bor $SMTO_BLOCK), 1000, [ref]$res)
    $responding = [bool]$ok
  } catch {}
  Write-Record ([ordered]@{
    type = 'window'
    hwnd = [string]$h.ToInt64()
    title = $title.ToString()
    className = $class.ToString()
    visible = [bool][AeA8nWin32]::IsWindowVisible($h)
    enabled = [bool][AeA8nWin32]::IsWindowEnabled($h)
    iconic = [bool][AeA8nWin32]::IsIconic($h)
    rect = @([int]$rect.Left, [int]$rect.Top, [int]$rect.Right, [int]$rect.Bottom)
    ownerPid = [int]$ownerPid
    ownerHwnd = $ownerHwnd
    ownerEnabled = $ownerEnabled
    threadId = [int]$tid
    responding = $responding
    sessionId = $meta.sessionId
  })
}

# --- UI Automation structured extraction ---------------------------------
$uiaOk = 0
$uiaFailed = 0
$uiaState = 'ok'
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
} catch {
  $uiaState = 'unavailable'
  Write-Record ([ordered]@{ type = 'uia-unavailable'; error = [string]$_.Exception.Message })
}

if ($uiaState -eq 'ok') {
  $walker = $null
  try { $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker } catch {}
  foreach ($h in $targets) {
    if ($script:uiaTimedOut) { break }
    if ([DateTime]::UtcNow -gt $script:deadline) { $script:uiaTimedOut = $true; break }
    $rec = [ordered]@{ type = 'uia'; hwnd = [string]$h.ToInt64() }
    try {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
      if ($null -eq $el -or $null -eq $walker) {
        $rec.ok = $false
        $rec.error = 'UIA element or tree walker unavailable'
      } else {
        $cur = $el.Current
        $rec.ok = $true
        try { $rec.controlType = [string]$cur.ControlType.ProgrammaticName } catch {}
        try { $rec.name = [string]$cur.Name } catch {}
        try { $rec.automationId = [string]$cur.AutomationId } catch {}
        try { $rec.enabled = [bool]$cur.IsEnabled } catch {}
        $texts = New-Object System.Collections.ArrayList
        $buttons = New-Object System.Collections.ArrayList
        $count = 0
        $queue = New-Object System.Collections.Queue
        $queue.Enqueue(@{ el = $el; depth = 0 })
        while ($queue.Count -gt 0 -and $count -lt $script:maxUiaElements) {
          if ([DateTime]::UtcNow -gt $script:deadline) { $script:uiaTimedOut = $true; break }
          $item = $queue.Dequeue()
          $node = $item.el
          $depth = [int]$item.depth
          $child = $null
          try { $child = $walker.GetFirstChild($node) } catch { $child = $null }
          while ($null -ne $child -and $count -lt $script:maxUiaElements) {
            $count++
            $next = $null
            try {
              $cc = $child.Current
              $ct = [string]$cc.ControlType.ProgrammaticName
              $nm = [string]$cc.Name
              if ($ct -eq 'ControlType.Button' -and $nm -ne '') {
                if ($buttons.Count -lt 50) { [void]$buttons.Add($nm) }
              } elseif (($ct -eq 'ControlType.Text' -or $ct -eq 'ControlType.Edit') -and $nm -ne '') {
                if ($texts.Count -lt 100) { [void]$texts.Add($nm) }
              }
              if ($depth -lt $script:maxUiaDepth) {
                $queue.Enqueue(@{ el = $child; depth = ($depth + 1) })
              }
            } catch {}
            try { $next = $walker.GetNextSibling($child) } catch { $next = $null }
            $child = $next
          }
        }
        $rec.texts = @($texts)
        $rec.buttons = @($buttons)
        $rec.elementCount = $count
        $uiaOk++
      }
    } catch {
      $rec.ok = $false
      $rec.error = [string]$_.Exception.Message
    }
    if (-not $rec.ok) { $uiaFailed++ }
    Write-Record $rec
  }
}

Write-Record ([ordered]@{
  type = 'done'
  windows = $targets.Count
  uiaOk = $uiaOk
  uiaFailed = $uiaFailed
  truncated = $truncated
  timedOut = [bool]($script:censusTimedOut -or $script:uiaTimedOut)
  censusComplete = [bool](-not $script:censusTimedOut)
  uiaComplete = [bool](-not $script:uiaTimedOut)
})
`;
}
