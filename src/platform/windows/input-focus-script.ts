/**
 * The PowerShell focus readback/request helper for Windows input
 * (#373, `specs/ime-input/spec.md` §5.3, parent #344 / program #337).
 *
 * Vehicle decision (recorded for the PR): Windows PowerShell 5.1
 * (`powershell.exe`) driving Win32 `GetGUIThreadInfo` via `Add-Type`
 * P/Invoke plus UI Automation through the inbox
 * `UIAutomationClient`/`UIAutomationTypes` assemblies — the same two
 * sources `gui-observe-script.ts` uses, extended to the focused-element
 * question the session-stream focus proof (spec §5.3) asks:
 *
 *   "read back *who actually holds focus*" — Windows analog of macOS
 *   `AXFocusedUIElement`/`kAXFocusedWindow`.
 *
 * `read` mode emits one `focus` record:
 *
 *   - `foregroundPid`/`foregroundHwnd`/`threadId` — who owns the
 *     foreground window (`GetForegroundWindow` +
 *     `GetWindowThreadProcessId`).
 *   - `guiFlags`/`hwndActive`/`hwndFocus`/`hwndCaret` — the
 *     `GUITHREADINFO` of the foreground thread: the Win32-level focus
 *     inside that thread.
 *   - `uiaPid`/`uiaControlType`/`uiaName`/`uiaAutomationId`/
 *     `uiaRuntimeId` — `AutomationElement.FocusedElement`, the
 *     element-level identity the contract's `FocusHolder.element`
 *     wants. Absent fields mean UIA could not prove an element —
 *     pid-level focus only, never guessed.
 *   - `sessionId` (ours) vs `focusSessionId` (the focused pid's) +
 *     `sessionMatch` — input only reaches our session's desktop, so a
 *     mismatch means the readback cannot be ours; the TypeScript side
 *     treats it as unproven, never as a match.
 *
 * `set` mode requests focus on the target pid: UIA `SetFocus` pattern
 * on the best-matching element when UIA is available (preferring an
 * `automationId` match, else the first enabled Edit/Text control),
 * falling back to Win32 `SetForegroundWindow` + `SetFocus` on the
 * window itself — window-level focus only, reported as such. A `focus`
 * read record is emitted after the request so the caller sees the
 * resulting holder, not the request's intent.
 *
 * UIPI / integrity note (spec §3.2): `SetForegroundWindow` and UIA
 * `SetFocus` are subject to foreground-lock and integrity rules; a
 * lower-integrity caller may be refused. Whether that happens against
 * AE is UNVERIFIED — there is no Windows host lane. Failures are
 * reported as statuses, never retried.
 *
 * Output contract: newline-delimited JSON records on stdout.
 *
 *   {"type":"meta", ...}
 *   {"type":"focus", ...}     the readback record described above
 *   {"type":"result", ...}    set mode only: FOCUSED / FOREGROUND_ONLY /
 *                             NOT_FOUND / UNVERIFIED / FAILED
 *
 * Embedded as a string constant (repo convention): `dist/` is the only
 * shipped payload.
 */

export type WindowsFocusCommand =
  | { readonly mode: "read" }
  | {
      readonly mode: "set";
      readonly pid: number;
      /** Element hint (UIA AutomationId) when the caller has one. */
      readonly automationId?: string;
    };

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`invalid target pid ${String(pid)}`);
  }
}

