// Posts mouse drags through the macOS event stream — the #422 half of
// the B-WORKSPACE drag-drop contract (specs/workspace-editing/spec.md
// §9 "File/element drag-drop", issue #422, parent #345 / program #337).
// The vehicle shapes are the ones the #411 real-host PoC proved on
// owned AE 2027 (docs/evidence/realhost-2026-11-27/drag-alt-411/).
//
//   swiftc -O input-drag.swift -o input-drag
//   ./input-drag press   --x 640 --y 480 [--tap hid|session]
//   ./input-drag move    --x 640 --y 480 [--tap hid|session]
//   ./input-drag release --x 640 --y 480 [--tap hid|session]
//   ./input-drag filedrag --file /tmp/fixture.png --from 100,100 --to 400,300 \
//       [--steps 24] [--step-delay-ms 16] [--dwell-ms N] [--vend fileurl|legacy]
//
// SAFETY: this helper posts REAL mouse events and, for `filedrag`,
// vends a REAL NSDraggingSession carrying the caller's file. It is a
// delivery vehicle only — every ae-a8n drag-drop operation must arrive
// through the DragDropController gate chain (src/dragdrop/) with the
// mutation gate, the GUI lease, the re-verified surface frame and the
// census topmost-owned proof already satisfied. Running it by hand
// drags whatever happens to be under the point.
//
// `press`/`move`/`release` are deliberately separate invocations: the
// controller interleaves them with its own census re-checks, so one
// process per segment is the honest shape — CGEvent button state lives
// in the window server, not in this process.
//
// Coordinates are global display points (top-left origin), the same
// space the Accessibility frames and the WindowServer census report —
// callers must derive them from a re-verified frame, never from memory.
//
// Output is one JSON receipt on stdout; diagnostics on stderr. Usage
// errors exit 2 BEFORE anything is posted; runtime failures exit 1.
// A provable non-mutation reports `"verdict":"not-performed"` on stdout
// with exit 0 — the caller maps it to a refusal, not a retry.
import Cocoa
import CoreGraphics
import Foundation

let USAGE = """
usage:
  input-drag press   --x N --y N [--tap hid|session]
  input-drag move    --x N --y N [--tap hid|session]
  input-drag release --x N --y N [--tap hid|session]
  input-drag filedrag --file PATH --from X,Y --to X,Y
      [--steps N] [--step-delay-ms N] [--dwell-ms N] [--vend fileurl|legacy]

--x/--y are global display points (top-left origin). --steps defaults
to 24, --step-delay-ms to 16, --dwell-ms to 0. `filedrag` shows a small
borderless helper window at --from for the duration of the drag.
"""

func failUsage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("input-drag: \(message)\n\(USAGE)".utf8))
    exit(2)
}

struct Point {
    let x: Double
    let y: Double
}

enum TapKind {
    case hid, session
    var location: CGEventTapLocation {
        switch self {
        case .hid: return .cghidEventTap
        case .session: return .cgSessionEventTap
        }
    }
    var name: String { self == .hid ? "hid" : "session" }
}

struct Parsed {
    var mode = ""
    var file: String?
    var from: Point?
    var to: Point?
    var x: Int?
    var y: Int?
    var steps = 24
    var stepDelayMs = 16
    var dwellMs = 0
    var vend = "fileurl"
    var tap = TapKind.session
}

func parsePoint(_ value: String, _ flag: String) -> Point {
    let parts = value.split(separator: ",")
    guard parts.count == 2,
          let x = Double(parts[0]), let y = Double(parts[1]) else {
        failUsage("\(flag) expects X,Y numbers")
    }
    return Point(x: x, y: y)
}

func parse(_ args: [String]) -> Parsed {
    var p = Parsed()
    var i = 0
    while i < args.count {
        let arg = args[i]
        func takeValue() -> String {
            i += 1
            guard i < args.count else { failUsage("\(arg) expects a value") }
            return args[i]
        }
        switch arg {
        case "press", "move", "release", "filedrag":
            if p.mode.isEmpty { p.mode = arg } else { failUsage("only one subcommand") }
        case "--file":
            p.file = takeValue()
        case "--from":
            p.from = parsePoint(takeValue(), "--from")
        case "--to":
            p.to = parsePoint(takeValue(), "--to")
        case "--x":
            let v = takeValue()
            guard let n = Int(v) else { failUsage("--x expects an integer") }
            p.x = n
        case "--y":
            let v = takeValue()
            guard let n = Int(v) else { failUsage("--y expects an integer") }
            p.y = n
        case "--steps":
            let v = takeValue()
            guard let n = Int(v), n > 0 else { failUsage("--steps expects a positive integer") }
            p.steps = n
        case "--step-delay-ms":
            let v = takeValue()
            guard let n = Int(v), n >= 0 else { failUsage("--step-delay-ms expects a non-negative integer") }
            p.stepDelayMs = n
        case "--dwell-ms":
            let v = takeValue()
            guard let n = Int(v), n >= 0 else { failUsage("--dwell-ms expects a non-negative integer") }
            p.dwellMs = n
        case "--vend":
            let v = takeValue()
            guard ["fileurl", "legacy"].contains(v) else {
                failUsage("--vend expects fileurl or legacy")
            }
            p.vend = v
        case "--tap":
            let v = takeValue()
            guard let tap = ["hid": TapKind.hid, "session": TapKind.session][v] else {
                failUsage("--tap expects hid or session")
            }
            p.tap = tap
        default:
            if arg.hasPrefix("--") { failUsage("unknown option \(arg)") }
            failUsage("unexpected argument \(arg)")
        }
        i += 1
    }
    return p
}

