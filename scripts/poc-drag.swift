// Real-host PoC helper for issue #369 (file/element drag-drop,
// specs/workspace-editing/spec.md §9 highest-risk cell).
//
//   swiftc -O poc-drag.swift -o poc-drag
//   ./poc-drag drag --from 100,100 --to 400,300 [--steps 24] [--step-delay-ms 16] [--dwell-ms N]
//   ./poc-drag filedrag --file /tmp/fixture.png --from 100,100 --to 400,300 [--vend fileurl|legacy]
//   ./poc-drag click --at X,Y [--tap hid|session]
//   ./poc-drag key --code N [--flags cmd,shift,opt,ctrl]
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
    var at: Point?
    var keyCode: Int?
    var flags = ""
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
        case "drag", "filedrag", "click", "key":
            if p.mode.isEmpty { p.mode = arg } else { failUsage("only one subcommand") }
        case "--file":
            p.file = takeValue()
        case "--from":
            p.from = parsePoint(takeValue(), "--from")
        case "--to":
            p.to = parsePoint(takeValue(), "--to")
        case "--at":
            p.at = parsePoint(takeValue(), "--at")
        case "--code":
            let v = takeValue()
            guard let n = Int(v), n >= 0, n <= 127 else {
                failUsage("--code expects a virtual keycode 0-127")
            }
            p.keyCode = n
        case "--flags":
            p.flags = takeValue()
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
    // --dwell-ms: hover at the drop point before releasing. Tests whether
    // the target needs settle time to arm its drop handling (#411).
    if p.dwellMs > 0 {
        usleep(UInt32(p.dwellMs) * 1000)
    }
    guard postMouse(.leftMouseUp, to, tap: tap) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create leftMouseUp\n".utf8))
        exit(1)
    }
    print("{\"ok\":true,\"mode\":\"drag\",\"from\":[\(from.x),\(from.y)],\"to\":[\(to.x),\(to.y)],\"steps\":\(p.steps),\"dwellMs\":\(p.dwellMs),\"channel\":\"\(p.tap.name)\"}")
}

// MARK: - click (plain press-release, e.g. a window close button)

func runClick(_ p: Parsed, at: Point) {
    let tap = p.tap.location
    guard postMouse(.mouseMoved, at, tap: tap) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create mouseMoved\n".utf8))
        exit(1)
    }
    usleep(30_000)
    guard postMouse(.leftMouseDown, at, tap: tap) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create leftMouseDown\n".utf8))
        exit(1)
    }
    usleep(50_000)
    guard postMouse(.leftMouseUp, at, tap: tap) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create leftMouseUp\n".utf8))
        exit(1)
    }
    print("{\"ok\":true,\"mode\":\"click\",\"at\":[\(at.x),\(at.y)],\"channel\":\"\(p.tap.name)\"}")
}

// MARK: - key (single keystroke, e.g. Cmd+M to minimize a focused window)

func cgFlags(_ spec: String) -> CGEventFlags {
    var flags = CGEventFlags()
    for part in spec.split(separator: ",") {
        switch part.trimmingCharacters(in: .whitespaces) {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "opt", "option", "alt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: break
        }
    }
    return flags
}

func runKey(_ p: Parsed, code: Int) {
    let flags = cgFlags(p.flags)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: false) else {
        FileHandle.standardError.write(Data("poc-drag: failed to create key events\n".utf8))
        exit(1)
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cgSessionEventTap)
    usleep(50_000)
    up.post(tap: .cgSessionEventTap)
    print("{\"ok\":true,\"mode\":\"key\",\"code\":\(code),\"flags\":\"\(p.flags)\",\"channel\":\"session\"}")
}

// MARK: - filedrag (NSDraggingSession source)