/** A single-quoted PowerShell string literal; `'` is escaped as `''`. */
function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function windowsFocusScript(command: WindowsFocusCommand): string {
  const params: string[] = [];
  if (command.mode === "read") {
    params.push(`$script:mode = 'read'`);
  } else {
    assertPid(command.pid);
    params.push(
      `$script:mode = 'set'`,
      `$script:targetPid = ${command.pid}`,
    );
    if (command.automationId !== undefined) {
      if (command.automationId.length > 512) {
        throw new TypeError("automationId exceeds 512 characters");
      }
      params.push(`$script:wantedAutomationId = ${psString(command.automationId)}`);
    }
  }

  return `
${params.join("\n")}
$script:maxWindows = 64

function Write-Record($record) {
  [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 8))
}

function Write-Result($status, $detail) {
  $rec = [ordered]@{ type = 'result'; status = $status }
  if ($null -ne $detail -and [string]$detail -ne '') { $rec.detail = [string]$detail }
  Write-Record $rec
}

# --- Win32 + input P/Invoke --------------------------------------------------
$cs = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AeA8nWin32Focus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
  [DllImport("user32.dll")] public static extern IntPtr GetFocus();
  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO {
    public int cbSize;
    public uint flags;
    public IntPtr hwndActive;
    public IntPtr hwndFocus;
    public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner;
    public IntPtr hwndMoveSize;
    public IntPtr hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
} catch {
  if ($script:mode -eq 'read') {
    Write-Record ([ordered]@{ type = 'focus'; ok = $false; error = ('Add-Type failed: ' + [string]$_.Exception.Message) })
  } else {
    Write-Result 'FAILED' ('Add-Type failed: ' + [string]$_.Exception.Message)
  }
  exit 0
}

# --- UI Automation availability ----------------------------------------------
$script:uiaAvailable = $false
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  $script:uiaAvailable = $true
} catch {}

try { $script:ownSession = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId } catch { $script:ownSession = $null }
$apartment = 'unknown'
try { $apartment = [string][Threading.Thread]::CurrentThread.ApartmentState } catch {}
Write-Record ([ordered]@{ type = 'meta'; sessionId = $script:ownSession; apartment = $apartment })

function Get-ProcessName($procId) {
  if ($null -eq $procId) { return $null }
  try {
    $p = Get-Process -Id ([int]$procId) -ErrorAction Stop
    return [string]$p.ProcessName
  } catch { return $null }
}

function Get-ProcessSession($procId) {
  if ($null -eq $procId) { return $null }
  try {
    $p = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $null }
    return [int]$p.SessionId
  } catch { return $null }
}

function Get-PidWindows($targetPid) {
  $found = New-Object System.Collections.ArrayList
  $cb = [AeA8nWin32Focus+EnumProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $wpid = [uint32]0
    [void][AeA8nWin32Focus]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
    if ([int]$wpid -eq $targetPid -and [AeA8nWin32Focus]::IsWindowVisible($hWnd)) {
      [void]$found.Add($hWnd)
    }
    return $true
  }
  [void][AeA8nWin32Focus]::EnumWindows($cb, [IntPtr]::Zero)
  return $found
}

# Emit the focus readback record. Shared by read mode and the post-set
# readback in set mode — one shape, one meaning.
function Write-FocusRecord {
  $rec = [ordered]@{ type = 'focus'; ok = $true }
  $fg = [AeA8nWin32Focus]::GetForegroundWindow()
  $fgPid = [uint32]0
  $fgTid = 0
  if ($fg -ne [IntPtr]::Zero) {
    $fgTid = [int][AeA8nWin32Focus]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  }
  $rec.foregroundHwnd = $(if ($fg -ne [IntPtr]::Zero) { [string]$fg.ToInt64() } else { $null })
  $rec.foregroundPid = [int]$fgPid
  $rec.threadId = $fgTid

  # GUITHREADINFO on the foreground thread: the Win32-level focus.
  $gui = New-Object AeA8nWin32Focus+GUITHREADINFO
  $gui.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][AeA8nWin32Focus+GUITHREADINFO])
  $guiOk = $false
  try {
    if ($fgTid -ne 0) {
      $guiOk = [AeA8nWin32Focus]::GetGUIThreadInfo([uint32]$fgTid, [ref]$gui)
    }
  } catch { $guiOk = $false }
  if ($guiOk) {
    $rec.guiFlags = [int64]$gui.flags
    $rec.hwndActive = $(if ($gui.hwndActive -ne [IntPtr]::Zero) { [string]$gui.hwndActive.ToInt64() } else { $null })
    $rec.hwndFocus = $(if ($gui.hwndFocus -ne [IntPtr]::Zero) { [string]$gui.hwndFocus.ToInt64() } else { $null })
    $rec.hwndCaret = $(if ($gui.hwndCaret -ne [IntPtr]::Zero) { [string]$gui.hwndCaret.ToInt64() } else { $null })
  } else {
    $rec.guiInfo = $false
  }

  # Element-level identity via UIA FocusedElement — best effort; a
  # control UIA cannot see stays pid-level, which the contract records
  # as weaker proof rather than a failure.
  $uiaPid = $null; $uiaControlType = $null; $uiaName = $null
  $uiaAutomationId = $null; $uiaRuntimeId = $null
  if ($script:uiaAvailable) {
    try {
      $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
      if ($null -ne $focused) {
        $cur = $focused.Current
        try { $uiaPid = [int]$cur.ProcessId } catch {}
        try { $uiaControlType = [string]$cur.ControlType.ProgrammaticName } catch {}
        try {
          $nm = [string]$cur.Name
          if ($nm.Length -gt 512) { $nm = $nm.Substring(0, 512) }
          $uiaName = $nm
        } catch {}
        try {
          $aid = [string]$cur.AutomationId
          if ($aid.Length -gt 512) { $aid = $aid.Substring(0, 512) }
          $uiaAutomationId = $aid
        } catch {}
        try {
          $rid = $focused.GetRuntimeId()
          if ($null -ne $rid) { $uiaRuntimeId = ($rid -join ';') }
        } catch {}
      }
    } catch {}
  }
  $rec.uiaAvailable = [bool]$script:uiaAvailable
  $rec.uiaPid = $uiaPid
  $rec.uiaControlType = $uiaControlType
  $rec.uiaName = $uiaName
  $rec.uiaAutomationId = $uiaAutomationId
  $rec.uiaRuntimeId = $uiaRuntimeId

  # Session honesty: input reaches only our session's desktop. The
  # focused element's pid session must equal ours or the readback
  # cannot describe a holder this helper could type into.
  $focusPid = $null
  if ($null -ne $uiaPid -and $uiaPid -ne 0) { $focusPid = $uiaPid }
  elseif ($fgPid -ne 0) { $focusPid = [int]$fgPid }
  $rec.pid = $focusPid
  $rec.app = Get-ProcessName $focusPid
  $focusSession = Get-ProcessSession $focusPid
  $rec.focusSessionId = $focusSession
  $rec.sessionId = $script:ownSession
  if ($null -ne $focusSession -and $null -ne $script:ownSession) {
    $rec.sessionMatch = ($focusSession -eq $script:ownSession)
  } else {
    $rec.sessionMatch = $null
  }
  Write-Record $rec
}

if ($script:mode -eq 'read') {
  Write-FocusRecord
  exit 0
}

# --- set mode -----------------------------------------------------------------
$targets = Get-PidWindows $script:targetPid
if ($targets.Count -eq 0) {
  Write-Result 'NOT_FOUND' ("no visible top-level window for pid " + $script:targetPid)
  exit 0
}

$h = $null
$method = $null
$detail = $null

if ($script:uiaAvailable) {
  # UIA SetFocus on the best-matching element inside the pid's first
  # window. Element match order: exact AutomationId, then first enabled
  # Edit/Text control (the shape a text-input target has).
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  foreach ($candidate in $targets) {
    $root = $null
    try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($candidate) } catch { $root = $null }
    if ($null -eq $root) { continue }
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@{ el = $root; depth = 0 })
    $count = 0
    $fallback = $null
    $chosen = $null
    while ($queue.Count -gt 0 -and $count -lt 300) {
      $item = $queue.Dequeue()
      $node = $item.el
      $depth = [int]$item.depth
      $child = $null
      try { $child = $walker.GetFirstChild($node) } catch { $child = $null }
      while ($null -ne $child -and $count -lt 300) {
        $count++
        $next = $null
        try {
          $cc = $child.Current
          $ct = [string]$cc.ControlType.ProgrammaticName
          $enabled = $false
          try { $enabled = [bool]$cc.IsEnabled } catch {}
          if ($enabled -and ($ct -eq 'ControlType.Edit' -or $ct -eq 'ControlType.Text' -or $ct -eq 'ControlType.Document')) {
            if ($null -eq $fallback) { $fallback = $child }
            if ($script:wantedAutomationId -and [string]$cc.AutomationId -eq [string]$script:wantedAutomationId) {
              $chosen = $child
              break
            }
          }
          if ($depth -lt 6) { $queue.Enqueue(@{ el = $child; depth = ($depth + 1) }) }
        } catch {}
        if ($null -ne $chosen) { break }
        try { $next = $walker.GetNextSibling($child) } catch { $next = $null }
        $child = $next
      }
      if ($null -ne $chosen) { break }
    }
    $target = $chosen
    if ($null -eq $target) { $target = $fallback }
    if ($null -ne $target) {
      try {
        $pat = $target.GetCurrentPattern([System.Windows.Automation.FocusPattern]::Pattern)
        if ($null -ne $pat) {
          $pat.SetFocus()
          $h = $candidate
          $method = 'uia-setfocus'
          if ($null -ne $chosen) { $detail = 'matched automationId' }
          elseif ($null -ne $fallback) { $detail = 'first enabled text control (pid-level proof only)' }
          break
        }
      } catch {
        $detail = ('SetFocus threw: ' + [string]$_.Exception.Message)
      }
    }
  }
}

if ($null -eq $h) {
  # Win32 fallback: foreground the window and SetFocus its hwnd. This
  # proves window-level focus at best — element identity stays
  # unproven and the result says so.
  $h = $targets[0]
  try {
    [void][AeA8nWin32Focus]::SetForegroundWindow($h)
    [void][AeA8nWin32Focus]::SetFocus($h)
    $method = 'win32-foreground'
    if ($null -eq $detail) { $detail = 'window-level focus only; element identity unproven' }
  } catch {
    Write-Result 'FAILED' ('foreground/focus request failed: ' + [string]$_.Exception.Message)
    exit 0
  }
}

$status = $(if ($method -eq 'uia-setfocus') { 'FOCUSED' } else { 'FOREGROUND_ONLY' })
Write-Result $status $detail
# Post-request readback: the caller sees who actually holds focus now,
# not what we asked for (spec §5.3 step ordering).
Write-FocusRecord
`;
}
