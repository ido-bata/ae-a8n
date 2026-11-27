/**
 * The PowerShell SendInput posting script for Windows OS-level input
 * (#373, `specs/ime-input/spec.md` §6–§7, parent #344 / program #337).
 *
 * Vehicle decision (recorded for the PR): Windows PowerShell 5.1
 * (`powershell.exe`, inbox on every supported Windows 11 host) driving
 * Win32 `SendInput` via `Add-Type` P/Invoke — the same vehicle family as
 * `gui-observe-script.ts` / `gui-act-script.ts`. No npm dependency, no
 * native binary, no installer. The script runs as a child of the
 * ae-a8n agent, which lives inside the interactive session it may
 * mutate, so it lands on this session's desktop by construction — the
 * same session-scoping argument `gui-act-script.ts` documents. Windows
 * has no `launchctl asuser` equivalent; entering another session is not
 * possible from this vehicle.
 *
 * Two delivery channels are kept explicitly distinct (spec §4.2):
 *
 *   - `vk` / `scan` events post virtual-key or scan-code input. This is
 *     the path that traverses the normal input pipeline — TSF and an
 *     installed IME see it, so per-character VK events are the
 *     Tier-1b (OS IME) candidate channel.
 *   - `unicode` events post `KEYEVENTF_UNICODE` UTF-16 code units. This
 *     is the direct/bulk `type-direct` channel: it bypasses the IME by
 *     design and is therefore NEVER IME evidence. Callers must label it
 *     `direct-entry`.
 *
 * The event list is supplied by the TypeScript caller as base64-encoded
 * UTF-8 JSON, so nothing a text payload contains can become script —
 * the same no-interpolation discipline `gui-act-script.ts` follows for
 * titles and labels.
 *
 * UIPI / integrity-level note (spec §3.2, issue #373): `SendInput`
 * delivers through the session-wide input stream and is subject to
 * User Interface Privilege Isolation — a lower-integrity target can
 * refuse injected input, and a higher-integrity caller is required to
 * reach elevated surfaces. Whether AE's windows sit at an integrity
 * level this helper can reach is UNSTUDIED and UNVERIFIED: there is no
 * Windows host lane yet, so nothing here claims delivery works. The
 * `result` record's `modifiers` field is best-effort evidence of held
 * modifier keys read back via `GetAsyncKeyState` after posting; it is
 * for cleanup/audit correlation, not proof of delivery.
 *
 * Output contract: newline-delimited JSON records on stdout.
 *
 *   {"type":"meta", ...}     own session id + timestamp
 *   {"type":"result", ...}   POSTED / PARTIAL / FAILED + counts + modifiers
 *
 * The script is embedded as a string constant (repo convention for
 * Windows helpers) rather than a `.ps1` file: `dist/` is the only
 * shipped payload, so an inlined script cannot go missing from a packed
 * install and cannot drift from the TypeScript that interprets it.
 */

/** One key event in the batch. Exactly one of vk / scan / unicode applies. */
export type WindowsInputSendKeyEvent = {
  readonly type: "key";
  readonly action: "down" | "up";
  /** Virtual-key code (1-255). Ignored when `unicode` is set. */
  readonly vk?: number;
  /** Scan code (0-255). When set, KEYEVENTF_SCANCODE replaces the VK path. */
  readonly scan?: number;
  /**
   * One UTF-16 code unit posted via KEYEVENTF_UNICODE — the
   * IME-bypassing direct-entry channel. Never Tier-1b evidence.
   */
  readonly unicode?: string;
  /** KEYEVENTF_EXTENDEDKEY for keys that need the E0 prefix (arrows, …). */
  readonly extended?: boolean;
};

export type WindowsInputMouseButton = "left" | "right" | "middle";

/** One mouse event in the batch. Coordinates are screen pixels. */
export type WindowsInputSendMouseEvent = {
  readonly type: "mouse";
  readonly action: "move" | "down" | "up" | "wheel";
  /** Pixel coordinates; required for move/down/up, optional for wheel. */
  readonly x?: number;
  readonly y?: number;
  readonly button?: WindowsInputMouseButton;
  /**
   * Wheel delta in WHEEL_DELTA units (120 per notch): positive scrolls
   * up/away, negative down/toward — the Win32 convention.
   */
  readonly wheelDelta?: number;
};

export type WindowsInputSendEvent = WindowsInputSendKeyEvent | WindowsInputSendMouseEvent;

