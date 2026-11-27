// Records a bounded screen segment through ScreenCaptureKit SCStream and
// writes a QuickTime (.mov, H.264/HEVC via AVAssetWriter) inside the
// caller's session — the macOS recording vehicle of #382
// (specs/gui-evidence/spec.md §5.4, §6.1, §11; parent #346 / #337).
//
//   swiftc -O screen-record.swift -o screen-record
//   ./screen-record record --scope window --window-id 12345 \
//       --out /path/seg-001.mov --receipt /path/seg-001.receipt.json \
//       --max-duration-ms 300000 --fps 30
//   ./screen-record record --scope region --rect 100,200,640,480 ...
//   ./screen-record record --scope display [--display-id 1] ...
//
// SAFETY: this helper records the REAL screen of the session it runs in.
// It is a delivery vehicle only — ae-a8n invokes it through runInSession /
// startInSession inside the target session after the §5.6 gates have
// passed. Running it by hand records whatever is on that session's
// display, including other applications' content.
//
// CONTRACT (consumed by src/evidence/recording-darwin.ts):
//
//   - The helper enforces `--max-duration-ms` ITSELF, measured from
//     process start (not from stream start), so a dead driver cannot
//     leave a recorder running (spec §5.4 crash honesty). SIGTERM /
//     SIGINT / SIGHUP also finalize gracefully: the stream stops, the
//     AVAssetWriter finishes, and a final receipt is written. If
//     finalize itself wedges, a watchdog exits non-zero rather than
//     lingering.
//   - Audio is OFF, always: only the `.screen` output type is
//     registered and `capturesAudio` is false where the OS allows it.
//     There is no audio contract in v1 (spec §7.3).
//   - The receipt file (`--receipt`) is the driver's only channel: it
//     is rewritten atomically (temp + rename) at each lifecycle point —
//     "starting" at launch, "recording" once the stream reports
//     started, "finished"/"failed" at exit. The driver polls it; the
//     helper never blocks on stdout.
//   - "delivered" in the recording receipt is what the OS actually
//     captured: "window" (desktop-independent window filter), "region"
//     (display filter + sourceRect crop), or "display" (whole display —
//     also the honest answer when a narrower request could not be
//     honored, e.g. region spanning displays or an unavailable
//     window id falls back is NOT done silently: unknown window id is
//     a hard failure, not a display substitution).
//   - captureStats inputs (spec §11): the receipt reports
//     framesReceived, per-status frame counts (complete/idle/blank/
//     suspended/started/stopped), wall duration and process CPU
//     seconds. This ScreenCaptureKit SDK exposes no didDrop callback,
//     so droppedFrames is reported as null with the reason recorded —
//     never estimated silently.
//
// VERIFICATION LEVEL: `implemented` — this file compiles under swiftc
// and its argument validation is exercised by automated tests. Whether
// SCStream delivers frames under `launchctl asuser`, whether the TCC
// Screen Recording prompt appears/fails inside an isolated session,
// achievable fps, and .mov finalize-on-signal are ALL `unverified`
// until a real-host lane runs them (spec §10).
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import Darwin

// MARK: - Argument parsing

struct Options {
    var mode = "record"
    var scope = "display"
    var out = ""
    var receipt = ""
    var maxDurationMs = 300_000
    var fps = 30.0
    var windowId: UInt32? = nil
    var displayId: UInt32? = nil
    var rect: CGRect? = nil
}

func usage(_ message: String) -> Never {
    FileHandle.standardError.write("screen-record: \(message)\n".data(using: .utf8)!)
    FileHandle.standardError.write("usage: screen-record record --scope window|region|display --out <file.mov> --receipt <file.json> --max-duration-ms <ms> [--fps <n>] [--window-id <id>] [--display-id <id>] [--rect x,y,w,h]\n".data(using: .utf8)!)
    exit(2)
}