// MARK: - CGEvent posting

func cgPoint(_ p: Point) -> CGPoint { CGPoint(x: p.x, y: p.y) }

func makeMouse(_ type: CGEventType, _ p: Point) -> CGEvent? {
    return CGEvent(mouseEventSource: nil, mouseType: type,
                   mouseCursorPosition: cgPoint(p), mouseButton: .left)
}

/// The interpolated drag path shared by `filedrag`'s internal segments.
func dragPath(from: Point, to: Point, steps: Int) -> [CGPoint] {
    var points: [CGPoint] = []
    for i in 0...steps {
        let t = CGFloat(i) / CGFloat(steps)
        points.append(CGPoint(
            x: from.x + (to.x - from.x) * Double(t),
            y: from.y + (to.y - from.y) * Double(t)))
    }
    return points
}

// MARK: - segmented press/move/release

/// One segment of the controller-driven drag. Each invocation posts its
/// own events; the button state lives in the window server between them.
func runSegment(_ p: Parsed, action: String) {
    guard let x = p.x, let y = p.y else {
        failUsage("\(action) expects --x N --y N")
    }
    let point = Point(x: Double(x), y: Double(y))

    var events: [CGEvent] = []
    switch action {
    case "press":
        // Move first so hover state does not leak a stale position into
        // the press — the same three-event shape input-mouse click uses.
        guard let moved = makeMouse(.mouseMoved, point),
              let down = makeMouse(.leftMouseDown, point) else {
            // Nothing mutation-bearing was posted: a provable
            // non-mutation, reported as such rather than as a failure.
            print("{\"ok\":true,\"action\":\"press\",\"verdict\":\"not-performed\",\"reason\":\"event-creation-failed\",\"x\":\(x),\"y\":\(y)}")
            exit(0)
        }
        events = [moved, down]
    case "move":
        guard let dragged = makeMouse(.leftMouseDragged, point) else {
            print("{\"ok\":false,\"action\":\"move\",\"verdict\":\"failed\",\"reason\":\"event-creation-failed\",\"x\":\(x),\"y\":\(y)}")
            exit(1)
        }
        events = [dragged]
    default: // release
        guard let up = makeMouse(.leftMouseUp, point) else {
            print("{\"ok\":false,\"action\":\"release\",\"verdict\":\"failed\",\"reason\":\"event-creation-failed\",\"x\":\(x),\"y\":\(y)}")
            exit(1)
        }
        events = [up]
    }

    // Small inter-event delays match the proven #411 pacing.
    for (index, event) in events.enumerated() {
        if index > 0 { usleep(20_000) }
        event.post(tap: p.tap.location)
    }
    if action == "press" { usleep(20_000) }
    print("{\"ok\":true,\"action\":\"\(action)\",\"verdict\":\"performed\",\"x\":\(x),\"y\":\(y),\"channel\":\"\(p.tap.name)\"}")
}

// MARK: - filedrag (NSDraggingSession source)

/// NSPasteboard does not conform to NSPasteboardWriting in the Swift
/// overlay; this adapter vends the types/data we wrote onto the board.
/// `vend` selects which flavors the dragging item advertises:
///   - "fileurl"  (default, #411-proven): only public.file-url
///   - "legacy"   (#411): also advertises the legacy NSFilenamesPboardType
///                string. That type is not a UTI, so whether the drag
///                machinery accepts it here is itself part of the
///                vehicle — if it throws/crashes the receipt records it.
final class BoardWriter: NSObject, NSPasteboardWriting {
    let board: NSPasteboard
    let vend: String
    init(_ board: NSPasteboard, vend: String) {
        self.board = board
        self.vend = vend
    }
    func writableTypes(for pasteboard: NSPasteboard) -> [NSPasteboard.PasteboardType] {
        if vend == "legacy" {
            return [
                .fileURL,
                NSPasteboard.PasteboardType("NSFilenamesPboardType"),
                NSPasteboard.PasteboardType("public.utf8-plain-text"),
            ]
        }
        return [.fileURL]
    }
    func pasteboardPropertyList(forType type: NSPasteboard.PasteboardType) -> Any? {
        if vend == "legacy" && type == NSPasteboard.PasteboardType("public.utf8-plain-text") {
            // Finder also vends the bare filename as plain text.
            return (board.propertyList(forType: .fileURL) as? String)?
                .split(separator: "/").last.map(String.init)
        }
        return board.propertyList(forType: type)
    }
}

