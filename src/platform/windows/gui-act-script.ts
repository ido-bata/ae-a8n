/**
 * The PowerShell mutation script the Windows GUI recovery runs (#283).
 *
 * Vehicle decision (recorded for the PR): Windows PowerShell 5.1
 * (`powershell.exe`, inbox on every supported Windows 11 host) driving the
 * same two OS-native sources as the observation script in
 * `gui-observe-script.ts` — Win32 user32 enumeration via `Add-Type`
 * P/Invoke, and UI Automation through the inbox
 * `UIAutomationClient`/`UIAutomationTypes` assemblies. No npm dependency,
 * no native binary, no installer.
 *
 * Unlike the observer this script can mutate, in exactly two ways, both
 * behind the caller's lease + audit + identity re-checks:
 *
 *   - `InvokePattern.Invoke()` on a UIA button element — the accessibility
 *     press, the Windows analog of the macOS AX press.
 *   - a coordinate click (`SetCursorPos` + `mouse_event`) at the *element's
 *     own* `BoundingRectangle` center — used only when the button has no
 *     invoke pattern, and only after the window and button identity were
 *     re-verified inside this same run. This mirrors the macOS ordering:
 *     identity press first, coordinates from the identified element second,
 *     never a blind click at a remembered position.
 *
 * Session scoping: the script runs as a child of the ae-a8n agent, which
 * lives inside the target interactive session — the same rule the observer
 * follows. Windows has no `launchctl asuser` equivalent here; entering
 * another session is not possible from this vehicle, which is exactly why
 * the recovery refuses to act when its own session proof no longer holds.
 *
 * Output contract: newline-delimited JSON records on stdout.
 *
 *   list mode:  {"type":"meta"|"window"|"uia"|"uia-unavailable"|"error"|"done"}
 *   press mode: {"type":"meta"} then one {"type":"result","status":...}
 *   click mode: one {"type":"result","status":"CLICKED"|"FAILED",...}
 *
 * Press statuses the caller classifies:
 *
 *   INVOKED / CLICKED   the mutation ran; report performed
 *   MISSING             the pid is gone
 *   SESSION_MISMATCH    the pid lives in a different session than ours
 *   CHANGED             the window at the index is no longer the identified one
 *   UNVERIFIED          identity could not be proven (UIA unavailable)
 *   NOT_FOUND           index out of range, or the button is not there
 *   NO_FRAME            the button has no usable bounding rectangle
 *   INVOKE_FAILED       InvokePattern was present but Invoke() threw — the
 *                       press may have partially happened; ambiguous
 *   FAILED              infrastructure failure before any input was sent
 *
 * The script is embedded as a string constant (repo convention for Windows
 * helpers — see `probe.ts`, `gui-observe-script.ts`) rather than a `.ps1`
 * file: `dist/` is the only shipped payload, so an inlined script cannot go
 * missing from a packed install and cannot drift from the TypeScript that
 * interprets it.
 */

export type WindowsGuiActCommand =
  | { readonly mode: "list"; readonly pid: number }
  | {
      readonly mode: "press";
      readonly pid: number;
      readonly windowIndex: number;
      readonly buttonTitle: string;
      readonly expectedTitle: string;
      readonly expectedClass: string;
      readonly expectedText: string;
    }
  | { readonly mode: "click"; readonly x: number; readonly y: number };

/** A single-quoted PowerShell string literal; `'` is escaped as `''`. */
function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`invalid target pid ${String(pid)}`);
  }
}

/**
 * Build the act script for one command. Integers are validated before
 * interpolation; every string crosses as a quoted PowerShell literal, so
 * nothing that comes from a window title or button label becomes script.
 */
