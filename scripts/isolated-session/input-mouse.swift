// Posts mouse clicks through the macOS event stream — the #368 half of
// the B-WORKSPACE context-menu contract (specs/workspace-editing/spec.md
// §9 "Context menu invoke", issue #368, parent #345 / program #337).
//
//   swiftc -O input-mouse.swift -o input-mouse
//   ./input-mouse click --x 640 --y 480 --button right --tap session
//
// SAFETY: this helper posts REAL mouse events. It is a delivery vehicle
// only — every ae-a8n context-menu operation must arrive through the
// ContextMenuController gate chain (src/contextmenu/) with the mutation
// gate, the GUI lease and the re-verified target frame already satisfied.
// Running it by hand clicks whatever happens to be under the point.
//
// The coordinates are global display points (top-left origin), the same
// space the Accessibility frames and the WindowServer census report —
// callers must derive them from a re-verified frame, never from memory.
// `click` moves the cursor to the point, presses the button and releases
// it: three CGEvents. Whether a right-button post at a session tap
// actually opens After Effects' context menus is UNVERIFIED until a
// real-host run records it (spec §11).
//
// Output is one JSON receipt on stdout; diagnostics on stderr. Usage
// errors exit 2 BEFORE anything is posted; runtime failures exit 1.
import CoreGraphics
import Foundation

let USAGE = """
usage:
  input-mouse click --x N --y N --button left|right|middle [--tap hid|session]

--x/--y are global display points (top-left origin). --button defaults
to left. The tap defaults to session (kCGSessionEventTap); hid selects
kCGHIDEventTap. Only `click` exists in this slice — drag/scroll/hover
have no helper yet and callers must refuse them rather than post blind.
"""

func failUsage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("input-mouse: \(message)\n\(USAGE)".utf8))
    exit(2)
}

enum TapKind {
    case hid, session

    var location: CGEventTapLocation {
        switch self {
        case .hid: return .cghidEventTap
        case .session: return .cgSessionEventTap
        }
    }
    var name: String {
        switch self {
        case .hid: return "hid"
        case .session: return "session"
        }
    }
}

enum MouseButton {
    case left, right, middle

    var downType: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }
    var upType: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }
    var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }
}

struct Parsed {
    var x: Int?
    var y: Int?
    var button: MouseButton = .left
    var tap: TapKind = .session
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
        case "--x":
            let v = takeValue()
            guard let n = Int(v) else { failUsage("--x expects an integer") }
            p.x = n
        case "--y":
            let v = takeValue()
            guard let n = Int(v) else { failUsage("--y expects an integer") }
            p.y = n
        case "--button":
            let v = takeValue().lowercased()
            guard let b = ["left": MouseButton.left, "right": MouseButton.right,
                           "middle": MouseButton.middle][v] else {
                failUsage("--button expects left, right or middle")
            }
            p.button = b
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

// MARK: - main

guard CommandLine.arguments.count >= 2,
      CommandLine.arguments[1] == "click" else {
    failUsage("missing or unknown subcommand (expected: click)")
}

let p = parse(Array(CommandLine.arguments.dropFirst(2)))
guard let x = p.x, let y = p.y else {
    failUsage("click expects --x N --y N")
}

let point = CGPoint(x: x, y: y)
let button = p.button

// Move, press, release — the same three-event shape every OS treats as a
// click. The move is posted first so hover state does not leak a stale
// position into the press.
guard let moved = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                          mouseCursorPosition: point, mouseButton: .left) else {
    FileHandle.standardError.write(Data("input-mouse: failed to create mouseMoved event\n".utf8))
    exit(1)
}
guard let down = CGEvent(mouseEventSource: nil, mouseType: button.downType,
                         mouseCursorPosition: point, mouseButton: button.cgButton),
      let up = CGEvent(mouseEventSource: nil, mouseType: button.upType,
                       mouseCursorPosition: point, mouseButton: button.cgButton) else {
    FileHandle.standardError.write(Data("input-mouse: failed to create click events\n".utf8))
    exit(1)
}

moved.post(tap: p.tap.location)
usleep(20_000)
down.post(tap: p.tap.location)
usleep(20_000)
up.post(tap: p.tap.location)

print("{\"ok\":true,\"action\":\"click\",\"button\":\"\(buttonName(button))\",\"x\":\(x),\"y\":\(y),\"channel\":\"\(p.tap.name)\"}")

func buttonName(_ b: MouseButton) -> String {
    switch b {
    case .left: return "left"
    case .right: return "right"
    case .middle: return "middle"
    }
}