final class DragSource: NSObject, NSDraggingSource {
    var window: NSWindow?
    var didBegin = false
    var beganAt = Date()
    var vend = "fileurl"
    var fileName = ""

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        return [.copy, .generic]
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        window?.orderOut(nil)
        let opName: String
        switch operation {
        case .copy: opName = "copy"
        case .move: opName = "move"
        case .link: opName = "link"
        case .generic: opName = "generic"
        case .delete: opName = "delete"
        case []: opName = "none"
        default: opName = "other(\(operation.rawValue))"
        }
        let ms = Int(Date().timeIntervalSince(beganAt) * 1000)
        // "performed" means the NSDraggingSession ran its course and
        // reported an end — it says NOTHING about whether the drop
        // landed; that is the DOM oracle's job on the caller side.
        print("{\"ok\":true,\"action\":\"filedrag\",\"verdict\":\"performed\",\"endedAt\":[\(screenPoint.x),\(screenPoint.y)],\"operation\":\"\(opName)\",\"durationMs\":\(ms),\"vend\":\"\(vend)\",\"file\":\"\(fileName)\"}")
        exit(0)
    }

    func draggingSession(_ session: NSDraggingSession, movedTo screenPoint: NSPoint) {}
}

final class DragView: NSView {
    var onMouseDown: ((NSEvent) -> Void)?
    override func mouseDown(with event: NSEvent) { onMouseDown?(event) }
    override var acceptsFirstResponder: Bool { true }
}