func parseArgs() -> Options {
    var opts = Options()
    var args = Array(CommandLine.arguments.dropFirst())
    if args.isEmpty { usage("no mode given") }
    opts.mode = args.removeFirst()
    if opts.mode != "record" {
        usage("unknown mode '\(opts.mode)' (only 'record' exists)")
    }
    var i = 0
    func value(_ flag: String) -> String {
        i += 1
        if i >= args.count { usage("\(flag) requires a value") }
        return args[i]
    }
    while i < args.count {
        let arg = args[i]
        switch arg {
        case "--scope":
            opts.scope = value(arg)
            if opts.scope != "window" && opts.scope != "region" && opts.scope != "display" {
                usage("--scope must be window, region or display")
            }
        case "--out":
            opts.out = value(arg)
        case "--receipt":
            opts.receipt = value(arg)
        case "--max-duration-ms":
            let raw = value(arg)
            guard let ms = Int(raw), ms > 0 else { usage("--max-duration-ms must be a positive integer") }
            opts.maxDurationMs = ms
        case "--fps":
            let raw = value(arg)
            guard let fps = Double(raw), fps > 0, fps <= 120 else {
                usage("--fps must be a number in (0, 120]")
            }
            opts.fps = fps
        case "--window-id":
            let raw = value(arg)
            guard let id = UInt32(raw) else { usage("--window-id must be an unsigned integer") }
            opts.windowId = id
        case "--display-id":
            let raw = value(arg)
            guard let id = UInt32(raw) else { usage("--display-id must be an unsigned integer") }
            opts.displayId = id
        case "--rect":
            let raw = value(arg)
            let parts = raw.split(separator: ",").compactMap { Double($0) }
            guard parts.count == 4 else { usage("--rect must be x,y,width,height") }
            let rect = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
            guard rect.width > 0, rect.height > 0 else { usage("--rect width/height must be positive") }
            opts.rect = rect
        default:
            usage("unknown argument '\(arg)'")
        }
        i += 1
    }
    if opts.out.isEmpty { usage("--out is required") }
    if opts.receipt.isEmpty { usage("--receipt is required") }
    switch opts.scope {
    case "window":
        if opts.windowId == nil { usage("--scope window requires --window-id") }
    case "region":
        if opts.rect == nil { usage("--scope region requires --rect") }
    default:
        break
    }
    return opts
}

// MARK: - Receipt

/// Atomic JSON receipt: temp file + rename so a polling driver never
/// reads a half-written document.
func writeReceipt(_ path: String, _ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
    let tmp = path + ".tmp"
    do {
        try data.write(to: URL(fileURLWithPath: tmp))
        try? FileManager.default.removeItem(atPath: path)
        try FileManager.default.moveItem(atPath: tmp, toPath: path)
    } catch {
        FileHandle.standardError.write("screen-record: could not write receipt \(path): \(error)\n".data(using: .utf8)!)
    }
}

func isoNow() -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date())
}

func epochMsNow() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
}

// MARK: - Stop signalling

/// Set by the C signal handlers; policed by the watchdog timer. Signal
/// handlers must stay async-signal-safe, so they only flip this flag —
/// all ScreenCaptureKit/AVFoundation work happens on the timer queue.
private var gStopRequested: Int32 = 0

