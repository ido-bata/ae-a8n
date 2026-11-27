// Real-host PoC helper for issue #369 (file/element drag-drop,
// specs/workspace-editing/spec.md §9 highest-risk cell).
//
//   swiftc -O poc-drag.swift -o poc-drag
//   ./poc-drag drag --from 100,100 --to 400,300 [--steps 24] [--step-delay-ms 16]
//   ./poc-drag filedrag --file /tmp/fixture.png --from 100,100 --to 400,300
//
// `drag` posts a plain CGEvent press-drag-release: mouseMoved, leftMouseDown,
// a series of leftMouseDragged events, leftMouseUp. Whether AE treats that
// sequence as a real drag is exactly what the PoC measures.
//
// `filedrag` goes further: a plain CGEvent drag carries NO file payload —
// macOS file drops require an NSDraggingSession vendored by a source app.
// This subcommand creates a tiny borderless NSWindow at --from, and on the
// posted mouse-down calls -[NSView beginDraggingSession] with an
// NSDraggingItem whose pasteboard vends the fixture file URL. The OS drag
// manager then tracks the cursor; the same process posts the move/up
// CGEvents along the path to --to. The window is ours (this helper), the
// file is the caller's fixture — no foreign app is touched.
//
// Coordinates are global display points, top-left origin — the same space
// CGWindowList bounds and AX frames report.
//
// Output is one JSON receipt on stdout; diagnostics on stderr. Usage
// errors exit 2 BEFORE anything is posted; runtime failures exit 1.
import Cocoa
import CoreGraphics

let USAGE = """
usage:
  poc-drag drag --from X,Y --to X,Y [--steps N] [--step-delay-ms N] [--tap hid|session]
  poc-drag filedrag --file PATH --from X,Y --to X,Y [--steps N] [--step-delay-ms N]

--from/--to are global display points (top-left origin). --steps defaults
 to 24, --step-delay-ms to 16. `filedrag` shows a small borderless helper
window at --from for the duration of the drag.
"""

func failUsage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("poc-drag: \(message)\n\(USAGE)".utf8))
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
    var steps = 24
    var stepDelayMs = 16
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
        case "drag", "filedrag":
            if p.mode.isEmpty { p.mode = arg } else { failUsage("only one subcommand") }
        case "--file":
            p.file = takeValue()
        case "--from":
            p.from = parsePoint(takeValue(), "--from")
        case "--to":
            p.to = parsePoint(takeValue(), "--to")
        case "--steps":
            let v = takeValue()
            guard let n = Int(v), n > 0 else { failUsage("--steps expects a positive integer") }
            p.steps = n
        case "--step-delay-ms":
            let v = takeValue()
            guard let n = Int(v), n >= 0 else { failUsage("--step-delay-ms expects a non-negative integer") }
            p.stepDelayMs = n
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

func postMouse(_ type: CGEventType, _ p: Point, button: CGMouseButton = .left,
               tap: CGEventTapLocation) -> Bool {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                              mouseCursorPosition: cgPoint(p), mouseButton: button) else {
        return false
    }
    event.post(tap: tap)
    return true
}

/// The interpolated drag path shared by both subcommands.
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

func runPlainDrag(_ p: Parsed, from: Point, to: Point) {
    let tap = p.tap.location
    guard postMouse(.mouseMoved, from, tap: tap) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create mouseMoved\n".utf8))
        exit(1)
    }
    usleep(30_000)
    guard postMouse(.leftMouseDown, from, tap: tap) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create leftMouseDown\n".utf8))
        exit(1)
    }
    usleep(30_000)
    for point in dragPath(from: from, to: to, steps: p.steps).dropFirst() {
        let cg = CGPoint(x: point.x, y: point.y)
        guard let event = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged,
                                  mouseCursorPosition: cg, mouseButton: .left) else {
            FileHandle.standardError.write(Data("poc-drag: failed to create leftMouseDragged\n".utf8))
            exit(1)
        }
        event.post(tap: tap)
        usleep(UInt32(p.stepDelayMs) * 1000)
    }
    guard postMouse(.leftMouseUp, to, tap: tap) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create leftMouseUp\n".utf8))
        exit(1)
    }
    print("{\"ok\":true,\"mode\":\"drag\",\"from\":[\(from.x),\(from.y)],\"to\":[\(to.x),\(to.y)],\"steps\":\(p.steps),\"channel\":\"\(p.tap.name)\"}")
}

// MARK: - filedrag (NSDraggingSession source)

final class DragSource: NSObject, NSDraggingSource {
    var window: NSWindow?
    var didBegin = false
    var beganAt = Date()

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
        print("{\"ok\":true,\"mode\":\"filedrag\",\"endedAt\":[\(screenPoint.x),\(screenPoint.y)],\"operation\":\"\(opName)\",\"durationMs\":\(ms)}")
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
    let path = (file as NSString).expandingTildeInPath
    guard FileManager.default.fileExists(atPath: path) else {
        FileHandle.standardError.write(Data("poc-drag: --file does not exist: \(path)\n".utf8))
        exit(2)
    }
    let fileURL = URL(fileURLWithPath: path)

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    let source = DragSource()
    source.beganAt = Date()

