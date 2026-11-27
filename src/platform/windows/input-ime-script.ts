/**
 * The PowerShell TSF input-method helper for Windows (#373,
 * `specs/ime-input/spec.md` §6–§7, parent #344 / program #337).
 *
 * Vehicle decision (recorded for the PR): Windows PowerShell 5.1
 * (`powershell.exe`) driving the Text Services Framework through a
 * small embedded C# interop layer (`Add-Type`) — the "PowerShell COM
 * interop or small C# helper" the spec's capability matrix names for
 * `ITfInputProcessorProfileMgr`. No npm dependency, no native binary.
 *
 * What it does:
 *
 *   - `query`    — `GetActiveProfile(GUID_TFCAT_TIP_KEYBOARD)`: the
 *                  current input processor profile (the "IME mode").
 *   - `list`     — `EnumProfiles(langid)`: the profiles registered for
 *                  a language. An empty list is the honest "no Japanese
 *                  IME installed" answer — `unavailable`/`needs-human`,
 *                  never a failure (spec §6 ime-mode row).
 *   - `activate` — `ActivateProfile(TF_PROFILETYPE_INPUTPROCESSOR, …)`
 *                  for a caller-named clsid+guidProfile+langid.
 *   - `deactivate` — `DeactivateProfile` on whatever profile `query`
 *                  reports active; the restore path for a prior mode of
 *                  "none".
 *
 * Interface/IID values come from the Windows SDK `msctf.idl` contract
 * (ReactOS mirror verified): CLSID_TF_InputProcessorProfiles
 * 33c53a50-…, IID_ITfInputProcessorProfileMgr 71c6e74c-…, and the
 * vtable order of every ComImport interface below matches the IDL —
 * a wrong order would silently call the wrong method, so the order is
 * copied verbatim and commented.
 *
 * Honesty boundaries:
 *
 *   - Activating a profile is user-global shared state (spec §5.1
 *     `shared-state`): the caller must bracket it with a prior-mode
 *     snapshot and restore. This script performs exactly the one
 *     operation it is told; it does not save or restore anything.
 *   - `TF_IPPMF_FORPROCESS | TF_IPPMF_FORSESSION` (0x3) is used so the
 *     profile applies to this process and the desktop session. The
 *     registry-persistent `TF_IPPMF_ENABLEPROFILE` flag is deliberately
 *     NOT set — enabling a profile permanently is a bigger mutation
 *     than this helper's contract covers.
 *   - NOTHING here is verified on a real host: there is no Windows
 *     lane. Whether CoCreateInstance succeeds under the agent's
 *     apartment, whether ActivateProfile reaches TSF the way a user
 *     switching input methods does, and whether an IME actually
 *     composes afterwards are all UNVERIFIED. Failure HRESULTs are
 *     reported verbatim, never translated into success.
 *
 * Output contract: newline-delimited JSON records on stdout.
 *
 *   {"type":"meta", ...}          session id + COM apartment state
 *   {"type":"ime-active", ...}    query result (found flag + profile)
 *   {"type":"ime-profile", ...}   one per enumerated profile (list)
 *   {"type":"result", ...}        ACTIVATED / DEACTIVATED / *_FAILED /
 *                                 UNAVAILABLE / NOT_FOUND + hr
 *
 * Parameters cross as validated integers/quoted literals — GUIDs are
 * regex-validated in TypeScript before interpolation.
 */

export type WindowsImeCommand =
  | { readonly mode: "query" }
  | { readonly mode: "list"; readonly langid: number }
  | {
      readonly mode: "activate";
      readonly langid: number;
      readonly clsid: string;
      readonly guidProfile: string;
    }
  | { readonly mode: "deactivate" };

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function assertLangid(langid: number): void {
  if (!Number.isInteger(langid) || langid < 0 || langid > 0xffff) {
    throw new TypeError(`invalid LANGID ${String(langid)} (expected 0..0xffff)`);
  }
}

function assertGuid(value: string, what: string): void {
  if (typeof value !== "string" || !GUID_RE.test(value)) {
    throw new TypeError(`invalid ${what} GUID ${String(value)}`);
  }
}

/**
 * Build the IME script for one command. Throws TypeError on malformed
 * input before any script text exists.
 */