func runFileDrag(_ p: Parsed, file: String, from: Point, to: Point) {
    guard let filePath = p.file, let fromPoint = p.from, let toPoint = p.to else {
        failUsage("filedrag expects --file PATH --from X,Y --to X,Y")
    }
    let path = (filePath as NSString).expandingTildeInPath
    guard FileManager.default.fileExists(atPath: path) else {
        FileHandle.standardError.write(Data("input-drag: --file does not exist: \(path)\n".utf8))
        exit(2)
    }
    let fileURL = URL(fileURLWithPath: path)

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    FileHandle.standardError.write(Data("input-drag: filedrag starting, file=\(filePath) from=\(fromPoint.x),\(fromPoint.y) to=\(toPoint.x),\(toPoint.y)\n".utf8))

    let source = DragSource()
    source.beganAt = Date()
    source.vend = p.vend
    source.fileName = fileURL.lastPathComponent

    // Small borderless window centered on --from. It is ordered front at
    // floating level so the posted mouse-down lands on OUR view, not on
    // whatever app happens to sit under the point. NOT fully transparent:
    // a zero-alpha window is skipped by WindowServer hit-testing and
    // never receives the posted mouse-down (measured in the #411 PoC).
    let half: CGFloat = 24
    let screenHeight = NSScreen.main?.frame.height ?? 0
    // CGEvent points are top-left origin; NSWindow frames are bottom-left.
    let frame = NSRect(
        x: fromPoint.x - Double(half),
        y: screenHeight - fromPoint.y - Double(half),
        width: Double(half * 2), height: Double(half * 2))
    let window = NSWindow(contentRect: frame,
                          styleMask: [.borderless],
                          backing: .buffered, defer: false)
    window.isOpaque = true
    window.backgroundColor = NSColor(calibratedWhite: 0.15, alpha: 0.85)
    window.hasShadow = true
    window.level = .floating
    window.isReleasedWhenClosed = false
    window.collectionBehavior = [.canJoinAllSpaces, .stationary]
    let view = DragView(frame: NSRect(x: 0, y: 0, width: half * 2, height: half * 2))
    view.wantsLayer = true
    let icon = NSWorkspace.shared.icon(forFile: path)
    icon.size = NSSize(width: 40, height: 40)
    view.layer?.contents = icon
    view.layer?.contentsGravity = .resizeAspect
    view.layer?.cornerRadius = 6
    view.onMouseDown = { event in
        FileHandle.standardError.write(Data("input-drag: mouseDown received at \(event.locationInWindow)\n".utf8))
        // Build the pasteboard: file URL plus the legacy filenames type so
        // both modern (public.file-url) and classic (NSFilenamesPboardType)
        // drop targets see the file. A real NSPasteboard is the writer
        // because NSPasteboardItem rejects the legacy non-UTI type.
        let pboard = NSPasteboard(name: NSPasteboard.Name("ae-a8n-drag-input"))
        pboard.declareTypes([
            .fileURL,
            NSPasteboard.PasteboardType("NSFilenamesPboardType"),
            NSPasteboard.PasteboardType("public.utf8-plain-text"),
        ], owner: nil)
        pboard.setString(fileURL.absoluteString, forType: .fileURL)
        pboard.setPropertyList([fileURL.path],
                               forType: NSPasteboard.PasteboardType("NSFilenamesPboardType"))
        pboard.setString(fileURL.lastPathComponent,
                         forType: NSPasteboard.PasteboardType("public.utf8-plain-text"))
        let draggingItem = NSDraggingItem(pasteboardWriter: BoardWriter(pboard, vend: p.vend))
        draggingItem.setDraggingFrame(
            NSRect(x: 0, y: 0, width: 48, height: 48), contents: icon)
        // Non-optional on this SDK: a returned session IS a begun drag.
        _ = view.beginDraggingSession(with: [draggingItem], event: event, source: source)
        source.didBegin = true
        FileHandle.standardError.write(Data("input-drag: beginDraggingSession returned a session\n".utf8))
    }
    window.contentView?.addSubview(view)
    source.window = window
    window.orderFrontRegardless()

    // Everything below runs on the main run loop: the window must be
    // ordered AND the run loop spinning before the mouse-down is posted,
    // or the event can be delivered to whatever window was under the
    // point a moment earlier.
    let pathPoints = dragPath(from: fromPoint, to: toPoint, steps: p.steps)
    let stepDelay = UInt64(p.stepDelayMs) * 1000
    var index = 0
    var postedDown = false

    func postNext() {
        if !postedDown {
            postedDown = true
            guard let moved = makeMouse(.mouseMoved, fromPoint) else {
                FileHandle.standardError.write(Data("input-drag: failed to create mouseMoved\n".utf8))
                exit(1)
            }
            moved.post(tap: .cgSessionEventTap)
            usleep(30_000)
            guard let down = makeMouse(.leftMouseDown, fromPoint) else {
                FileHandle.standardError.write(Data("input-drag: failed to create leftMouseDown\n".utf8))
                exit(1)
            }
            down.post(tap: .cgSessionEventTap)
            // Give the event time to reach the view and begin the session
            // before the first move is posted.
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(150)) {
                postNext()
            }
            return
        }
        guard index <= pathPoints.count - 1 else { return }
        let pt = pathPoints[index]
        index += 1
        if index == pathPoints.count {
            // --dwell-ms: keep hovering at the drop point before release.
            let upDelay = p.dwellMs > 0 ? p.dwellMs : 0
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(upDelay)) {
                if let up = makeMouse(.leftMouseUp,
                                      Point(x: Double(pt.x), y: Double(pt.y))) {
                    up.post(tap: .cgSessionEventTap)
                }
            }
        } else {
            if let dragged = makeMouse(.leftMouseDragged,
                                       Point(x: Double(pt.x), y: Double(pt.y))) {
                dragged.post(tap: .cgSessionEventTap)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(stepDelay))) {
            postNext()
        }
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(400)) {
        postNext()
    }

    // Watchdogs: if the session never begins the drag provably never
    // happened — report not-performed. If it began but never ended, the
    // outcome is unknown — fail so the caller reports indeterminate.
    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(10)) {
        guard !source.didBegin else { return }
        window.orderOut(nil)
        print("{\"ok\":true,\"action\":\"filedrag\",\"verdict\":\"not-performed\",\"reason\":\"session-never-began\",\"vend\":\"\(p.vend)\",\"file\":\"\(source.fileName)\"}")
        exit(0)
    }
    let expectedMs = 120 + p.steps * p.stepDelayMs + p.dwellMs + 5_000
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(expectedMs)) {
        FileHandle.standardError.write(Data("input-drag: timed out waiting for drag session to end\n".utf8))
        window.orderOut(nil)
        exit(1)
    }

    app.run()
}

// MARK: - main

guard CommandLine.arguments.count >= 2 else { failUsage("missing subcommand") }
let args = Array(CommandLine.arguments.dropFirst())
let p = parse(args)
switch p.mode {
case "press": runSegment(p, action: "press")
case "move": runSegment(p, action: "move")
case "release": runSegment(p, action: "release")
case "filedrag": runFileDrag(p, file: p.file ?? "", from: p.from ?? Point(x: 0, y: 0), to: p.to ?? Point(x: 0, y: 0))
default: failUsage("missing or unknown subcommand (expected: press|move|release|filedrag)")
}