    // Small borderless window centered on --from. It is ordered front at
    // floating level so the posted mouse-down lands on OUR view, not on
    // whatever app happens to sit under the point.
    let half: CGFloat = 24
    let screenHeight = NSScreen.main?.frame.height ?? 0
    // CGEvent points are top-left origin; NSWindow frames are bottom-left.
    let frame = NSRect(
        x: from.x - Double(half),
        y: screenHeight - from.y - Double(half),
        width: Double(half * 2), height: Double(half * 2))
    let window = NSWindow(contentRect: frame,
                          styleMask: [.borderless],
                          backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.level = .floating
    window.isReleasedWhenClosed = false
    window.collectionBehavior = [.canJoinAllSpaces, .stationary]
    let view = DragView(frame: NSRect(x: 0, y: 0, width: half * 2, height: half * 2))
    view.onMouseDown = { event in
        // Build the pasteboard item: file URL plus the legacy filenames
        // type so both modern and classic drop targets see the file.
        let pbItem = NSPasteboardItem()
        pbItem.setString(fileURL.absoluteString, forType: .fileURL)
        pbItem.setPropertyList([fileURL.path],
                               forType: NSPasteboard.PasteboardType("NSFilenamesPboardType"))
        let draggingItem = NSDraggingItem(pasteboardWriter: pbItem)
        let icon = NSWorkspace.shared.icon(forFile: path)
        icon.size = NSSize(width: 48, height: 48)
        draggingItem.setDraggingFrame(
            NSRect(x: 0, y: 0, width: 48, height: 48), contents: icon)
        source.didBegin = true
        view.beginDraggingSession(with: [draggingItem], event: event, source: source)
    }
    window.contentView?.addSubview(view)
    source.window = window
    window.orderFrontRegardless()

    // Post the initial mouse-down at --from; it is delivered to our view,
    // whose mouseDown starts the dragging session.
    guard postMouse(.mouseMoved, from, tap: .cgSessionEventTap) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create mouseMoved\n".utf8))
        exit(1)
    }
    usleep(30_000)
    guard postMouse(.leftMouseDown, from, tap: .cgSessionEventTap) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create leftMouseDown\n".utf8))
        exit(1)
    }

    // Drive the drag path on the main run loop. The dragging session is
    // owned by the WindowServer once begun; posted CGEvents move the
    // session's cursor exactly like real mouse movement.
    let pathPoints = dragPath(from: from, to: to, steps: p.steps)
    let stepDelay = UInt64(p.stepDelayMs) * 1000
    var index = 1
    func scheduleNext() {
        guard index <= pathPoints.count - 1 else {
            // Final point: release.
            let last = pathPoints.last!
            _ = postMouse(.leftMouseUp,
                          Point(x: Double(last.x), y: Double(last.y)), tap: .cgSessionEventTap)
            return
        }
        let pt = pathPoints[index]
        _ = postMouse(.leftMouseDragged,
                      Point(x: Double(pt.x), y: Double(pt.y)), tap: .cgSessionEventTap)
        index += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(stepDelay))) {
            scheduleNext()
        }
    }
    // Give the mouse-down a moment to reach the view and begin the session
    // before the first move is posted.
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(120)) {
        scheduleNext()
    }

    // Watchdogs: if the session never begins or never ends, fail honestly.
    // `endedAt` exits 0, so reaching a watchdog means something is stuck.
    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(10)) {
        guard !source.didBegin else { return }
        FileHandle.standardError.write(Data("poc-drag: timed out waiting for drag session to begin\n".utf8))
        window.orderOut(nil)
        exit(1)
    }
    let expectedMs = 120 + p.steps * p.stepDelayMs + 5_000
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(expectedMs)) {
        FileHandle.standardError.write(Data("poc-drag: timed out waiting for drag session to end\n".utf8))
        window.orderOut(nil)
        exit(1)
    }

    app.run()
}

// MARK: - main

guard CommandLine.arguments.count >= 2 else { failUsage("missing subcommand") }
let args = Array(CommandLine.arguments.dropFirst())
let p = parse(args)
guard let from = p.from, let to = p.to else {
    failUsage("\(p.mode) expects --from X,Y --to X,Y")
}

switch p.mode {
case "drag":
    runPlainDrag(p, from: from, to: to)
case "filedrag":
    guard let file = p.file else { failUsage("filedrag expects --file PATH") }
    runFileDrag(p, file: file, from: from, to: to)
default:
    failUsage("missing or unknown subcommand (expected: drag or filedrag)")
}
