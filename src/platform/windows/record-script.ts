/**
 * The PowerShell + C# Windows Graphics Capture recording helper (#384,
 * `specs/gui-evidence/spec.md` §6.2, E3 of program #337 / tracking #346).
 *
 * Vehicle decision (recorded for the PR): the repo's Windows helpers are
 * PowerShell scripts embedded as string constants (`gui-observe-script.ts`,
 * `input-send-script.ts` precedent — `dist/` is the only shipped payload,
 * so an inlined script cannot go missing from a packed install). This
 * helper follows the same pattern but is long-running: the TypeScript
 * backend writes the script to a temp `.ps1` once and spawns
 * `powershell.exe -File`, passing every runtime value as a script
 * parameter so nothing caller-controlled is interpolated into the source.
 *
 * What the script does, in order:
 *
 *   1. Refuses early when the OS is older than Windows 10 1903 (build
 *      18362) — the WGC floor — or when the Windows SDK `Windows.winmd`
 *      needed to project WinRT types is absent. Both are honest
 *      `unsupported` verdicts, never silent fallbacks.
 *   2. `Add-Type` compiles the embedded C# recorder against the located
 *      `Windows.winmd` + `System.Runtime.WindowsRuntime`.
 *   3. The C# recorder creates a D3D11 device → `IDirect3DDevice`,
 *      resolves the capture item (`GraphicsCaptureItemInterop` for HWND
 *      window scope, `EnumDisplayMonitors` + `CreateForMonitor` for
 *      monitor scope), runs a `Direct3D11CaptureFramePool` →
 *      `GraphicsCaptureSession`, and feeds every frame as a DXGI surface
 *      buffer into a MediaFoundation `IMFSinkWriter` (H.264 via the OS
 *      MFTs — no custom codec, no third-party encoder).
 *   4. Bounded lifetime is enforced *inside* the helper
 *      (`-MaxDurationMs`), plus a `-StopFile` the driver touches for a
 *      graceful stop that lets the sink writer finalize the `moov` atom.
 *      A dead driver therefore cannot leave a recorder running past the
 *      contract bound (spec §5.4 crash honesty).
 *
 * Wire protocol: newline-delimited JSON verdicts on stdout, the same
 * convention as the other Windows helpers:
 *
 *   {"type":"recording", ...}  capture session started; recording now
 *   {"type":"frame", ...}       periodic progress (every ~5 s)
 *   {"type":"stopped", ...}     finalized cleanly; encoder flushed
 *   {"type":"error", ...}       refused/failed; `code` is machine-readable
 *
 * Honesty notes carried into the code comments: every COM/WinRT interop
 * signature below is written from the public Windows SDK headers and the
 * Microsoft `CaptureHelper` interop sample, but NOTHING here has compiled
 * or run — there is no Windows host in this repo's evidence. Compile or
 * runtime failures surface as `error` verdicts (exit 2/3), which the
 * backend records as `unavailable`, never as a silent success.
 */

/**
 * The full helper script. Static — every runtime value arrives as a
 * `-File` parameter, so the same file serves every segment.
 */