export function windowsGuiActScript(command: WindowsGuiActCommand): string {
  const params: string[] = [];
  switch (command.mode) {
    case "list":
      assertPid(command.pid);
      params.push(
        `$script:mode = 'list'`,
        `$script:targetPid = ${command.pid}`,
      );
      break;
    case "press":
      assertPid(command.pid);
      if (!Number.isInteger(command.windowIndex) || command.windowIndex < 1) {
        throw new TypeError(`invalid window index ${String(command.windowIndex)}`);
      }
      params.push(
        `$script:mode = 'press'`,
        `$script:targetPid = ${command.pid}`,
        `$script:windowIndex = ${command.windowIndex}`,
        `$script:buttonTitle = ${psString(command.buttonTitle)}`,
        `$script:expectedTitle = ${psString(command.expectedTitle)}`,
        `$script:expectedClass = ${psString(command.expectedClass)}`,
        `$script:expectedText = ${psString(command.expectedText)}`,
      );
      break;
    case "click":
      if (!Number.isInteger(command.x) || !Number.isInteger(command.y)) {
        throw new TypeError(`invalid click coordinates ${String(command.x)},${String(command.y)}`);
      }
      params.push(
        `$script:mode = 'click'`,
        `$script:clickX = ${command.x}`,
        `$script:clickY = ${command.y}`,
      );
      break;
  }

  return `
${params.join("\n")}
$script:maxWindows = 128
$script:maxUiaElements = 300
$script:maxUiaDepth = 6

function Write-Record($record) {
  [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 8))
}

function Write-Result($status, $detail) {
  $rec = [ordered]@{ type = 'result'; status = $status }
  if ($null -ne $detail -and [string]$detail -ne '') { $rec.detail = [string]$detail }
  Write-Record $rec
}

# --- Win32 + input P/Invoke ----------------------------------------------
$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AeA8nWin32Act {
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
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
} catch {
  if ($script:mode -eq 'list') {
    Write-Record ([ordered]@{ type = 'error'; error = [string]$_.Exception.Message })
    Write-Record ([ordered]@{ type = 'done'; windows = 0 })
  } else {
    # Infrastructure failed before any input could be sent.
    Write-Result 'FAILED' ('Add-Type failed: ' + [string]$_.Exception.Message)
  }
  exit 0
}

# --- UI Automation availability -------------------------------------------
$script:uiaAvailable = $false
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  $script:uiaAvailable = $true
} catch {}

# --- helpers ---------------------------------------------------------------
function Get-PidWindows {
  $found = New-Object System.Collections.ArrayList
  $cb = [AeA8nWin32Act+EnumProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $wpid = [uint32]0
    [void][AeA8nWin32Act]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if ([int]$wpid -eq $script:targetPid) { [void]$found.Add($hWnd) }
    return $true
  }
  [void][AeA8nWin32Act]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}

function Get-WindowFields($h) {
  $title = New-Object System.Text.StringBuilder 1024
  [void][AeA8nWin32Act]::GetWindowText($h, $title, 1024)
  $class = New-Object System.Text.StringBuilder 256
  [void][AeA8nWin32Act]::GetClassName($h, $class, 256)
  $rect = New-Object AeA8nWin32Act+RECT
  [void][AeA8nWin32Act]::GetWindowRect($h, [ref]$rect)
  $owner = [AeA8nWin32Act]::GetWindow($h, 4)  # GW_OWNER
  $ownerHwnd = '0'
  $ownerEnabled = $null
  if ($owner -ne [IntPtr]::Zero) {
    $ownerHwnd = [string]$owner.ToInt64()
    try { $ownerEnabled = [bool][AeA8nWin32Act]::IsWindowEnabled($owner) } catch {}
  }
  return @{
    title = $title.ToString()
    className = $class.ToString()
    rect = @([int]$rect.Left, [int]$rect.Top, [int]$rect.Right, [int]$rect.Bottom)
    ownerHwnd = $ownerHwnd
    ownerEnabled = $ownerEnabled
  }
}

# Bounded UIA walk shared by list and press. Returns @{ ok; controlType;
# texts; buttons } where buttons carry { name; rect } — the rect is what a
# coordinate fallback may legitimately use, because it is the identified
# element's own frame, never a remembered screen position.
function Get-UiaInfo($root) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $info = @{ ok = $true; controlType = $null; texts = @(); buttons = @() }
  try { $info.controlType = [string]$root.Current.ControlType.ProgrammaticName } catch {}
  $texts = New-Object System.Collections.ArrayList
  $buttons = New-Object System.Collections.ArrayList
  $count = 0
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ el = $root; depth = 0 })
  while ($queue.Count -gt 0 -and $count -lt $script:maxUiaElements) {
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
          if ($buttons.Count -lt 50) {
            $r = $null
            try {
              $br = $cc.BoundingRectangle
              $r = @([int][Math]::Round($br.X), [int][Math]::Round($br.Y), [int][Math]::Round($br.Width), [int][Math]::Round($br.Height))
            } catch { $r = $null }
            [void]$buttons.Add(@{ name = $nm; rect = $r })
          }
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
  $info.texts = @($texts)
  $info.buttons = @($buttons)
  $info.elementCount = $count
  return $info
}

# The first enabled button whose UIA Name matches, or $null. Matching is
# case-insensitive like the macOS press's AppleScript comparison.
function Find-ButtonElement($root, $wanted) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@{ el = $root; depth = 0 })
  $count = 0
  while ($queue.Count -gt 0 -and $count -lt $script:maxUiaElements) {
    $item = $queue.Dequeue()
    $node = $item.el
    $depth = [int]$item.depth
    $child = $null
    try { $child = $walker.GetFirstChild($node) } catch { $child = $null }
    while ($null -ne $child -and $count -lt $script:maxUiaElements) {
      $count++
      $next = $null
      $matched = $false
      try {
        $cc = $child.Current
        $ct = [string]$cc.ControlType.ProgrammaticName
        $nm = [string]$cc.Name
        if ($ct -eq 'ControlType.Button' -and $nm -eq $wanted) {
          try { $matched = [bool]$cc.IsEnabled } catch { $matched = $false }
        }
        if (-not $matched -and $depth -lt $script:maxUiaDepth) {
          $queue.Enqueue(@{ el = $child; depth = ($depth + 1) })
        }
      } catch {}
      if ($matched) { return $child }
      try { $next = $walker.GetNextSibling($child) } catch { $next = $null }
      $child = $next
    }
  }
  return $null
}

function Invoke-ClickAt($x, $y) {
  # MOUSEEVENTF_LEFTDOWN | LEFTUP at the current cursor position after
  # SetCursorPos. This is the documented fallback vehicle; whether it
  # reaches a real dialog is a real-host question (#283 acceptance).
  [void][AeA8nWin32Act]::SetCursorPos([int]$x, [int]$y)
  [AeA8nWin32Act]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [AeA8nWin32Act]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

# --- click mode: the coordinate fallback, addressed by the caller ----------
if ($script:mode -eq 'click') {
  try {
    Invoke-ClickAt $script:clickX $script:clickY
    Write-Result 'CLICKED'
  } catch {
    Write-Result 'FAILED' ([string]$_.Exception.Message)
  }
  exit 0
}

# --- shared preamble for list and press: pid identity + session guard ------
$proc = Get-Process -Id $script:targetPid -ErrorAction SilentlyContinue
$meta = [ordered]@{ type = 'meta'; pid = $script:targetPid }
if ($null -eq $proc) {
  $meta.exists = $false
} else {
  $meta.exists = $true
  try { $meta.sessionId = [int]$proc.SessionId } catch {}
}
if ($script:mode -eq 'list') { Write-Record $meta }

if ($script:mode -eq 'press' -or $script:mode -eq 'list') {
  if ($null -eq $proc) {
    if ($script:mode -eq 'press') { Write-Result 'MISSING' }
    if ($script:mode -eq 'list') { Write-Record ([ordered]@{ type = 'done'; windows = 0 }) }
    exit 0
  }
  # The pid must live in the session this script runs in. EnumWindows only
  # sees this session's desktop anyway, but the explicit check turns "empty
  # list" into an honest refusal instead of a silent wrong-session read.
  $ownSession = $null
  try { $ownSession = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId } catch {}
  $pidSession = $null
  try { $pidSession = [int]$proc.SessionId } catch {}
  if ($null -ne $pidSession -and $null -ne $ownSession -and $pidSession -ne $ownSession) {
    if ($script:mode -eq 'press') {
      Write-Result 'SESSION_MISMATCH' ("pid session " + $pidSession + " != own session " + $ownSession)
    } else {
      Write-Record ([ordered]@{ type = 'error'; error = ("pid session " + $pidSession + " != own session " + $ownSession) })
      Write-Record ([ordered]@{ type = 'done'; windows = 0 })
    }
    exit 0
  }
}

# --- list mode --------------------------------------------------------------
if ($script:mode -eq 'list') {
  $targets = Get-PidWindows
  $truncated = $targets.Count -gt $script:maxWindows
  $shown = 0
  $uiaOk = 0
  $uiaFailed = 0
  if (-not $script:uiaAvailable) {
    Write-Record ([ordered]@{ type = 'uia-unavailable'; error = 'UIAutomationClient assemblies could not be loaded' })
  }
  for ($i = 0; $i -lt $targets.Count -and $shown -lt $script:maxWindows; $i++) {
    $h = $targets[$i]
    $shown++
    $f = Get-WindowFields $h
    $wpid = [uint32]0
    $tid = [AeA8nWin32Act]::GetWindowThreadProcessId($h, [ref]$wpid)
    Write-Record ([ordered]@{
      type = 'window'
      index = $shown
      hwnd = [string]$h.ToInt64()
      title = $f.title
      className = $f.className
      visible = [bool][AeA8nWin32Act]::IsWindowVisible($h)
      enabled = [bool][AeA8nWin32Act]::IsWindowEnabled($h)
      iconic = [bool][AeA8nWin32Act]::IsIconic($h)
      rect = $f.rect
      ownerHwnd = $f.ownerHwnd
      ownerEnabled = $f.ownerEnabled
      threadId = [int]$tid
      sessionId = $meta.sessionId
    })
    if ($script:uiaAvailable) {
      $rec = [ordered]@{ type = 'uia'; index = $shown; hwnd = [string]$h.ToInt64() }
      try {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
        if ($null -eq $el) {
          $rec.ok = $false
          $rec.error = 'UIA element unavailable'
          $uiaFailed++
        } else {
          $info = Get-UiaInfo $el
          $rec.ok = $true
          $rec.controlType = $info.controlType
          $rec.texts = @($info.texts)
          $rec.buttons = @($info.buttons)
          $rec.elementCount = $info.elementCount
          $uiaOk++
        }
      } catch {
        $rec.ok = $false
        $rec.error = [string]$_.Exception.Message
        $uiaFailed++
      }
      Write-Record $rec
    }
  }
  Write-Record ([ordered]@{ type = 'done'; windows = $shown; uiaOk = $uiaOk; uiaFailed = $uiaFailed; truncated = $truncated })
  exit 0
}

# --- press mode --------------------------------------------------------------
$targets = Get-PidWindows
if ($script:windowIndex -lt 1 -or $script:windowIndex -gt $targets.Count) {
  Write-Result 'NOT_FOUND' ("window index " + $script:windowIndex + " of " + $targets.Count)
  exit 0
}
$h = $targets[$script:windowIndex - 1]
$f = Get-WindowFields $h

# Identity re-check, inside this run and immediately before any input: the
# listing was a separate call, and the window at that index may have been
# replaced. A mismatch is a refusal, never a guess — same contract as the
# macOS PRESS_BUTTON_SCRIPT.
if ($script:expectedTitle -ne '' -and $f.title -ne $script:expectedTitle) {
  Write-Result 'CHANGED' ("title '" + $f.title + "' != '" + $script:expectedTitle + "'")
  exit 0
}
if ($script:expectedClass -ne '' -and $f.className -ne $script:expectedClass) {
  Write-Result 'CHANGED' ("class '" + $f.className + "' != '" + $script:expectedClass + "'")
  exit 0
}

if (-not $script:uiaAvailable) {
  # The marker text and the button live in the UIA tree; without it the
  # window's identity cannot be proven, so nothing is pressed.
  Write-Result 'UNVERIFIED' 'UI Automation is unavailable'
  exit 0
}
$root = $null
try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($h) } catch { $root = $null }
if ($null -eq $root) {
  Write-Result 'UNVERIFIED' 'UIA element unavailable'
  exit 0
}

if ($script:expectedText -ne '') {
  $found = $false
  try {
    $info = Get-UiaInfo $root
    foreach ($t in @($info.texts)) {
      // Literal substring match, same as the macOS press's contains —
      // -like would read the marker's own characters as wildcards.
      if ([string]$t).Contains([string]$script:expectedText)) { $found = $true; break }
    }
  } catch {}
  if (-not $found) {
    Write-Result 'CHANGED' 'the window no longer contains the expected text'
    exit 0
  }
}

$button = $null
try { $button = Find-ButtonElement $root $script:buttonTitle } catch { $button = $null }
if ($null -eq $button) {
  Write-Result 'NOT_FOUND' ("no enabled button named '" + $script:buttonTitle + "'")
  exit 0
}

# Accessibility press first: UIA InvokePattern is the Windows analog of the
# macOS AX press. Only when the element cannot be invoked does the
# coordinate fallback run — at the element's own frame, verified above.
$pattern = $null
try {
  $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
} catch { $pattern = $null }
if ($null -ne $pattern) {
  try {
    $pattern.Invoke()
    Write-Result 'INVOKED'
  } catch {
    # Invoke() threw: the press may have partially reached the dialog.
    # Ambiguous — the caller must re-observe, never retry blindly.
    Write-Result 'INVOKE_FAILED' ([string]$_.Exception.Message)
  }
  exit 0
}

$rect = $null
try { $rect = $button.Current.BoundingRectangle } catch { $rect = $null }
if ($null -eq $rect -or $rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) {
  Write-Result 'NO_FRAME' 'the button has no usable bounding rectangle'
  exit 0
}
try {
  $cx = [int][Math]::Round($rect.X + $rect.Width / 2)
  $cy = [int][Math]::Round($rect.Y + $rect.Height / 2)
  Invoke-ClickAt $cx $cy
  Write-Result 'CLICKED'
} catch {
  Write-Result 'FAILED' ([string]$_.Exception.Message)
}
exit 0
`;
}