export function windowsImeScript(command: WindowsImeCommand): string {
  const params: string[] = [];
  switch (command.mode) {
    case "query":
    case "deactivate":
      params.push(`$script:mode = '${command.mode}'`);
      break;
    case "list":
      assertLangid(command.langid);
      params.push(
        `$script:mode = 'list'`,
        `$script:langid = ${command.langid}`,
      );
      break;
    case "activate":
      assertLangid(command.langid);
      assertGuid(command.clsid, "clsid");
      assertGuid(command.guidProfile, "guidProfile");
      params.push(
        `$script:mode = 'activate'`,
        `$script:langid = ${command.langid}`,
        `$script:clsid = '${command.clsid}'`,
        `$script:guidProfile = '${command.guidProfile}'`,
      );
      break;
  }

  return `
${params.join("\n")}
$script:maxProfiles = 512

function Write-Record($record) {
  [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 8))
}

function Write-Result($status, $detail, $hr) {
  $rec = [ordered]@{ type = 'result'; status = $status }
  if ($null -ne $detail -and [string]$detail -ne '') { $rec.detail = [string]$detail }
  if ($null -ne $hr) { $rec.hr = ('0x{0:X8}' -f [uint32]$hr) }
  Write-Record $rec
}

# --- TSF interop --------------------------------------------------------------
# CLSID_TF_InputProcessorProfiles (msctf_classes.idl) and the vtable-order-
# exact ComImport interfaces from msctf.idl. Method order is the COM
# contract: reordering silently binds the wrong vtable slot.
$cs = @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct TF_INPUTPROCESSORPROFILE {
  public uint dwProfileType;
  public ushort langid;
  public Guid clsid;
  public Guid guidProfile;
  public Guid catid;
  public IntPtr hklSubstitute;
  public uint dwCaps;
  public IntPtr hkl;
  public uint dwFlags;
}

[ComImport, Guid("71C6E74D-0F28-11D8-A82A-00065B84435C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IEnumTfInputProcessorProfiles {
  [PreserveSig] int Clone(out IEnumTfInputProcessorProfiles ppEnum);
  [PreserveSig] int Next(uint ulCount, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] TF_INPUTPROCESSORPROFILE[] pProfile, out uint pcFetch);
  [PreserveSig] int Reset();
  [PreserveSig] int Skip(uint ulCount);
}

[ComImport, Guid("71C6E74C-0F28-11D8-A82A-00065B84435C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ITfInputProcessorProfileMgr {
  // vtable order per msctf.idl — do not reorder.
  [PreserveSig] int ActivateProfile(uint dwProfileType, ushort langid, ref Guid clsid, ref Guid guidProfile, IntPtr hkl, uint dwFlags);
  [PreserveSig] int DeactivateProfile(uint dwProfileType, ushort langid, ref Guid clsid, ref Guid guidProfile, IntPtr hkl, uint dwFlags);
  [PreserveSig] int GetProfile(uint dwProfileType, ushort langid, ref Guid clsid, ref Guid guidProfile, IntPtr hkl, out TF_INPUTPROCESSORPROFILE pProfile);
  [PreserveSig] int EnumProfiles(ushort langid, out IEnumTfInputProcessorProfiles ppEnum);
  [PreserveSig] int ReleaseInputProcessor(ref Guid rclsid, uint dwFlags);
  [PreserveSig] int RegisterProfile(ref Guid rclsid, ushort langid, ref Guid guidProfile, [MarshalAs(UnmanagedType.LPWStr)] string pchDesc, uint cchDesc, [MarshalAs(UnmanagedType.LPWStr)] string pchIconFile, uint cchFile, uint uIconIndex, IntPtr hklsubstitute, uint dwPreferredLayout, int bEnabledByDefault, uint dwFlags);
  [PreserveSig] int UnregisterProfile(ref Guid rclsid, ushort langid, ref Guid guidProfile, uint dwFlags);
  [PreserveSig] int GetActiveProfile(ref Guid catid, out TF_INPUTPROCESSORPROFILE pProfile);
}

public static class AeA8nTsf {
  public const uint TF_PROFILETYPE_INPUTPROCESSOR = 0x0001;
  public const uint TF_IPPMF_FORPROCESS = 0x00000001;
  public const uint TF_IPPMF_FORSESSION = 0x00000002;
  // GUID_TFCAT_TIP_KEYBOARD (msctf-uuid.c)
  public static readonly Guid CatTipKeyboard = new Guid("34745c63-b2f0-4784-8b67-5e12c8701a31");

  public static ITfInputProcessorProfileMgr CreateMgr() {
    // CLSID_TF_InputProcessorProfiles: coclass in msctf.dll (inbox).
    Type t = Type.GetTypeFromCLSID(new Guid("33c53a50-f456-4884-b049-85fd643ecfed"));
    object com = Activator.CreateInstance(t);
    return (ITfInputProcessorProfileMgr)com;
  }

}
'@

try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
} catch {
  Write-Result 'UNAVAILABLE' ('Add-Type failed: ' + [string]$_.Exception.Message) $null
  exit 0
}

try { $script:ownSession = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId } catch { $script:ownSession = $null }
$apartment = 'unknown'
try { $apartment = [string][Threading.Thread]::CurrentThread.ApartmentState } catch {}
Write-Record ([ordered]@{ type = 'meta'; sessionId = $script:ownSession; apartment = $apartment })

$mgr = $null
try {
  $mgr = [AeA8nTsf]::CreateMgr()
} catch {
  Write-Result 'UNAVAILABLE' ('ITfInputProcessorProfileMgr could not be created: ' + [string]$_.Exception.Message) $null
  exit 0
}
if ($null -eq $mgr) {
  Write-Result 'UNAVAILABLE' 'ITfInputProcessorProfileMgr could not be created' $null
  exit 0
}

function Get-ActiveProfileRecord {
  $profile = New-Object AeA8nTsf+TF_INPUTPROCESSORPROFILE
  $catid = [AeA8nTsf]::CatTipKeyboard
  $hr = $mgr.GetActiveProfile([ref]$catid, [ref]$profile)
  return @{ hr = $hr; profile = $profile }
}

if ($script:mode -eq 'query') {
  try {
    $r = Get-ActiveProfileRecord
    if ([uint32]$r.hr -eq 1) {
      # S_FALSE: no active profile — an honest "none", not an error.
      Write-Record ([ordered]@{ type = 'ime-active'; found = $false })
      exit 0
    }
    if ([int]$r.hr -lt 0) {
      Write-Result 'FAILED' 'GetActiveProfile failed' ([int]$r.hr)
      exit 0
    }
    $p = $r.profile
    Write-Record ([ordered]@{
      type = 'ime-active'
      found = $true
      dwProfileType = [int]$p.dwProfileType
      langid = ('0x{0:X4}' -f [int]$p.langid)
      clsid = [string]$p.clsid
      guidProfile = [string]$p.guidProfile
      hkl = ('0x{0:X}' -f $p.hkl.ToInt64())
    })
  } catch {
    Write-Result 'FAILED' ([string]$_.Exception.Message) $null
  }
  exit 0
}

if ($script:mode -eq 'list') {
  try {
    $enum = $null
    $hr = $mgr.EnumProfiles([uint16]$script:langid, [ref]$enum)
    if ($null -eq $enum) {
      Write-Result 'FAILED' ('EnumProfiles returned no enumerator (hr=' + ('0x{0:X8}' -f [uint32]$hr) + ')') ([int]$hr)
      exit 0
    }
    $count = 0
    while ($count -lt $script:maxProfiles) {
      $arr = New-Object 'AeA8nTsf+TF_INPUTPROCESSORPROFILE[]' 1
      $fetched = [uint32]0
      $hr = $enum.Next(1, $arr, [ref]$fetched)
      if ([uint32]$fetched -eq 0 -or [int]$hr -lt 0) { break }
      $p = $arr[0]
      Write-Record ([ordered]@{
        type = 'ime-profile'
        dwProfileType = [int]$p.dwProfileType
        langid = ('0x{0:X4}' -f [int]$p.langid)
        clsid = [string]$p.clsid
        guidProfile = [string]$p.guidProfile
        hkl = ('0x{0:X}' -f $p.hkl.ToInt64())
      })
      $count++
    }
    Write-Record ([ordered]@{ type = 'result'; status = 'LISTED'; count = $count })
  } catch {
    Write-Result 'FAILED' ([string]$_.Exception.Message) $null
  }
  exit 0
}

if ($script:mode -eq 'activate') {
  try {
    $clsid = [Guid]$script:clsid
    $guidProfile = [Guid]$script:guidProfile
    # FORPROCESS | FORSESSION only — no ENABLEPROFILE, so nothing is
    # persisted to the user's registry by this call.
    $flags = [uint32]3
    $hr = $mgr.ActivateProfile([uint32]1, [uint16]$script:langid, [ref]$clsid, [ref]$guidProfile, [IntPtr]::Zero, $flags)
    if ([int]$hr -eq 0) {
      Write-Record ([ordered]@{ type = 'result'; status = 'ACTIVATED'; hr = '0x00000000' })
    } else {
      Write-Result 'ACTIVATE_FAILED' ('ActivateProfile hr=' + ('0x{0:X8}' -f [uint32]$hr)) ([int]$hr)
    }
  } catch {
    Write-Result 'ACTIVATE_FAILED' ([string]$_.Exception.Message) $null
  }
  exit 0
}

# deactivate: profile whatever is active right now, then report.
try {
  $r = Get-ActiveProfileRecord
  if ([uint32]$r.hr -eq 1 -or [int]$r.hr -lt 0) {
    Write-Record ([ordered]@{ type = 'result'; status = 'DEACTIVATED'; detail = 'no active profile was present' })
    exit 0
  }
  $p = $r.profile
  $clsid = $p.clsid
  $guidProfile = $p.guidProfile
  $hr = $mgr.DeactivateProfile([uint32]$p.dwProfileType, [uint16]$p.langid, [ref]$clsid, [ref]$guidProfile, $p.hkl, [uint32]0)
  if ([int]$hr -eq 0) {
    Write-Record ([ordered]@{ type = 'result'; status = 'DEACTIVATED'; hr = '0x00000000' })
  } else {
    Write-Result 'DEACTIVATE_FAILED' ('DeactivateProfile hr=' + ('0x{0:X8}' -f [uint32]$hr)) ([int]$hr)
  }
} catch {
  Write-Result 'DEACTIVATE_FAILED' ([string]$_.Exception.Message) $null
}
`;
}