export function windowsWgcHelperScript(): string {
  return `
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('window', 'monitor')]
  [string]$Mode,

  # Decimal HWND for window mode; ignored for monitor mode.
  [string]$Hwnd,

  # 0-based EnumDisplayMonitors index; -1 (or empty) selects the primary
  # monitor (MONITORINFOF_PRIMARY). Ignored for window mode.
  [string]$MonitorIndex,

  [Parameter(Mandatory = $true)]
  [string]$Output,

  # Helper-side bounded lifetime in milliseconds (spec §5.4).
  [Parameter(Mandatory = $true)]
  [int]$MaxDurationMs,

  [int]$Fps = 30,

  # The driver touches this file to ask for a graceful stop.
  [Parameter(Mandatory = $true)]
  [string]$StopFile
)

$ErrorActionPreference = 'Stop'

function Write-Verdict($record) {
  [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

function Write-HelperError($code, $message) {
  Write-Verdict ([ordered]@{ type = 'error'; code = $code; message = [string]$message })
}

# --- environment gates -------------------------------------------------

$build = 0
try { $build = [int][Environment]::OSVersion.Version.Build } catch { $build = 0 }
if ($build -lt 18362) {
  Write-HelperError 'unsupported' ("Windows.Graphics.Capture requires Windows 10 1903 (build 18362) or later; this host reports build " + $build)
  exit 2
}

# The WinRT projections (Windows.Graphics.Capture, Windows.Graphics.DirectX)
# come from the Windows SDK union metadata. Pick the highest installed
# version; absence is an honest unsupported, not a guess.
$winmd = $null
foreach ($rootName in @('ProgramFiles(x86)', 'ProgramFiles')) {
  $root = [Environment]::GetEnvironmentVariable($rootName)
  if ([string]::IsNullOrEmpty($root)) { continue }
  $unionRoot = Join-Path $root 'Windows Kits\\10\\UnionMetadata'
  if (-not (Test-Path -LiteralPath $unionRoot)) { continue }
  $candidate = Get-ChildItem -LiteralPath $unionRoot -Directory -ErrorAction SilentlyContinue |
    Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending |
    Select-Object -First 1
  if ($null -ne $candidate) {
    $path = Join-Path $candidate.FullName 'Windows.winmd'
    if (Test-Path -LiteralPath $path) { $winmd = $path; break }
  }
}
if ($null -eq $winmd) {
  Write-HelperError 'unsupported' 'the Windows SDK UnionMetadata Windows.winmd needed to project WinRT capture types was not found on this host'
  exit 2
}

# --- embedded recorder (C# via Add-Type) -------------------------------
#
# The C# below is the WGC -> MediaFoundation encode path. Interop
# declarations follow the public SDK headers (mfapi.h / mfobjects.h /
# mfreadwrite.h / mftransform.h) and the Microsoft CaptureHelper sample
# for IGraphicsCaptureItemInterop. It is UNVERIFIED: no Windows host has
# compiled or run it. Any failure surfaces as an 'error' verdict.

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

namespace AeA8nWgc
{
    internal static class Native
    {
        public const int D3D_DRIVER_TYPE_HARDWARE = 1;
        public const int D3D_DRIVER_TYPE_WARP = 2;
        public const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x00000020;
        public const uint D3D11_SDK_VERSION = 7;
        public const int MF_VERSION = 0x00020070;
        public const int MFSTARTUP_FULL = 0;

        // NOTE: these are mutable (not readonly) because COM interop
        // signatures take REFGUID — a readonly static cannot be passed
        // by ref in C#.
        public static Guid IID_IDXGIDevice = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
        public static Guid IID_ID3D11Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        public static Guid IID_IDirect3DDxgiInterfaceAccess = new Guid("a9b3d012-3df2-4ee3-b8d1-8695f457d3c1");
        public static Guid IID_IMF2DBuffer = new Guid("7dc9d5f9-9ed9-44ec-9bbf-0600bb589fbb");
        public static Guid IID_IMFAttributes = new Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3");

        public static Guid MF_MT_MAJOR_TYPE = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
        public static Guid MF_MT_SUBTYPE = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
        public static Guid MF_MT_FRAME_SIZE = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
        public static Guid MF_MT_FRAME_RATE = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
        public static Guid MF_MT_PIXEL_ASPECT_RATIO = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
        public static Guid MF_MT_INTERLACE_MODE = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
        public static Guid MF_MT_AVG_BITRATE = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
        public static Guid MF_MT_ALL_SAMPLES_INDEPENDENT = new Guid("c9173739-5e56-461c-b713-46fb995cb95f");
        public static Guid MF_MT_DEFAULT_STRIDE = new Guid("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
        public static Guid MF_SA_D3D11_AWARE = new Guid("206b4fc8-fcf9-4c51-afe3-9764369e33a0");
        public static Guid MF_SINK_WRITER_D3D_MANAGER = new Guid("ec822da2-e1e9-4b29-a0d8-563c719f5269");
        public static Guid MF_LOW_LATENCY = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
        public static Guid MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS = new Guid("a634a91c-822b-41b9-a494-4de4643612b0");

        public static Guid MFMediaType_Video = new Guid("73646976-0000-0010-8000-00aa00389b71");
        public static Guid MFVideoFormat_H264 = new Guid("34363248-0000-0010-8000-00aa00389b71");
        // DXGI_FORMAT_B8G8R8A8_UNORM bytes are B,G,R,A; D3DFMT_A8R8G8B8
        // (MFVideoFormat_ARGB32) is the matching Media Foundation layout.
        public static Guid MFVideoFormat_ARGB32 = new Guid("34324241-0000-0010-8000-00aa00389b71");

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

        public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public int dwFlags;
        }

        public const int MONITORINFOF_PRIMARY = 0x00000001;

        [DllImport("d3d11.dll", SetLastError = true)]
        public static extern int D3D11CreateDevice(
            IntPtr pAdapter, int DriverType, IntPtr Software, uint Flags,
            IntPtr pFeatureLevels, uint FeatureLevels, uint SDKVersion,
            out IntPtr ppDevice, IntPtr pFeatureLevel, out IntPtr ppImmediateContext);

        [DllImport("d3d11.dll", SetLastError = true)]
        public static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr pDxgiDevice, out IntPtr ppDevice);

        [DllImport("mfplat.dll", SetLastError = true)]
        public static extern int MFStartup(int Version, int dwFlags);

        [DllImport("mfplat.dll")]
        public static extern int MFShutdown();

        [DllImport("mfplat.dll", SetLastError = true)]
        public static extern int MFCreateAttributes(out IMFAttributes ppMFAttributes, uint cInitialSize);

        [DllImport("mfplat.dll", SetLastError = true)]
        public static extern int MFCreateMediaType(out IMFAttributes ppMFType);

        [DllImport("mfplat.dll", SetLastError = true)]
        public static extern int MFCreateSample(out IMFSample ppIMFSample);

        [DllImport("mfplat.dll", SetLastError = true)]
        public static extern int MFCreateDXGIDeviceManager(out uint pResetToken, out IMFDXGIDeviceManager ppDeviceManager);

        [DllImport("mfplat.dll", SetLastError = true)]
        public static extern int MFCreateDXGISurfaceBuffer(
            [In] ref Guid riid, IntPtr punkSurface, uint uSubresourceIndex,
            [MarshalAs(UnmanagedType.Bool)] bool fBottomUpWhenLinear,
            out IMFMediaBuffer ppBuffer);

        [DllImport("mfreadwrite.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern int MFCreateSinkWriterFromURL(
            [MarshalAs(UnmanagedType.LPWStr)] string pwszOutputURL,
            IntPtr pByteStream, IMFAttributes pAttributes, out IMFSinkWriter ppWriter);

        public delegate int QueryInterfaceFn(IntPtr thisPtr, ref Guid riid, out IntPtr ppvObject);

        public static int ComQueryInterface(IntPtr pUnk, ref Guid iid, out IntPtr ppv)
        {
            IntPtr vtbl = Marshal.ReadIntPtr(pUnk);
            IntPtr fn = Marshal.ReadIntPtr(vtbl, IntPtr.Size * 0);
            QueryInterfaceFn del = Marshal.GetDelegateForFunctionPointer<QueryInterfaceFn>(fn);
            return del(pUnk, ref iid, out ppv);
        }

        public static void CheckHr(int hr, string what)
        {
            if (hr < 0)
            {
                throw new COMException(what + " failed", hr);
            }
        }
    }

    // PROPVARIANT is passed by value in IMFAttributes::SetItem /
    // GetItemByIndex. 16 bytes: vt(2) + reserved(6) + union(8).
    [StructLayout(LayoutKind.Sequential)]
    internal struct PropVariant
    {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public IntPtr ptr;
    }

    [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMFAttributes
    {
        void GetItem(ref Guid guidKey, ref PropVariant pValue);
        void GetItemType(ref Guid guidKey, out int pType);
        void CompareItem(ref Guid guidKey, ref PropVariant Value, int matchType, out bool pbResult);
        void Compare(IMFAttributes pTheirs, int MatchType, out bool pbResult);
        void GetUINT32(ref Guid guidKey, out uint punValue);
        void GetUINT64(ref Guid guidKey, out ulong punValue);
        void GetDouble(ref Guid guidKey, out double pfValue);
        void GetGUID(ref Guid guidKey, out Guid pguidValue);
        void GetStringLength(ref Guid guidKey, out uint pcchLength);
        void GetString(ref Guid guidKey, IntPtr pwszValue, uint cchBufSize, out uint pcchLength);
        void GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out uint pcchLength);
        void GetBlobSize(ref Guid guidKey, out uint pcbBlobSize);
        void GetBlob(ref Guid guidKey, IntPtr pBuf, uint cbBufSize, out uint pcbBlobSize);
        void GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out uint pcbSize);
        void GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
        void SetItem(ref Guid guidKey, PropVariant Value);
        void DeleteItem(ref Guid guidKey);
        void DeleteAllItems();
        void SetUINT32(ref Guid guidKey, uint unValue);
        void SetUINT64(ref Guid guidKey, ulong unValue);
        void SetDouble(ref Guid guidKey, double fValue);
        void SetGUID(ref Guid guidKey, ref Guid guidValue);
        void SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
        void SetBlob(ref Guid guidKey, IntPtr pBuf, uint cbBlobSize);
        void SetUnknown(ref Guid guidKey, IntPtr punkUnknown);
        void LockStore();
        void UnlockStore();
        void GetCount(out uint pcItems);
        void GetItemByIndex(uint dwIndex, IntPtr pguidKey, ref PropVariant pValue);
        void CopyAllItems(IMFAttributes pAttributes);
    }

    [ComImport, Guid("7dc9d5f9-9ed9-44ec-9bbf-0600bb589fbb"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMF2DBuffer
    {
        void Lock2D(out IntPtr ppbScanline0, out int plPitch);
        void Unlock2D();
        void GetScanline0AndPitch(out IntPtr ppScanline0, out int plPitch);
        void IsContiguousFormat(out bool pfIsContiguous);
        void GetContiguousLength(out int pcbContiguousLength);
        void ContiguousCopyTo(IntPtr pbDest, int cbDestStride, out int pcbWritten);
        void ContiguousCopyFrom(IntPtr pbSrc, int cbSrcStride);
    }

    [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMFSample : IMFAttributes
    {
        void GetSampleFlags(out uint pdwSampleFlags);
        void SetSampleFlags(uint dwSampleFlags);
        void GetSampleTime(out long phnsSampleTime);
        void SetSampleTime(long hnsSampleTime);
        void GetSampleDuration(out long phnsSampleDuration);
        void SetSampleDuration(long hnsSampleDuration);
        void GetBufferCount(out uint pdwBufferCount);
        void GetBufferByIndex(uint dwIndex, out IMFMediaBuffer ppBuffer);
        void ConvertToContiguousBuffer(out IMFMediaBuffer ppBuffer);
        void AddBuffer(IMFMediaBuffer pBuffer);
        void RemoveBufferByIndex(uint dwIndex);
        void RemoveAllBuffers();
        void GetTotalLength(out uint pcbTotalLength);
        void CopyToBuffer(IMFMediaBuffer pBuffer);
    }

    [ComImport, Guid("045fa593-8799-42b8-bc8d-8968c6453507"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMFMediaBuffer
    {
        void Lock(out IntPtr ppbBuffer, out uint pcbMaxLength, out uint pcbCurrentLength);
        void Unlock();
        void GetCurrentLength(out uint pcbCurrentLength);
        void SetCurrentLength(uint cbCurrentLength);
        void GetMaxLength(out uint pcbMaxLength);
    }

    [ComImport, Guid("eb533d5d-2db6-40f8-97a9-494692014f07"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMFDXGIDeviceManager
    {
        void CloseDeviceHandle(uint phDeviceHandle);
        void GetVideoService(ref Guid guidService, out IntPtr ppService);
        void LockDevice(out uint pResetToken, ref Guid guidService, out IntPtr ppService);
        void OpenDeviceHandle(IntPtr pUnkRemote, out uint pResetToken);
        void ResetDevice(IntPtr pDevice, IMFAttributes pAttr);
        void TestDevice();
        void UnlockDevice(uint resetToken);
    }

    [ComImport, Guid("3137f1cd-fe5e-4805-a5d8-fb477448cb3d"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMFSinkWriter
    {
        void AddStream(IMFAttributes pStreamDescriptor, out uint pdwStreamIndex);
        void SetInputMediaType(uint dwStreamIndex, IMFAttributes pInputMediaType, IMFAttributes pEncoderConfig);
        void BeginWriting();
        void WriteSample(uint dwStreamIndex, IMFSample pSample);
        void SendStreamTick(uint dwStreamIndex, long hnsTime);
        void PlaceMarker(uint dwStreamIndex, int eMarkerType, long llMarkTime, long llMarkDuration, [MarshalAs(UnmanagedType.LPWStr)] string pszMarkName);
        void NotifyEndOfSegment(uint dwStreamIndex);
        void Flush(uint dwStreamIndex);
        void Finalize();
        void GetServiceForStream(uint dwStreamIndex, ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
        void GetStatistics(uint dwStreamIndex, IntPtr pStats);
    }

    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [ComVisible(true)]
    internal interface IGraphicsCaptureItemInterop
    {
        IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
        IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
    }

    [ComImport, Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDirect3DDxgiInterfaceAccess
    {
        void GetInterface(ref Guid iid, out IntPtr ppvObject);
    }

    internal sealed class RecorderException : Exception
    {
        public readonly string Code;
        public RecorderException(string code, string message) : base(message) { Code = code; }
    }

    internal static class Capture
    {
        private static Guid GraphicsCaptureItemGuid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
        private static readonly long HnsPerSecond = 10000000L;

        private static void Emit(object record)
        {
            Console.Out.WriteLine(ToJsonRecord(record));
            Console.Out.Flush();
        }

        // Minimal JSON emitter: records are built as ordered string pairs.
        private static string ToJsonRecord(object record)
        {
            var pairs = (List<KeyValuePair<string, string>>)record;
            var sb = new System.Text.StringBuilder("{");
            for (int i = 0; i < pairs.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(pairs[i].Key).Append('"').Append(':');
                sb.Append(pairs[i].Value);
            }
            sb.Append('}');
            return sb.ToString();
        }

        private static List<KeyValuePair<string, string>> Rec()
        {
            return new List<KeyValuePair<string, string>>();
        }

        private static void Put(List<KeyValuePair<string, string>> r, string key, string value)
        {
            r.Add(new KeyValuePair<string, string>(key, value));
        }

        // JSON-escape a string value. Written with char codes instead of
        // backslash literals so the surrounding TS template literal
        // cannot eat the escapes (34 = double-quote, 92 = backslash,
        // 13/10 = CR/LF).
        private static string Q(string s)
        {
            if (s == null) return "null";
            var sb = new System.Text.StringBuilder();
            sb.Append('"');
            foreach (char c in s)
            {
                if (c == (char)34) { sb.Append((char)92).Append('"'); }
                else if (c == (char)92) { sb.Append((char)92).Append((char)92); }
                else if (c == (char)13 || c == (char)10) { sb.Append(' '); }
                else { sb.Append(c); }
            }
            sb.Append('"');
            return sb.ToString();
        }

        private static string N(long v) { return v.ToString(System.Globalization.CultureInfo.InvariantCulture); }
        private static string N(int v) { return v.ToString(System.Globalization.CultureInfo.InvariantCulture); }
        private static string N(uint v) { return v.ToString(System.Globalization.CultureInfo.InvariantCulture); }
        private static string N(double v) { return v.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture); }

        private static IntPtr CreateD3D11Device(out IntPtr immediateContext)
        {
            IntPtr device;
            int hr = Native.D3D11CreateDevice(
                IntPtr.Zero, Native.D3D_DRIVER_TYPE_HARDWARE, IntPtr.Zero,
                Native.D3D11_CREATE_DEVICE_BGRA_SUPPORT, IntPtr.Zero, 0,
                Native.D3D11_SDK_VERSION, out device, IntPtr.Zero, out immediateContext);
            if (hr < 0)
            {
                // WARP fallback: software rasterizer still gives a valid
                // D3D11 device for capture plumbing on hosts without a
                // usable GPU path.
                hr = Native.D3D11CreateDevice(
                    IntPtr.Zero, Native.D3D_DRIVER_TYPE_WARP, IntPtr.Zero,
                    Native.D3D11_CREATE_DEVICE_BGRA_SUPPORT, IntPtr.Zero, 0,
                    Native.D3D11_SDK_VERSION, out device, IntPtr.Zero, out immediateContext);
            }
            Native.CheckHr(hr, "D3D11CreateDevice");
            return device;
        }

        private static IDirect3DDevice CreateDirect3DDevice(IntPtr d3dDevice)
        {
            Guid iidDxgi = Native.IID_IDXGIDevice;
            IntPtr dxgiDevice;
            Native.CheckHr(Native.ComQueryInterface(d3dDevice, ref iidDxgi, out dxgiDevice), "ID3D11Device->IDXGIDevice");
            IntPtr inspectable;
            Native.CheckHr(Native.CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, out inspectable), "CreateDirect3D11DeviceFromDXGIDevice");
            var device = Marshal.GetObjectForIUnknown(inspectable) as IDirect3DDevice;
            Marshal.Release(inspectable);
            Marshal.Release(dxgiDevice);
            if (device == null) throw new RecorderException("unsupported", "the DXGI device could not be projected to IDirect3DDevice");
            return device;
        }

        private static IntPtr PickMonitor(int index)
        {
            var monitors = new List<IntPtr>();
            Native.MonitorEnumProc cb = delegate (IntPtr hmon, IntPtr hdc, ref Native.RECT rc, IntPtr data)
            {
                monitors.Add(hmon);
                return true;
            };
            if (!Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero))
            {
                throw new RecorderException("capture-failed", "EnumDisplayMonitors failed");
            }
            if (monitors.Count == 0) throw new RecorderException("capture-failed", "no display monitors were enumerated");
            if (index >= 0)
            {
                if (index >= monitors.Count)
                {
                    throw new RecorderException("window-not-capturable", "monitor index " + index + " is out of range; " + monitors.Count + " monitor(s) exist");
                }
                return monitors[index];
            }
            foreach (IntPtr hmon in monitors)
            {
                var info = new Native.MONITORINFO();
                info.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
                if (Native.GetMonitorInfo(hmon, ref info) && (info.dwFlags & Native.MONITORINFOF_PRIMARY) != 0)
                {
                    return hmon;
                }
            }
            return monitors[0];
        }

        private static void SetAttributeSize(IMFAttributes attr, Guid key, uint width, uint height)
        {
            // MFSetAttributeSize packs two UINT32 into a UINT64
            // (high = first value) — same layout as the mfapi.h helper.
            ulong packed = ((ulong)width << 32) | (ulong)height;
            attr.SetUINT64(ref key, packed);
        }

        private static void SetAttributeRatio(IMFAttributes attr, Guid key, uint numerator, uint denominator)
        {
            ulong packed = ((ulong)numerator << 32) | (ulong)denominator;
            attr.SetUINT64(ref key, packed);
        }

        // Per-segment encoder state shared with the frame callback.
        private sealed class Encoder
        {
            public IMFSinkWriter Writer;
            public int StreamIndex;
            public long FirstFrameHns = -1;
            public long LastFrameHns = -1;
            public long FrameDurationHns;
            public long FramesWritten;
            public volatile bool Stopping;
            public volatile bool Failed;
            public string Failure;
        }

        private static void WriteFrame(Encoder enc, Direct3D11CaptureFrame frame)
        {
            if (enc.Failed || enc.Stopping) return;
            try
            {
                var surface = frame.Surface;
                IntPtr surfaceUnk = Marshal.GetIUnknownForObject(surface);
                try
                {
                    Guid iidAccess = Native.IID_IDirect3DDxgiInterfaceAccess;
                    IntPtr accessPtr;
                    Native.CheckHr(Native.ComQueryInterface(surfaceUnk, ref iidAccess, out accessPtr), "IDirect3DSurface->IDirect3DDxgiInterfaceAccess");
                    var access = Marshal.GetObjectForIUnknown(accessPtr) as IDirect3DDxgiInterfaceAccess;
                    Marshal.Release(accessPtr);
                    if (access == null) throw new RecorderException("capture-failed", "the frame surface does not expose IDirect3DDxgiInterfaceAccess");

                    Guid iidTex = Native.IID_ID3D11Texture2D;
                    IntPtr texPtr;
                    access.GetInterface(ref iidTex, out texPtr);
                    if (texPtr == IntPtr.Zero) throw new RecorderException("capture-failed", "the frame surface did not yield an ID3D11Texture2D");

                    IMFMediaBuffer buffer;
                    Guid riid = Native.IID_ID3D11Texture2D;
                    Native.CheckHr(Native.MFCreateDXGISurfaceBuffer(ref riid, texPtr, 0, false, out buffer), "MFCreateDXGISurfaceBuffer");
                    Marshal.Release(texPtr);

                    // The surface buffer must report its contiguous length
                    // before it can be queued on a sample.
                    IntPtr bufferUnk = Marshal.GetIUnknownForObject(buffer);
                    try
                    {
                        Guid iid2d = Native.IID_IMF2DBuffer;
                        IntPtr buf2dPtr;
                        if (Native.ComQueryInterface(bufferUnk, ref iid2d, out buf2dPtr) >= 0)
                        {
                            var buf2d = Marshal.GetObjectForIUnknown(buf2dPtr) as IMF2DBuffer;
                            Marshal.Release(buf2dPtr);
                            if (buf2d != null)
                            {
                                int contiguous;
                                buf2d.GetContiguousLength(out contiguous);
                                buffer.SetCurrentLength((uint)contiguous);
                            }
                        }
                    }
                    finally
                    {
                        Marshal.Release(bufferUnk);
                    }

                    IMFSample sample;
                    Native.CheckHr(Native.MFCreateSample(out sample), "MFCreateSample");
                    sample.AddBuffer(buffer);

                    long frameHns = (long)(frame.SystemRelativeTime.TotalSeconds * (double)Native.HnsPerSecond);
                    if (enc.FirstFrameHns < 0) enc.FirstFrameHns = frameHns;
                    long pts = frameHns - enc.FirstFrameHns;
                    long duration = enc.LastFrameHns >= 0 ? Math.Max(0, frameHns - enc.LastFrameHns) : enc.FrameDurationHns;
                    enc.LastFrameHns = frameHns;
                    sample.SetSampleTime(pts);
                    sample.SetSampleDuration(duration > 0 ? duration : enc.FrameDurationHns);
                    if (enc.FramesWritten == 0)
                    {
                        try { enc.Writer.SendStreamTick((uint)enc.StreamIndex, pts); } catch { }
                        try
                        {
                            var flags = new PropVariant();
                            flags.vt = 11; // VT_BOOL
                            flags.ptr = new IntPtr(1);
                            sample.SetItem(ref MFSampleExtension_Discontinuity, flags);
                        }
                        catch { }
                    }
                    enc.Writer.WriteSample((uint)enc.StreamIndex, sample);
                    enc.FramesWritten++;
                }
                finally
                {
                    Marshal.Release(surfaceUnk);
                }
            }
            catch (Exception ex)
            {
                enc.Failed = true;
                enc.Failure = ex.Message;
            }
        }

        private static Guid MFSampleExtension_Discontinuity = new Guid("9cdf01d9-a0f0-43ba-b077-eaa06cbd728a");

        // Optional WinRT properties (IsBorderRequired,
        // IsCursorCaptureEnabled) ship in newer Windows SDK projections.
        // Reflection keeps this source compilable against an older
        // Windows.winmd; a missing property degrades to the OS default.
        private static void TrySetProperty(object target, string name, object value)
        {
            try
            {
                var prop = target.GetType().GetProperty(name);
                if (prop != null && prop.CanWrite) prop.SetValue(target, value, null);
            }
            catch { }
        }

        public static int Run(
            string mode, string hwndText, string monitorText,
            string outputPath, int maxDurationMs, int fps, string stopFile)
        {
            var started = Stopwatch.StartNew();
            long deadlineMs = Math.Max(1000, (long)maxDurationMs);
            int frameRate = fps > 0 ? fps : 30;
            long frameDurationHns = Native.HnsPerSecond / frameRate;

            IntPtr d3dDevice = IntPtr.Zero;
            IntPtr d3dContext = IntPtr.Zero;
            IMFDXGIDeviceManager dxgiManager = null;
            IMFSinkWriter writer = null;
            Direct3D11CaptureFramePool framePool = null;
            GraphicsCaptureSession session = null;
            IDirect3DDevice direct3DDevice = null;
            GraphicsCaptureItem item = null;
            var encoder = new Encoder();
            encoder.FrameDurationHns = frameDurationHns;
            long lastProgressMs = 0;
            int exitCode = 0;
            string fatal = null;

            try
            {
                // --- Media Foundation boot ---------------------------------
                Native.CheckHr(Native.MFStartup(Native.MF_VERSION, Native.MFSTARTUP_FULL), "MFStartup");

                // --- D3D11 device -> IDirect3DDevice ------------------------
                d3dDevice = CreateD3D11Device(out d3dContext);
                direct3DDevice = CreateDirect3DDevice(d3dDevice);

                // --- capture item ------------------------------------------
                var factory = WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
                var interop = factory as IGraphicsCaptureItemInterop;
                if (interop == null) throw new RecorderException("unsupported", "GraphicsCaptureItem activation factory does not expose IGraphicsCaptureItemInterop");

                if (string.Equals(mode, "window", StringComparison.OrdinalIgnoreCase))
                {
                    long hwndValue;
                    if (string.IsNullOrEmpty(hwndText) || !long.TryParse(hwndText, out hwndValue) || hwndValue <= 0)
                    {
                        throw new RecorderException("invalid", "window mode requires a positive decimal HWND");
                    }
                    IntPtr hwnd = new IntPtr(hwndValue);
                    if (!Native.IsWindow(hwnd))
                    {
                        throw new RecorderException("window-not-found", "the HWND " + hwndValue + " is not a live top-level window");
                    }
                    if (Native.IsIconic(hwnd))
                    {
                        // Minimized windows have no capturable surface; say so
                        // instead of delivering black frames.
                        throw new RecorderException("window-not-capturable", "the HWND " + hwndValue + " is minimized and cannot be captured");
                    }
                    Guid itemGuid = GraphicsCaptureItemGuid;
                    IntPtr itemPtr;
                    try
                    {
                        itemPtr = interop.CreateForWindow(hwnd, ref itemGuid);
                    }
                    catch (Exception ex)
                    {
                        throw new RecorderException(HresultCode(ex), "CreateForWindow(0x" + hwndValue.ToString("x") + ") refused: " + ex.Message);
                    }
                    if (itemPtr == IntPtr.Zero) throw new RecorderException("window-not-capturable", "CreateForWindow returned no capture item for HWND 0x" + hwndValue.ToString("x"));
                    item = Marshal.GetObjectForIUnknown(itemPtr) as GraphicsCaptureItem;
                    Marshal.Release(itemPtr);
                    if (item == null) throw new RecorderException("window-not-capturable", "the HWND capture item could not be projected");
                }
                else
                {
                    int monitorIndex = -1;
                    if (!string.IsNullOrEmpty(monitorText))
                    {
                        int parsed;
                        if (!int.TryParse(monitorText, out parsed))
                        {
                            throw new RecorderException("invalid", "monitor index must be an integer");
                        }
                        monitorIndex = parsed;
                    }
                    IntPtr hmon = PickMonitor(monitorIndex);
                    Guid itemGuid = GraphicsCaptureItemGuid;
                    IntPtr itemPtr;
                    try
                    {
                        itemPtr = interop.CreateForMonitor(hmon, ref itemGuid);
                    }
                    catch (Exception ex)
                    {
                        throw new RecorderException(HresultCode(ex), "CreateForMonitor refused: " + ex.Message);
                    }
                    if (itemPtr == IntPtr.Zero) throw new RecorderException("window-not-capturable", "CreateForMonitor returned no capture item");
                    item = Marshal.GetObjectForIUnknown(itemPtr) as GraphicsCaptureItem;
                    Marshal.Release(itemPtr);
                    if (item == null) throw new RecorderException("window-not-capturable", "the monitor capture item could not be projected");
                }

                // --- DXGI device manager + sink writer ---------------------
                uint resetToken;
                Native.CheckHr(Native.MFCreateDXGIDeviceManager(out resetToken, out dxgiManager), "MFCreateDXGIDeviceManager");
                dxgiManager.ResetDevice(d3dDevice, null);

                IMFAttributes writerAttrs;
                Native.CheckHr(Native.MFCreateAttributes(out writerAttrs, 3), "MFCreateAttributes(writer)");
                Guid mgrKey = Native.MF_SINK_WRITER_D3D_MANAGER;
                writerAttrs.SetUnknown(ref mgrKey, Marshal.GetIUnknownForObject(dxgiManager));
                Guid hwKey = Native.MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS;
                writerAttrs.SetUINT32(ref hwKey, 1);
                Guid lowKey = Native.MF_LOW_LATENCY;
                writerAttrs.SetUINT32(ref lowKey, 1);

                Native.CheckHr(Native.MFCreateSinkWriterFromURL(outputPath, IntPtr.Zero, writerAttrs, out writer), "MFCreateSinkWriterFromURL");

                // Output type: H.264 mp4 via the OS encoder MFT.
                IMFAttributes outputType;
                Native.CheckHr(Native.MFCreateMediaType(out outputType), "MFCreateMediaType(output)");
                Guid major = Native.MF_MT_MAJOR_TYPE;
                outputType.SetGUID(ref major, ref Native.MFMediaType_Video);
                Guid sub = Native.MF_MT_SUBTYPE;
                outputType.SetGUID(ref sub, ref Native.MFVideoFormat_H264);
                var size = item.Size;
                SetAttributeSize(outputType, Native.MF_MT_FRAME_SIZE, (uint)Math.Max(1, size.Width), (uint)Math.Max(1, size.Height));
                SetAttributeRatio(outputType, Native.MF_MT_FRAME_RATE, (uint)frameRate, 1);
                SetAttributeRatio(outputType, Native.MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
                uint progressive = 2; // MFVideoInterlace_Progressive
                outputType.SetUINT32(ref Native.MF_MT_INTERLACE_MODE, progressive);
                outputType.SetUINT32(ref Native.MF_MT_ALL_SAMPLES_INDEPENDENT, 1);
                outputType.SetUINT32(ref Native.MF_MT_AVG_BITRATE, 8000000);

                uint streamIndex;
                writer.AddStream(outputType, out streamIndex);
                encoder.StreamIndex = (int)streamIndex;

                // Input type: the DXGI surface layout the frame pool emits.
                IMFAttributes inputType;
                Native.CheckHr(Native.MFCreateMediaType(out inputType), "MFCreateMediaType(input)");
                inputType.SetGUID(ref major, ref Native.MFMediaType_Video);
                inputType.SetGUID(ref sub, ref Native.MFVideoFormat_ARGB32);
                SetAttributeSize(inputType, Native.MF_MT_FRAME_SIZE, (uint)Math.Max(1, size.Width), (uint)Math.Max(1, size.Height));
                SetAttributeRatio(inputType, Native.MF_MT_FRAME_RATE, (uint)frameRate, 1);
                SetAttributeRatio(inputType, Native.MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
                inputType.SetUINT32(ref Native.MF_MT_INTERLACE_MODE, progressive);
                inputType.SetUINT32(ref Native.MF_MT_ALL_SAMPLES_INDEPENDENT, 1);
                inputType.SetUINT32(ref Native.MF_MT_DEFAULT_STRIDE, (uint)(Math.Max(1, size.Width) * 4));
                Guid d3dAware = Native.MF_SA_D3D11_AWARE;
                inputType.SetUINT32(ref d3dAware, 1);
                writer.SetInputMediaType(streamIndex, inputType, null);

                writer.BeginWriting();

                // --- frame pool + session ----------------------------------
                framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                    direct3DDevice,
                    DirectXPixelFormat.B8G8R8A8UIntNormalized,
                    2,
                    item.Size).AsTask().Result;

                framePool.FrameArrived += delegate (Direct3D11CaptureFramePool sender, object args)
                {
                    using (var frame = sender.TryGetNextFrame())
                    {
                        if (frame != null) WriteFrame(encoder, frame);
                    }
                };

                session = framePool.CreateCaptureSession(item);
                // IsBorderRequired exists only on newer SDK projections;
                // set it through reflection so an older Windows.winmd
                // still compiles, and a missing property degrades to the
                // OS default border instead of failing the whole capture.
                TrySetProperty(session, "IsBorderRequired", false);
                TrySetProperty(session, "IsCursorCaptureEnabled", true);
                session.StartCapture();

                var rec = Rec();
                Put(rec, "type", Q("recording"));
                Put(rec, "mode", Q(mode));
                Put(rec, "width", N(Math.Max(1, size.Width)));
                Put(rec, "height", N(Math.Max(1, size.Height)));
                Put(rec, "fps", N(frameRate));
                Put(rec, "maxDurationMs", N(maxDurationMs));
                Emit(rec);

                // --- bounded wait: stop file or deadline -------------------
                while (true)
                {
                    if (File.Exists(stopFile)) break;
                    if (encoder.Failed) { fatal = "frame-error"; break; }
                    if (started.ElapsedMilliseconds >= deadlineMs) break;
                    Thread.Sleep(100);
                    long nowMs = started.ElapsedMilliseconds;
                    if (nowMs - lastProgressMs >= 5000)
                    {
                        lastProgressMs = nowMs;
                        var prog = Rec();
                        Put(prog, "type", Q("frame"));
                        Put(prog, "frames", N(encoder.FramesWritten));
                        Put(prog, "elapsedMs", N(nowMs));
                        Emit(prog);
                    }
                }

                if (fatal == null && encoder.Failed) fatal = "frame-error";

                // --- finalize ----------------------------------------------
                // Stop accepting frames first so the encoder is not fed
                // while the sink writer finalizes. WinRT session/pool
                // objects have no portable Dispose on every projection;
                // dropping the references and letting the process exit is
                // the honest bounded-lifetime story here.
                encoder.Stopping = true;
                session = null;
                framePool = null;
                if (writer != null)
                {
                    try { writer.Finalize(); } catch (Exception ex) { fatal = fatal ?? ("finalize-failed: " + ex.Message); }
                }

                if (fatal != null)
                {
                    var er = Rec();
                    Put(er, "type", Q("error"));
                    Put(er, "code", Q(fatal.StartsWith("finalize-failed") ? "finalize-failed" : "capture-failed"));
                    Put(er, "message", Q(fatal + (encoder.Failure != null ? " | frame error: " + encoder.Failure : "")));
                    Emit(er);
                    exitCode = fatal.StartsWith("finalize-failed") ? 4 : 3;
                }
                else
                {
                    var st = Rec();
                    Put(st, "type", Q("stopped"));
                    Put(st, "frames", N(encoder.FramesWritten));
                    Put(st, "elapsedMs", N(started.ElapsedMilliseconds));
                    Put(st, "stopReason", Q(File.Exists(stopFile) ? "requested" : "deadline"));
                    Emit(st);
                    exitCode = 0;
                }
            }
            catch (RecorderException rex)
            {
                var er = Rec();
                Put(er, "type", Q("error"));
                Put(er, "code", Q(rex.Code));
                Put(er, "message", Q(rex.Message));
                Emit(er);
                exitCode = rex.Code == "invalid" ? 2 : 3;
            }
            catch (Exception ex)
            {
                var er = Rec();
                Put(er, "type", Q("error"));
                Put(er, "code", Q("capture-failed"));
                Put(er, "message", Q(ex.GetType().Name + ": " + ex.Message));
                Emit(er);
                exitCode = 3;
            }
            finally
            {
                try { Native.MFShutdown(); } catch { }
                try
                {
                    if (d3dDevice != IntPtr.Zero) Marshal.Release(d3dDevice);
                    if (d3dContext != IntPtr.Zero) Marshal.Release(d3dContext);
                }
                catch { }
            }
            return exitCode;
        }

        private static string HresultCode(Exception ex)
        {
            var com = ex as COMException;
            if (com != null)
            {
                int hr = com.ErrorCode;
                unchecked
                {
                    // E_ACCESSDENIED and the WGC "item not capturable"
                    // family all mean the same honest thing to the caller.
                    if (hr == unchecked((int)0x80070005) || hr == unchecked((int)0x80004005) || hr == unchecked((int)0x89710000))
                    {
                        return "window-not-capturable";
                    }
                }
            }
            return "capture-failed";
        }
    }

    public static class Entry
    {
        public static int Main(string[] args)
        {
            // Arguments arrive positionally from the PowerShell param
            // block: Mode Hwnd MonitorIndex Output MaxDurationMs Fps
            // StopFile. Validate defensively — the script already did.
            if (args.Length < 7) return 2;
            try
            {
                return Capture.Run(
                    args[0], args[1], args[2], args[3],
                    int.Parse(args[4], System.Globalization.CultureInfo.InvariantCulture),
                    int.Parse(args[5], System.Globalization.CultureInfo.InvariantCulture),
                    args[6]);
            }
            catch
            {
                return 2;
            }
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @($winmd, 'System.Runtime.WindowsRuntime') -ErrorAction Stop
} catch {
  Write-HelperError 'compile-failed' ("Add-Type could not compile the recorder: " + $_.Exception.Message)
  exit 2
}

# Run the compiled entry point. Positional args mirror the param block;
# the C# Main re-validates everything it receives.
try {
  $hwndArg = ''
  if ($Mode -eq 'window') { $hwndArg = [string]$Hwnd }
  $monitorArg = '-1'
  if (-not [string]::IsNullOrEmpty($MonitorIndex)) { $monitorArg = [string]$MonitorIndex }
  $exitCode = [int][AeA8nWgc.Entry]::Main(@(
    [string]$Mode, $hwndArg, $monitorArg, [string]$Output,
    [string]$MaxDurationMs, [string]$Fps, [string]$StopFile))
  exit $exitCode
} catch {
  Write-HelperError 'capture-failed' ("the recorder threw before it could report: " + $_.Exception.Message)
  exit 3
}
`;
}