/// NSPasteboard does not conform to NSPasteboardWriting in the Swift
/// overlay; this adapter vends the types/data we wrote onto the board.
/// `vend` selects which flavors the dragging item advertises:
///   - "fileurl"  (default, #369): only public.file-url
///   - "legacy"   (#411): also advertises the legacy NSFilenamesPboardType
///                string. That type is not a UTI, so whether the drag
///                machinery accepts it here is itself part of the PoC —
///                if it throws/crashes the receipt records it.
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
        print("{\"ok\":true,\"mode\":\"filedrag\",\"endedAt\":[\(screenPoint.x),\(screenPoint.y)],\"operation\":\"\(opName)\",\"durationMs\":\(ms),\"vend\":\"\(vend)\"}")
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
    FileHandle.standardError.write(Data("poc-drag: filedrag starting, file=\(file) from=\(from.x),\(from.y) to=\(to.x),\(to.y)\n".utf8))

    let source = DragSource()
    source.beganAt = Date()
    source.vend = p.vend

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
    // NOT fully transparent: a zero-alpha window is skipped by WindowServer
    // hit-testing and never receives the posted mouse-down (measured —
    // first PoC run). A faint backing plus the file icon keeps the helper
    // visible for the ~1s it exists.
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
        FileHandle.standardError.write(Data("poc-drag: mouseDown received at \(event.locationInWindow)\n".utf8))
        // Build the pasteboard: file URL plus the legacy filenames type so
        // both modern (public.file-url) and classic (NSFilenamesPboardType)
        // drop targets see the file. A real NSPasteboard is the writer
        // because NSPasteboardItem rejects the legacy non-UTI type.
        let pboard = NSPasteboard(name: NSPasteboard.Name("ae-a8n-drag-poc"))
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
        let session = view.beginDraggingSession(with: [draggingItem], event: event, source: source)
        source.didBegin = session != nil
        FileHandle.standardError.write(Data("poc-drag: beginDraggingSession returned session=\(session != nil)\n".utf8))
    }
    window.contentView?.addSubview(view)
    source.window = window
    window.orderFrontRegardless()
    FileHandle.standardError.write(Data("poc-drag: window frame=\(window.frame) screen=\(NSScreen.main?.frame ?? .zero) visible=\(window.isVisible)\n".utf8))

    // Everything below runs on the main run loop: the window must be
    // ordered AND the run loop spinning before the mouse-down is posted,
    // or the event can be delivered to whatever window was under the
    // point a moment earlier.
    let pathPoints = dragPath(from: from, to: to, steps: p.steps)
    let stepDelay = UInt64(p.stepDelayMs) * 1000
    var index = 0
    var postedDown = false

    func postNext() {
        if !postedDown {
            postedDown = true
            guard postMouse(.mouseMoved, from, tap: .cgSessionEventTap) else {
                FileHandle.standardError.write(Data("poc-drag: failed to create mouseMoved\n".utf8))
                exit(1)
            }
            usleep(30_000)
            guard postMouse(.leftMouseDown, from, tap: .cgSessionEventTap) else {
                FileHandle.standardError.write(Data("poc-drag: failed to create leftMouseDown\n".utf8))
                exit(1)
            }
            FileHandle.standardError.write(Data("poc-drag: posted mouseMoved+leftMouseDown at \(from.x),\(from.y)\n".utf8))
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
                _ = postMouse(.leftMouseUp,
                              Point(x: Double(pt.x), y: Double(pt.y)), tap: .cgSessionEventTap)
                FileHandle.standardError.write(Data("poc-drag: posted leftMouseUp at \(pt.x),\(pt.y) dwellMs=\(p.dwellMs)\n".utf8))
            }
        } else {
            _ = postMouse(.leftMouseDragged,
                          Point(x: Double(pt.x), y: Double(pt.y)), tap: .cgSessionEventTap)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(stepDelay))) {
            postNext()
        }
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(400)) {
        postNext()
    }

    // Watchdogs: if the session never begins or never ends, fail honestly.
    // `endedAt` exits 0, so reaching a watchdog means something is stuck.
    DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(10)) {
        guard !source.didBegin else { return }
        FileHandle.standardError.write(Data("poc-drag: timed out waiting for drag session to begin\n".utf8))
        window.orderOut(nil)
        exit(1)
    }
    let expectedMs = 120 + p.steps * p.stepDelayMs + p.dwellMs + 5_000
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
if p.mode == "click" {
    guard let at = p.at else { failUsage("click expects --at X,Y") }
    runClick(p, at: at)
} else if p.mode == "key" {
    guard let code = p.keyCode else { failUsage("key expects --code N") }
    runKey(p, code: code)
} else {
    guard p.from != nil, p.to != nil else {
        failUsage("\(p.mode) expects --from X,Y --to X,Y")
    }
}

switch p.mode {
case "drag":
    runPlainDrag(p, from: p.from!, to: p.to!)
case "filedrag":
    guard let file = p.file else { failUsage("filedrag expects --file PATH") }
    runFileDrag(p, file: file, from: p.from!, to: p.to!)
case "click", "key":
    break // already handled above
default:
    failUsage("missing or unknown subcommand (expected: drag, filedrag, click or key)")
}