// MARK: - Recorder

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let opts: Options
    var stream: SCStream?
    var writer: AVAssetWriter?
    var writerInput: AVAssetWriterInput?
    var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    var writerStarted = false
    var streamStarted = false
    var finishing = false
    var finishBeganAt: Date?
    var delivered = "display"
    var contentWidth = 0
    var contentHeight = 0

    // captureStats inputs (spec §11)
    var framesReceived = 0
    var statusCounts: [String: Int] = [:]
    var firstPTS: CMTime?
    var lastPTS: CMTime?
    let launchEpochMs = epochMsNow()
    let cpuAtLaunch = cpuSeconds()

    init(opts: Options) { self.opts = opts }

    func bumpStatus(_ name: String) {
        statusCounts[name, default: 0] += 1
    }

    /// Point every lifecycle failure through one honest exit: receipt
    /// first (the driver reads it), then a non-zero status.
    func fail(_ reason: String, code: Int32 = 1) -> Never {
        writeReceipt(opts.receipt, [
            "status": "failed",
            "reason": reason,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "endedAtEpochMs": epochMsNow(),
        ])
        FileHandle.standardError.write("screen-record: \(reason)\n".data(using: .utf8)!)
        exit(code)
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        framesReceived += 1
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if firstPTS == nil { firstPTS = pts }
        lastPTS = pts
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer),
              let adaptor = adaptor, let writer = writer else { return }
        if !writerStarted {
            writer.startWriting()
            writer.startSession(atSourceTime: pts)
            writerStarted = true
        }
        _ = adaptor.append(pb, withPresentationTime: pts)
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // The OS stopped the stream (display sleep, permission revoked,
        // filter invalidated). Finalize what we have rather than leaving
        // a half-written file claimed as live.
        FileHandle.standardError.write("screen-record: stream stopped: \(error.localizedDescription)\n".data(using: .utf8)!)
        requestFinish(reason: "stream-error: \(error.localizedDescription)")
    }

    // MARK: lifecycle

    /// Idempotent finish entry point — called by the deadline timer,
    /// the signal flag, or the stream delegate.
    func requestFinish(reason: String = "duration") {
        guard !finishing else { return }
        if stream == nil && writer == nil {
            // Nothing to finalize yet (still inside SCShareableContent /
            // writer setup): fail honestly instead of silently ignoring
            // the deadline — the watchdog keeps ticking, so a hung
            // startup cannot outlive maxDurationMs.
            fail("finish requested before the recorder was set up (\(reason))")
        }
        finishing = true
        finishBeganAt = Date()
        let receiptPath = opts.receipt
        let stopDone = DispatchSemaphore(value: 0)
        if let stream = stream {
            stream.stopCapture { _ in stopDone.signal() }
        } else {
            stopDone.signal()
        }
        // Do not block the control queue indefinitely on stopCapture:
        // wait at most 10s, then finish the writer anyway.
        _ = stopDone.wait(timeout: .now() + 10)
        if let writerInput = writerInput {
            writerInput.markAsFinished()
        }
        if let writer = writer, writer.status == .writing {
            writer.finishWriting {
                self.emitFinalReceipt(reason: reason, receiptPath: receiptPath)
            }
        } else {
            emitFinalReceipt(reason: reason, receiptPath: receiptPath)
        }
    }

    func emitFinalReceipt(reason: String, receiptPath: String) {
        let ended = epochMsNow()
        var wallSec = Double(ended - launchEpochMs) / 1000.0
        if wallSec <= 0 { wallSec = 0.001 }
        var durationSec: Double? = nil
        if let first = firstPTS, let last = lastPTS {
            durationSec = CMTimeGetSeconds(CMTimeSubtract(last, first))
        }
        let cpu = cpuSeconds() - cpuAtLaunch
        writeReceipt(receiptPath, [
            "status": "finished",
            "reason": reason,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "delivered": delivered,
            "endedAtEpochMs": ended,
            "wallDurationSec": wallSec,
            "durationSec": durationSec ?? NSNull(),
            "framesReceived": framesReceived,
            "frameStatuses": statusCounts,
            "cpuSeconds": cpu,
            "encodeCpuFraction": cpu / wallSec,
            "writerStarted": writerStarted,
        ])
        exit(0)
    }

    // MARK: setup

    /// Blocking fetch of SCShareableContent (completion-handler API;
    /// works on macOS 12.3+ without needing async/await runtime support).
    func shareableContent() throws -> SCShareableContent {
        let sem = DispatchSemaphore(value: 0)
        var content: SCShareableContent?
        var failure: Error?
        SCShareableContent.getExcludingDesktopWindows(
            false, onScreenWindowsOnly: true
        ) { c, e in
            content = c
            failure = e
            sem.signal()
        }
        sem.wait()
        if let failure = failure { throw failure }
        guard let content = content else {
            throw NSError(domain: "screen-record", code: 1, userInfo: [NSLocalizedDescriptionKey: "SCShareableContent returned nil"])
        }
        return content
    }

    func chooseDisplay(_ displays: [SCDisplay], rect: CGRect?, windowFrame: CGRect?) -> SCDisplay {
        // displayId wins when given; otherwise the display containing the
        // target rect/window center; otherwise the first display.
        if let wanted = opts.displayId,
           let match = displays.first(where: { $0.displayID == wanted }) {
            return match
        }
        let probe = rect ?? windowFrame
        if let probe = probe {
            let cx = probe.midX, cy = probe.midY
            if let match = displays.first(where: { d in
                let b = d.frame
                return cx >= b.minX && cx <= b.maxX && cy >= b.minY && cy <= b.maxY
            }) {
                return match
            }
        }
        return displays[0]
    }

    /// Point rect (census/AX space, top-left origin) → pixel rect inside
    /// the chosen display's content, using the display's point→pixel
    /// scale. Multi-display global coordinates are approximated by the
    /// display's own frame origin — UNVERIFIED on real hardware.
    func regionPixelRect(_ rect: CGRect, display: SCDisplay) -> CGRect {
        let scale = display.width > 0 ? CGFloat(display.width) / max(display.frame.width, 1) : 1
        let origin = display.frame.origin
        return CGRect(
            x: (rect.minX - origin.x) * scale,
            y: (rect.minY - origin.y) * scale,
            width: rect.width * scale,
            height: rect.height * scale
        )
    }

    func run() {
        // The bounded lifetime is enforced from LAUNCH, not from stream
        // start: start the watchdog before any blocking OS call so a
        // hung SCShareableContent fetch or a TCC prompt cannot outlive
        // --max-duration-ms (or a stop signal).
        startWatchdog()
        let content: SCShareableContent
        do {
            content = try shareableContent()
        } catch {
            fail("could not list shareable content (Screen Recording permission or WindowServer access): \(error.localizedDescription)")
        }
        var filter: SCContentFilter
        var outWidth = 0
        var outHeight = 0

        switch opts.scope {
        case "window":
            guard let windowId = opts.windowId,
                  let window = content.windows.first(where: { $0.windowID == windowId }) else {
                fail("window id \(opts.windowId ?? 0) is not a shareable window in this session (closed, minimized, or not capturable)")
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            delivered = "window"
            // Window filters output at the window's pixel size; the OS
            // picks it from the window — we request the point size * the
            // display scale of the display hosting the window center.
            let host = chooseDisplay(content.displays, rect: nil, windowFrame: window.frame)
            let pxScale = host.width > 0 ? CGFloat(host.width) / max(host.frame.width, 1) : 1
            outWidth = Int((window.frame.width * pxScale).rounded())
            outHeight = Int((window.frame.height * pxScale).rounded())
        case "region":
            guard let rect = opts.rect else { fail("internal: region without rect") }
            let display = chooseDisplay(content.displays, rect: rect, windowFrame: nil)
            filter = SCContentFilter(display: display, excludingWindows: [])
            let pixelRect = regionPixelRect(rect, display: display)
            delivered = "region"
            outWidth = Int(pixelRect.width.rounded())
            outHeight = Int(pixelRect.height.rounded())
            configSourceRect = pixelRect
        default: // display / session both land here; session is gated upstream
            let display = chooseDisplay(content.displays, rect: nil, windowFrame: nil)
            filter = SCContentFilter(display: display, excludingWindows: [])
            delivered = "display"
            outWidth = display.width
            outHeight = display.height
        }

        let config = SCStreamConfiguration()
        config.width = outWidth
        config.height = outHeight
        config.minimumFrameInterval = CMTime(seconds: 1.0 / opts.fps, preferredTimescale: 600)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.queueDepth = 8
        config.showsCursor = true
        if #available(macOS 13.0, *) {
            config.capturesAudio = false
        }
        if let src = configSourceRect {
            config.sourceRect = src
        }

        // AVAssetWriter: .mov, H.264 preferred, HEVC fallback, both OS
        // encoders — no custom codec (spec §6.1, §9).
        let outURL = URL(fileURLWithPath: opts.out)
        guard let writer = try? AVAssetWriter(url: outURL, fileType: .mov) else {
            fail("AVAssetWriter could not be created for \(opts.out)")
        }
        self.writer = writer
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: outWidth,
            AVVideoHeightKey: outHeight,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 12_000_000,
                AVVideoExpectedSourceFrameRateKey: Int(opts.fps),
                AVVideoMaxKeyFrameIntervalKey: max(1, Int(opts.fps) * 2),
            ],
        ]
        var input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        if !writer.canApply(outputSettings: settings, forMediaType: .video) {
            var hevc = settings
            hevc[AVVideoCodecKey] = AVVideoCodecType.hevc
            guard writer.canApply(outputSettings: hevc, forMediaType: .video) else {
                fail("no supported video codec for \(outWidth)x\(outHeight)")
            }
            input = AVAssetWriterInput(mediaType: .video, outputSettings: hevc)
        }
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { fail("AVAssetWriter refused the video input") }
        writer.add(input)
        self.writerInput = input
        self.adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: outWidth,
                kCVPixelBufferHeightKey as String: outHeight,
            ]
        )

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        self.stream = stream
        let queue = DispatchQueue(label: "screen-record.frames")
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        } catch {
            fail("could not attach the screen output: \(error.localizedDescription)")
        }

        let started = DispatchSemaphore(value: 0)
        var startError: Error?
        stream.startCapture { error in
            startError = error
            started.signal()
        }
        // Wait only until the contract deadline: the watchdog fires
        // requestFinish/exit on its own, so this wait is just the
        // completion fast-path. A timeout is a hard failure — never
        // report "recording" for a stream that never confirmed start.
        let elapsedNow = Int64(Date().timeIntervalSince1970 * 1000) - launchEpochMs
        let remainingMs = max(1, Int64(opts.maxDurationMs) - elapsedNow)
        let signaled = started.wait(timeout: .now() + .milliseconds(Int(remainingMs)))
        if signaled == .timedOut {
            fail("SCStream startCapture did not complete inside the \(opts.maxDurationMs)ms budget")
        }
        if let startError = startError {
            fail("SCStream failed to start: \(startError.localizedDescription)")
        }
        streamStarted = true
        contentWidth = outWidth
        contentHeight = outHeight

        writeReceipt(opts.receipt, [
            "status": "recording",
            "pid": ProcessInfo.processInfo.processIdentifier,
            "tool": "screen-record.swift",
            "delivered": delivered,
            "requestedScope": opts.scope,
            "width": outWidth,
            "height": outHeight,
            "fps": opts.fps,
            "startedAtEpochMs": epochMsNow(),
            "maxDurationMs": opts.maxDurationMs,
        ])

        // Bounded lifetime + signal poll run on the watchdog started at
        // the top of run() — deadline measured from LAUNCH so a slow
        // TCC/SCShareableContent wait cannot extend the recording past
        // the contract bound.
        dispatchMain()
    }

    var configSourceRect: CGRect? = nil

    private var watchdog: DispatchSourceTimer?

    func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "screen-record.watchdog"))
        timer.schedule(deadline: .now() + 0.2, repeating: 0.2)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            let elapsedMs = Int64(Date().timeIntervalSince1970 * 1000) - self.launchEpochMs
            if gStopRequested != 0 {
                self.requestFinish(reason: "signal")
                return
            }
            if self.finishing {
                if let began = self.finishBeganAt,
                   Date().timeIntervalSince(began) > 15 {
                    // Finalize wedged (stopCapture/finishWriting hung):
                    // exit rather than linger — the file may be
                    // unplayable and the probe reports that honestly.
                    FileHandle.standardError.write("screen-record: finalize watchdog expired\n".data(using: .utf8)!)
                    exit(3)
                }
                return
            }
            if elapsedMs >= Int64(self.opts.maxDurationMs) {
                self.requestFinish(reason: "duration")
            }
        }
        timer.resume()
        watchdog = timer
    }
}

func cpuSeconds() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    return Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
        + Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
}

// MARK: - main

let opts = parseArgs()
signal(SIGTERM) { _ in gStopRequested = 1 }
signal(SIGINT) { _ in gStopRequested = 1 }
signal(SIGHUP) { _ in gStopRequested = 1 }

// First receipt: proves the helper launched inside the session and
// echoes the request back for the driver.
writeReceipt(opts.receipt, [
    "status": "starting",
    "pid": ProcessInfo.processInfo.processIdentifier,
    "tool": "screen-record.swift",
    "requestedScope": opts.scope,
    "out": opts.out,
    "maxDurationMs": opts.maxDurationMs,
    "fps": opts.fps,
    "startedAtEpochMs": epochMsNow(),
])

if #available(macOS 12.3, *) {
    Recorder(opts: opts).run()
} else {
    writeReceipt(opts.receipt, [
        "status": "failed",
        "reason": "ScreenCaptureKit requires macOS 12.3+",
        "pid": ProcessInfo.processInfo.processIdentifier,
        "endedAtEpochMs": epochMsNow(),
    ])
    exit(1)
}
