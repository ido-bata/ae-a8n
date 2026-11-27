/**
 * The PowerShell clipboard helper for Windows shared-state input
 * (#373, `specs/ime-input/spec.md` §5.5/§6, parent #344 / program #337).
 *
 * Vehicle decision (recorded for the PR): Windows PowerShell 5.1
 * (`powershell.exe`) driving the Win32 clipboard API through `Add-Type`
 * P/Invoke — same vehicle family as `gui-observe-script.ts` /
 * `gui-act-script.ts` / `input-send-script.ts`. `Get-Clipboard` /
 * `Set-Clipboard` were rejected: they only see `CF_UNICODETEXT`, hide
 * the format list the save/restore contract needs, and their encoding
 * behavior differs between PS 5.1 and PS 7. The P/Invoke path reads and
 * writes the clipboard exactly as the OS stores it.
 *
 * Honesty boundaries (spec §5.5, §6):
 *
 *   - The clipboard is user-global shared state. Every write is the
 *     caller's responsibility to bracket with a prior-state snapshot;
 *     this script only reads or writes what it is told.
 *   - `read` reports every registered clipboard format by id and the
 *     text payload when a text format exists. Non-text flavors
 *     (bitmaps, file drops, private formats) are *named*, never
 *     captured — restoring them is out of this helper's contract, and
 *     the TypeScript adapter records that limitation in the snapshot.
 *   - `write` replaces the clipboard with `CF_UNICODETEXT` only. A
 *     restore through this helper therefore restores text, not the
 *     original flavor set; the audit record must not claim otherwise.
 *
 * The text payload travels as base64-encoded UTF-8 JSON so nothing it
 * contains can become script — same discipline as the send helper.
 *
 * Output contract: newline-delimited JSON records on stdout.
 *
 *   {"type":"meta", ...}     own session id
 *   read:  {"type":"clipboard", ok, formats, text, textBytes, error?}
 *   write: {"type":"result", status:"WRITTEN"|"FAILED", formats, detail?}
 *
 * Embedded as a string constant (repo convention): `dist/` is the only
 * shipped payload.
 */

export type WindowsClipboardCommand =
  | { readonly mode: "read" }
  | { readonly mode: "write"; readonly text: string };

/** Encode the write payload; read carries no payload. */
export function encodeWindowsClipboardCommand(command: WindowsClipboardCommand): {
  readonly mode: "read" | "write";
  readonly payloadB64: string | null;
} {
  if (command.mode === "read") {
    return { mode: "read", payloadB64: null };
  }
  if (typeof command.text !== "string") {
    throw new TypeError("clipboard write requires a string payload");
  }
  if (command.text.length > 4 * 1024 * 1024) {
    throw new TypeError("clipboard write payload exceeds the 4 MiB cap");
  }
  return {
    mode: "write",
    payloadB64: Buffer.from(JSON.stringify({ text: command.text }), "utf8").toString("base64"),
  };
}