/** The whole batch is posted in one SendInput call — atomic per call. */
export type WindowsInputSendCommand = {
  readonly events: readonly WindowsInputSendEvent[];
};

function assertInt(value: number, what: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`invalid ${what} ${String(value)} (expected integer ${min}..${max})`);
  }
}

const MAX_EVENTS = 4096;
const MAX_MOUSE_COORD = 32767;

/**
 * Validate the command and render it as the base64 payload the script
 * decodes. Throws TypeError on anything malformed — validation happens
 * before a single character of script is produced.
 */
export function encodeWindowsInputSendEvents(command: WindowsInputSendCommand): string {
  const events = command.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError("input send requires at least one event");
  }
  if (events.length > MAX_EVENTS) {
    throw new TypeError(`input send batch of ${events.length} exceeds the ${MAX_EVENTS} event cap`);
  }
  const normalized: unknown[] = [];
  // Array.isArray narrows the readonly array to any[]; the cast restores
  // the declared element type while every field is still validated below.
  for (const event of events as readonly WindowsInputSendEvent[]) {
    if (event.type === "key") {
      if (event.action !== "down" && event.action !== "up") {
        throw new TypeError(`invalid key action ${String(event.action)}`);
      }
      const channels = [event.vk !== undefined, event.scan !== undefined, event.unicode !== undefined]
        .filter(Boolean).length;
      if (channels !== 1) {
        throw new TypeError(
          "a key event must name exactly one of vk, scan or unicode",
        );
      }
      if (event.vk !== undefined) assertInt(event.vk, "vk", 1, 255);
      if (event.scan !== undefined) assertInt(event.scan, "scan", 0, 255);
      if (event.unicode !== undefined) {
        if (typeof event.unicode !== "string" || event.unicode.length !== 1) {
          throw new TypeError(
            "unicode events carry exactly one UTF-16 code unit (the " +
              "IME-bypassing KEYEVENTF_UNICODE channel)",
          );
        }
        if (event.unicode.charCodeAt(0) === 0) {
          throw new TypeError("unicode events cannot carry a NUL code unit");
        }
      }
      normalized.push({
        t: "key",
        a: event.action === "down" ? 1 : 0,
        vk: event.vk ?? 0,
        scan: event.scan ?? -1,
        // u is the UTF-16 code unit for KEYEVENTF_UNICODE events and 0
        // otherwise; the PowerShell side treats u > 0 as the unicode
        // (IME-bypassing) channel and everything else as the VK/scan
        // (IME-path) channel. A literal NUL unicode unit is rejected
        // upstream as a degenerate payload.
        u: event.unicode === undefined ? 0 : event.unicode.charCodeAt(0),
        ext: event.extended === true ? 1 : 0,
      });
      continue;
    }
    if (event.type === "mouse") {
      if (event.action !== "move" && event.action !== "down" && event.action !== "up" && event.action !== "wheel") {
        throw new TypeError(`invalid mouse action ${String(event.action)}`);
      }
      if (event.x !== undefined) assertInt(event.x, "mouse x", -MAX_MOUSE_COORD, MAX_MOUSE_COORD);
      if (event.y !== undefined) assertInt(event.y, "mouse y", -MAX_MOUSE_COORD, MAX_MOUSE_COORD);
      if (event.action !== "wheel" && (event.x === undefined || event.y === undefined)) {
        throw new TypeError("mouse move/down/up requires x and y pixel coordinates");
      }
      if ((event.action === "down" || event.action === "up") && event.button === undefined) {
        throw new TypeError("mouse down/up requires a button");
      }
      if (event.wheelDelta !== undefined) {
        assertInt(event.wheelDelta, "wheelDelta", -1000, 1000);
      }
      normalized.push({
        t: "mouse",
        a: event.action,
        // null preserves "no coordinates" (wheel posts at the current
        // cursor position; the caller pairs it with a move when the
        // target point matters).
        x: event.x === undefined ? null : event.x,
        y: event.y === undefined ? null : event.y,
        b: event.button ?? "",
        w: event.wheelDelta ?? 0,
      });
      continue;
    }
    throw new TypeError(`unknown input event type ${String((event as { type?: unknown }).type)}`);
  }
  return Buffer.from(JSON.stringify(normalized), "utf8").toString("base64");
}

/**
 * Build the posting script for one batch. The batch travels as
 * base64-encoded JSON so text payloads can never become script.
 */