export function windowsClipboardScript(command: WindowsClipboardCommand): string {
  const encoded = encodeWindowsClipboardCommand(command);
  const payloadLine =
    encoded.payloadB64 === null
      ? "$script:payloadB64 = $null"
      : `$script:payloadB64 = '${encoded.payloadB64}'`;
  return `
$ErrorActionPreference = 'Continue'
$script:mode = '${encoded.mode}'
${payloadLine}

function Write-Record($record) {
  [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 8))
}

function Write-Result($status, $detail) {
  $rec = [ordered]@{ type = 'result'; status = $status }
  if ($null -ne $detail -and [string]$detail -ne '') { $rec.detail = [string]$detail }
  Write-Record $rec
}

# --- Win32 clipboard P/Invoke ------------------------------------------------
$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AeA8nClipboard {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool OpenClipboard(IntPtr hWndNewOwner);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool CloseClipboard();
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool EmptyClipboard();
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetClipboardData(uint uFormat);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint EnumClipboardFormats(uint format);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint RegisterClipboardFormat(string lpszFormat);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GlobalLock(IntPtr hMem);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GlobalUnlock(IntPtr hMem);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern UIntPtr GlobalSize(IntPtr hMem);

  public const uint CF_TEXT = 1;
  public const uint CF_UNICODETEXT = 13;
  public const uint GMEM_MOVEABLE = 0x0002;

  // Retry OpenClipboard: another process may hold it briefly. Bounded —
  // a clipboard that stays busy is reported, never spun on forever.
  public static bool OpenClipboardWithRetry(int attempts, int delayMs) {
    for (int i = 0; i < attempts; i++) {
      if (OpenClipboard(IntPtr.Zero)) return true;
      System.Threading.Thread.Sleep(delayMs);
    }
    return false;
  }

  public static string FormatName(uint format) {
    switch (format) {
      case 1: return "CF_TEXT";
      case 2: return "CF_BITMAP";
      case 3: return "CF_METAFILEPICT";
      case 8: return "CF_DIB";
      case 9: return "CF_PALETTE";
      case 13: return "CF_UNICODETEXT";
      case 14: return "CF_ENHMETAFILE";
      case 15: return "CF_HDROP";
      case 16: return "CF_LOCALE";
      case 17: return "CF_DIBV5";
      default: return "format-" + format;
    }
  }

  public static List<uint> ListFormats() {
    var list = new List<uint>();
    uint fmt = 0;
    while (true) {
      fmt = EnumClipboardFormats(fmt);
      if (fmt == 0) break;
      list.Add(fmt);
      if (list.Count >= 256) break;
    }
    return list;
  }

  public static string ReadUnicodeText() {
    IntPtr h = GetClipboardData(CF_UNICODETEXT);
    if (h == IntPtr.Zero) return null;
    IntPtr p = GlobalLock(h);
    if (p == IntPtr.Zero) return null;
    try {
      return Marshal.PtrToStringUni(p);
    } finally {
      GlobalUnlock(h);
    }
  }

  public static string ReadAnsiText() {
    IntPtr h = GetClipboardData(CF_TEXT);
    if (h == IntPtr.Zero) return null;
    IntPtr p = GlobalLock(h);
    if (p == IntPtr.Zero) return null;
    try {
      // CF_TEXT is NUL-terminated ANSI in the system code page; read up
      // to the first NUL without trusting a length prefix.
      int max = 1024 * 1024;
      var bytes = new byte[max];
      int n = 0;
      while (n < max) {
        byte b = Marshal.ReadByte(p, n);
        if (b == 0) break;
        bytes[n] = b;
        n++;
      }
      return Encoding.Default.GetString(bytes, 0, n);
    } finally {
      GlobalUnlock(h);
    }
  }

  public static uint TextDataBytes() {
    IntPtr h = GetClipboardData(CF_UNICODETEXT);
    if (h == IntPtr.Zero) h = GetClipboardData(CF_TEXT);
    if (h == IntPtr.Zero) return 0;
    return (uint)GlobalSize(h).ToUInt32();
  }

  // SetClipboardData takes ownership of the HGLOBAL on success; on
  // failure the caller must free it. Returns true when the format was
  // registered with the clipboard.
  public static bool WriteUnicodeText(string text) {
    byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
    IntPtr h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes.Length);
    if (h == IntPtr.Zero) return false;
    IntPtr p = GlobalLock(h);
    if (p == IntPtr.Zero) { return false; }
    try {
      Marshal.Copy(bytes, 0, p, bytes.Length);
    } finally {
      GlobalUnlock(h);
    }
    if (!SetClipboardData(CF_UNICODETEXT, h)) {
      return false;
    }
    return true;
  }
}
'@

try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
} catch {
  if ($script:mode -eq 'read') {
    Write-Record ([ordered]@{ type = 'clipboard'; ok = $false; error = ('Add-Type failed: ' + [string]$_.Exception.Message) })
  } else {
    Write-Result 'FAILED' ('Add-Type failed: ' + [string]$_.Exception.Message)
  }
  exit 0
}

try { $script:ownSession = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId } catch { $script:ownSession = $null }
Write-Record ([ordered]@{ type = 'meta'; sessionId = $script:ownSession })

if ($script:mode -eq 'read') {
  try {
    if (-not [AeA8nClipboard]::OpenClipboardWithRetry(20, 50)) {
      Write-Record ([ordered]@{ type = 'clipboard'; ok = $false; error = 'OpenClipboard stayed busy' })
      exit 0
    }
    try {
      $formats = @()
      foreach ($f in [AeA8nClipboard]::ListFormats()) {
        $formats += [ordered]@{ id = [int64]$f; name = [AeA8nClipboard]::FormatName($f) }
      }
      $text = [AeA8nClipboard]::ReadUnicodeText()
      if ($null -eq $text) { $text = [AeA8nClipboard]::ReadAnsiText() }
      $hasText = ($null -ne $text)
      $rec = [ordered]@{
        type = 'clipboard'
        ok = $true
        empty = (-not $hasText -and $formats.Count -eq 0)
        formats = @($formats)
        text = $(if ($hasText) { $text } else { $null })
        textBytes = [uint64][AeA8nClipboard]::TextDataBytes()
      }
      Write-Record $rec
    } finally {
      [void][AeA8nClipboard]::CloseClipboard()
    }
  } catch {
    Write-Record ([ordered]@{ type = 'clipboard'; ok = $false; error = [string]$_.Exception.Message })
  }
  exit 0
}

# write mode
try {
  $text = $null
  if ($null -ne $script:payloadB64) {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($script:payloadB64))
    $text = [string]($json | ConvertFrom-Json).text
  }
  if ($null -eq $text) { throw 'write payload missing or undecodable' }
  if (-not [AeA8nClipboard]::OpenClipboardWithRetry(20, 50)) {
    Write-Result 'FAILED' 'OpenClipboard stayed busy'
    exit 0
  }
  try {
    if (-not [AeA8nClipboard]::EmptyClipboard()) {
      Write-Result 'FAILED' 'EmptyClipboard failed'
      exit 0
    }
    if (-not [AeA8nClipboard]::WriteUnicodeText($text)) {
      Write-Result 'FAILED' 'SetClipboardData(CF_UNICODETEXT) failed'
      exit 0
    }
  } finally {
    [void][AeA8nClipboard]::CloseClipboard()
  }
  # Only the text flavor is restored by this helper; the audit record
  # must not claim non-text flavors came back.
  Write-Record ([ordered]@{ type = 'result'; status = 'WRITTEN'; formats = @('CF_UNICODETEXT') })
} catch {
  Write-Result 'FAILED' ([string]$_.Exception.Message)
}
`;
}