export function windowsInputSendScript(eventsBase64: string): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(eventsBase64) || eventsBase64.length === 0) {
    throw new TypeError("events payload must be non-empty base64");
  }
  return `
$ErrorActionPreference = 'Continue'
$script:eventsB64 = '${eventsBase64}'

function Write-Record($record) {
  [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 8))
}

function Write-Result($status, $detail) {
  $rec = [ordered]@{ type = 'result'; status = $status }
  if ($null -ne $detail -and [string]$detail -ne '') { $rec.detail = [string]$detail }
  Write-Record $rec
}

# --- Win32 input P/Invoke --------------------------------------------------
$cs = @'
using System;
using System.Runtime.InteropServices;
public static class AeA8nWin32Input {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION u;
  }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
'@

try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
} catch {
  # Infrastructure failed before any input could be sent.
  Write-Result 'FAILED' ('Add-Type failed: ' + [string]$_.Exception.Message)
  exit 0
}

try { $script:ownSession = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId } catch { $script:ownSession = $null }
Write-Record ([ordered]@{ type = 'meta'; sessionId = $script:ownSession })

try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($script:eventsB64))
  $events = @($json | ConvertFrom-Json)
} catch {
  Write-Result 'FAILED' ('event payload decode failed: ' + [string]$_.Exception.Message)
  exit 0
}
if ($events.Count -eq 0) {
  Write-Result 'FAILED' 'empty event batch'
  exit 0
}

# INPUT.type values: 1 = keyboard, 0 = mouse.
$INPUT_MOUSE = 0
$INPUT_KEYBOARD = 1
$KEYEVENTF_EXTENDEDKEY = 0x0001
$KEYEVENTF_KEYUP = 0x0002
$KEYEVENTF_UNICODE = 0x0004
$KEYEVENTF_SCANCODE = 0x0008
$MOUSEEVENTF_MOVE = 0x0001
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_RIGHTDOWN = 0x0008
$MOUSEEVENTF_RIGHTUP = 0x0010
$MOUSEEVENTF_MIDDLEDOWN = 0x0020
$MOUSEEVENTF_MIDDLEUP = 0x0040
$MOUSEEVENTF_WHEEL = 0x0800
$MOUSEEVENTF_ABSOLUTE = 0x8000
$WHEEL_DELTA = 120

$screenW = [AeA8nWin32Input]::GetSystemMetrics(0)   # SM_CXSCREEN
$screenH = [AeA8nWin32Input]::GetSystemMetrics(1)   # SM_CYSCREEN
if ($screenW -le 1) { $screenW = 1 }
if ($screenH -le 1) { $screenH = 1 }

# Pixel -> SendInput absolute coordinates (0..65535 over the primary
# screen). Multi-monitor absolute posting needs MOUSEEVENTF_VIRTUALDESK
# and is a later refinement; primary-screen normalization is what the
# contract's "coordinates from the re-verified element frame" feeds.
function ConvertTo-Absolute($x, $y) {
  $ax = [int][Math]::Round(($x * 65535.0) / ($screenW - 1))
  $ay = [int][Math]::Round(($y * 65535.0) / ($screenH - 1))
  if ($ax -lt 0) { $ax = 0 }; if ($ax -gt 65535) { $ax = 65535 }
  if ($ay -lt 0) { $ay = 0 }; if ($ay -gt 65535) { $ay = 65535 }
  return @($ax, $ay)
}

$inputs = New-Object 'AeA8nWin32Input+INPUT[]' $events.Count
$built = 0
$pendingMove = $null
foreach ($ev in $events) {
  $item = New-Object AeA8nWin32Input+INPUT
  if ($ev.t -eq 'key') {
    $item.type = $INPUT_KEYBOARD
    $ki = New-Object AeA8nWin32Input+KEYBDINPUT
    $flags = 0
    # a is 1 for key-down and 0 for key-up (see encodeWindowsInputSendEvents).
    if ([int]$ev.a -eq 0) { $flags = $flags -bor $KEYEVENTF_KEYUP }
    if ([int]$ev.ext -eq 1) { $flags = $flags -bor $KEYEVENTF_EXTENDEDKEY }
    if ([int]$ev.u -gt 0) {
      # KEYEVENTF_UNICODE: the code unit travels in wScan, vk stays 0.
      # This bypasses the IME — direct-entry only, never Tier-1b.
      $flags = $flags -bor $KEYEVENTF_UNICODE
      $ki.wVk = 0
      $ki.wScan = [uint16]([int]$ev.u)
    } elseif ([int]$ev.scan -ge 0) {
      $flags = $flags -bor $KEYEVENTF_SCANCODE
      $ki.wVk = 0
      $ki.wScan = [uint16]([int]$ev.scan)
    } else {
      $ki.wVk = [uint16]([int]$ev.vk)
      $ki.wScan = 0
    }
    $ki.dwFlags = [uint32]$flags
    $ki.time = 0
    $ki.dwExtraInfo = [IntPtr]::Zero
    $item.u.ki = $ki
    $inputs[$built] = $item
    $built++
    continue
  }
  # mouse
  $item.type = $INPUT_MOUSE
  $mi = New-Object AeA8nWin32Input+MOUSEINPUT
  $mi.time = 0
  $mi.dwExtraInfo = [IntPtr]::Zero
  $mi.mouseData = 0
  $flags = 0
  $ax = 0; $ay = 0
  if ($null -ne $ev.x -and $null -ne $ev.y -and [string]$ev.a -ne 'wheel') {
    $xy = ConvertTo-Absolute ([int]$ev.x) ([int]$ev.y)
    $ax = $xy[0]; $ay = $xy[1]
    $flags = $flags -bor $MOUSEEVENTF_ABSOLUTE
  }
  switch ([string]$ev.a) {
    'move'   { $flags = $flags -bor $MOUSEEVENTF_MOVE }
    'down'   {
      $flags = $flags -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_MOVE
      switch ([string]$ev.b) {
        'right'  { $flags = $flags -bor $MOUSEEVENTF_RIGHTDOWN }
        'middle' { $flags = $flags -bor $MOUSEEVENTF_MIDDLEDOWN }
        default  { $flags = $flags -bor $MOUSEEVENTF_LEFTDOWN }
      }
    }
    'up'     {
      $flags = $flags -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_MOVE
      switch ([string]$ev.b) {
        'right'  { $flags = $flags -bor $MOUSEEVENTF_RIGHTUP }
        'middle' { $flags = $flags -bor $MOUSEEVENTF_MIDDLEUP }
        default  { $flags = $flags -bor $MOUSEEVENTF_LEFTUP }
      }
    }
    'wheel'  {
      # Wheel input lands on whatever is under the cursor; dx/dy are
      # ignored for wheel events, so a scroll that must hit a point is
      # posted as a move + wheel pair by the caller.
      $flags = $flags -bor $MOUSEEVENTF_WHEEL
      $mi.mouseData = [uint32]([int]$ev.w * $WHEEL_DELTA)
    }
  }
  $mi.dx = [int]$ax
  $mi.dy = [int]$ay
  $mi.dwFlags = [uint32]$flags
  $item.u.mi = $mi
  $inputs[$built] = $item
  $built++
}

$sent = 0
try {
  $sent = [int][AeA8nWin32Input]::SendInput([uint32]$built, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][AeA8nWin32Input+INPUT]))
} catch {
  Write-Result 'FAILED' ('SendInput threw: ' + [string]$_.Exception.Message)
  exit 0
}

# Modifier readback for cleanup/audit correlation: GetAsyncKeyState's high
# bit reports a key currently down, including keys this batch just
# injected. Best-effort evidence — it does not prove delivery reached a
# target, only what the input stream state looks like afterwards.
$modifiers = @()
foreach ($pair in @(
  @(0x10, 'shift'), @(0x11, 'ctrl'), @(0x12, 'alt'),
  @(0x5B, 'lwin'), @(0x5C, 'rwin'))) {
  try {
    $state = [AeA8nWin32Input]::GetAsyncKeyState([int]$pair[0])
    if (($state -band 0x8000) -ne 0) { $modifiers += [string]$pair[1] }
  } catch {}
}

if ($sent -eq $built) {
  Write-Record ([ordered]@{ type = 'result'; status = 'POSTED'; sent = $sent; expected = $built; modifiers = @($modifiers) })
} elseif ($sent -gt 0) {
  # Partial injection: some events landed, some did not. This is
  # indeterminate evidence — the caller must re-observe, never resend
  # blindly (UNKNOWN non-resend, spec §5.5).
  Write-Record ([ordered]@{ type = 'result'; status = 'PARTIAL'; sent = $sent; expected = $built; modifiers = @($modifiers) })
} else {
  Write-Record ([ordered]@{ type = 'result'; status = 'FAILED'; sent = 0; expected = $built; modifiers = @($modifiers); detail = 'SendInput accepted none of the events (UIPI/integrity or focus loss are candidates — unverified)' })
}
`;
}
