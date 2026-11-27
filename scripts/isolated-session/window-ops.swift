// Window operations helper for ae-a8n (#366,
// specs/workspace-editing/spec.md §9 "window ops cycle").
//
//   swiftc -O window-ops.swift -o window-ops
//   ./window-ops state --pid 4242
//   ./window-ops act --pid 4242 --op move --title "" --subrole "-" \
//       --frame "0,39,1710,1073" --x 100 --y 100
//
// Two subcommands:
//
//   state — read-only listing of the process's AX windows with the
//           attributes window ops need: frame (AXPosition/AXSize),
//           AXMiniaturized, AXMain, AXFocused, plus the frontmost pid and
//           which window index holds keyboard focus. One JSON object on
//           stdout. Missing attributes are null, never guessed.
//
//           Two extra read-only fields carry the AE non-vending shape
//           (#406): `axTrusted` is AXIsProcessTrusted() for the helper's
//           own process, and `focusedWindow` describes the app's
//           AXFocusedWindow element — the ONLY window After Effects
//           vends on hosts where AXWindows/AXChildren/UI-elements
//           enumeration returns nothing (verified on real host,
//           docs/evidence/realhost-2026-11-27/). It is evidence for
//           observe-class focused-window resolution only; nothing in
//           `act` addresses it, because `act` re-lists `windows` and
//           would report not-found rather than guess.
//
//   act   — one mutation addressed by *identity*, never by index: the
//           caller passes the frame (+ optional title/subrole) it
//           resolved, the helper re-lists inside the same process run,
//           matches within 4pt, refuses on 0 or >1 candidates, applies
//           the op through AXUIElementSetAttributeValue /
//           AXUIElementPerformAction, then re-reads the same element's
//           post-state. Verdicts: performed / not-found / ambiguous /
//           failed / missing. "changed" is not a verdict here — a
//           non-match is simply not-found/ambiguous, and the caller's
//           own re-resolution owns staleness.
//
// Ops: move (AXPosition), resize (AXSize), minimize (AXMiniaturized=1),
// restore (AXMiniaturized=0), maximize (frame = containing display's
// CGDisplayBounds), focus (app activate + AXMain + AXFocused + AXRaise).
//
// This helper mutates ONLY windows of the pid it is given, resolved
// through AXUIElementCreateApplication(pid) — it has no path to another
// process's windows. It is a delivery vehicle: every call must arrive
// through the ae-a8n mutation gate chain (lease + audit + owned
// attribution + gate), exactly like the input-* helpers (#372).
//
// Output is JSON on stdout; diagnostics on stderr. Exit 0 even for
// "not-found" — an honest refusal is data, not an error.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

let FRAME_TOLERANCE = 4.0

// MARK: - AX helpers

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? value : nil
}

func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let s = value as? String, !s.isEmpty { return s }
    return nil
}

/// AXValue-typed attributes arrive as AXValueRef; pull the CGPoint/CGSize out.
func axPoint(_ element: AXUIElement, _ name: String) -> CGPoint? {
    guard let raw = attribute(element, name) else { return nil }
    var point = CGPoint.zero
    guard AXValueGetType(raw as! AXValue) == .cgPoint,
          AXValueGetValue(raw as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ element: AXUIElement, _ name: String) -> CGSize? {
    guard let raw = attribute(element, name) else { return nil }
    var size = CGSize.zero
    guard AXValueGetType(raw as! AXValue) == .cgSize,
          AXValueGetValue(raw as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func axBool(_ element: AXUIElement, _ name: String) -> Bool? {
    guard let value = attribute(element, name) as? NSNumber else { return nil }
    return value.boolValue
}

func setAX(_ element: AXUIElement, _ name: String, _ point: CGPoint) -> AXError {
    var p = point
    guard let value = AXValueCreate(.cgPoint, &p) else { return .failure }
    return AXUIElementSetAttributeValue(element, name as CFString, value)
}

func setAX(_ element: AXUIElement, _ name: String, _ size: CGSize) -> AXError {
    var s = size
    guard let value = AXValueCreate(.cgSize, &s) else { return .failure }
    return AXUIElementSetAttributeValue(element, name as CFString, value)
}

func setAX(_ element: AXUIElement, _ name: String, _ flag: Bool) -> AXError {
    return AXUIElementSetAttributeValue(
        element, name as CFString, flag as CFBoolean)
}

// MARK: - Window enumeration

/// Roles that count as a top-level window surface for window ops.
/// AXWindows normally covers them; some apps vend windows only as app
/// children (the "UI elements" shape #304 measured), so children with a
/// window-ish role are collected too and deduplicated.
let WINDOW_ROLES: Set<String> = [
    "AXWindow", "AXSheet", "AXDialog", "AXSystemDialog", "AXDrawer",
]

func windowCandidates(_ app: AXUIElement) -> [AXUIElement] {
    var seen = Set<UInt>()
    var out: [AXUIElement] = []
    func add(_ el: AXUIElement) {
        let id = UInt(bitPattern: Unmanaged.passUnretained(el).toOpaque())
        if seen.insert(id).inserted { out.append(el) }
    }
    if let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] {
        for w in windows { add(w) }
    }
    for key in [kAXChildrenAttribute, kAXVisibleChildrenAttribute] {
        if let children = attribute(app, key) as? [AXUIElement] {
            for child in children {
                if let role = axString(child, kAXRoleAttribute), WINDOW_ROLES.contains(role) {
                    add(child)
                }
            }
        }
    }
    return out
}

struct WindowRecord {
    let element: AXUIElement
    let index: Int
    let title: String
    let role: String
    let subrole: String?
    let frame: CGRect?
    let miniaturized: Bool?
    let main: Bool?
    let focused: Bool?
}

func describe(_ element: AXUIElement, index: Int) -> WindowRecord {
    let position = axPoint(element, kAXPositionAttribute)
    let size = axSize(element, kAXSizeAttribute)
    var frame: CGRect? = nil
    if let p = position, let s = size {
        frame = CGRect(x: p.x, y: p.y, width: s.width, height: s.height)
    }
    return WindowRecord(
        element: element,
        index: index,
        title: axString(element, kAXTitleAttribute)
            ?? axString(element, kAXDescriptionAttribute) ?? "",
        role: axString(element, kAXRoleAttribute) ?? "",
        subrole: axString(element, kAXSubroleAttribute),
        frame: frame,
        miniaturized: axBool(element, "AXMiniaturized"),
        main: axBool(element, "AXMain"),
        focused: axBool(element, "AXFocused"))
}

func listWindows(_ pid: pid_t) -> (app: AXUIElement, records: [WindowRecord]) {
    let app = AXUIElementCreateApplication(pid)
    return (app, windowCandidates(app).enumerated().map { describe($0.element, index: $0.offset + 1) })
}

// MARK: - Focus / display reads

/// The pid of whoever is frontmost — same sources as input-focus.swift:
/// NSWorkspace first, WindowServer layer-0 window as fallback.
func frontmostPid() -> pid_t? {
    if let app = NSWorkspace.shared.frontmostApplication {
        return app.processIdentifier
    }
    guard let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else { return nil }
    for entry in list {
        guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0,
              let pid = entry[kCGWindowOwnerPID as String] as? Int32 else { continue }
        return pid
    }
    return nil
}

/// The display whose bounds contain `point`, smallest area first; falls
/// back to the main display. CGDisplayBounds is already in the
/// top-left-origin global space AX uses.
func displayFrame(containing point: CGPoint) -> CGRect {
    var count: UInt32 = 0
    CGGetActiveDisplayList(16, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    var best: CGRect? = nil
    var bestArea = Double.greatestFiniteMagnitude
    for id in ids.prefix(Int(count)) {
        let bounds = CGDisplayBounds(id)
        if bounds.contains(point), bounds.width * bounds.height < bestArea {
            best = bounds
            bestArea = bounds.width * bounds.height
        }
    }
    return best ?? CGDisplayBounds(CGMainDisplayID())
}

// MARK: - JSON emission

func frameJSON(_ frame: CGRect?) -> Any {
    guard let f = frame else { return NSNull() }
    return [
        "x": f.origin.x, "y": f.origin.y,
        "width": f.size.width, "height": f.size.height,
    ]
}

func windowJSON(_ w: WindowRecord) -> [String: Any] {
    return [
        "index": w.index,
        "title": w.title,
        "role": w.role,
        "subrole": w.subrole ?? NSNull(),
        "frame": frameJSON(w.frame),
        "miniaturized": w.miniaturized ?? NSNull(),
        "main": w.main ?? NSNull(),
        "focused": w.focused ?? NSNull(),
    ]
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(
        withJSONObject: object, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8) else {
        print("{\"verdict\":\"failed\",\"detail\":\"json emission failed\"}")
        return
    }
    print(text)
}

// MARK: - state

func cmdState(_ args: [String]) -> Int32 {
    guard let pid = argValue(args, "--pid").flatMap({ pid_t($0) }) else {
        FileHandle.standardError.write(Data("window-ops: state needs --pid\n".utf8))
        return 2
    }
    let (_, records) = listWindows(pid)
    // Which window index holds keyboard focus: AXFocused flag first,
    // then the app's AXFocusedWindow matched back to the listing.
    var focusedIndex: Int? = records.first(where: { $0.focused == true })?.index
    // The app's AXFocusedWindow element, read once: it feeds both the
    // focused-index match and the separate `focusedWindow` report below.
    // On AE (#406) this attribute is the ONLY window the AX tree vends —
    // AXWindows/AXChildren/UI-elements enumeration returns nothing while
    // AXFocusedWindow still resolves a real window (verified on real
    // host, docs/evidence/realhost-2026-11-27/). It is reported
    // separately from `windows` so `act`'s identity matching is
    // unchanged: folding it in would silently change what a mutation
    // can address.
    var focusedElement: AXUIElement? = nil
    let appForFocus = AXUIElementCreateApplication(pid)
    if let fw = attribute(appForFocus, kAXFocusedWindowAttribute) {
        focusedElement = unsafeBitCast(fw, to: AXUIElement.self)
    }
    if focusedIndex == nil, let fwEl = focusedElement {
        focusedIndex = records.first(where: {
            CFEqual($0.element, fwEl)
        })?.index
    }
    var focusedJSON: Any = NSNull()
    if let fwEl = focusedElement {
        focusedJSON = windowJSON(describe(fwEl, index: 0))
    }
    emit([
        "pid": Int(pid),
        "frontmostPid": frontmostPid().map { Int($0) } ?? NSNull(),
        "focusedWindowIndex": focusedIndex ?? NSNull(),
        "focusedWindow": focusedJSON,
        "axTrusted": AXIsProcessTrusted(),
        "windows": records.map { windowJSON($0) },
    ])
    return 0
}

// MARK: - act

func argValue(_ args: [String], _ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

func parseFrame(_ text: String?) -> CGRect? {
    guard let text else { return nil }
    let parts = text.split(separator: ",").compactMap { Double($0) }
    guard parts.count == 4 else { return nil }
    return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
}

func framesMatch(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.origin.x - b.origin.x) <= FRAME_TOLERANCE &&
    abs(a.origin.y - b.origin.y) <= FRAME_TOLERANCE &&
    abs(a.size.width - b.size.width) <= FRAME_TOLERANCE &&
    abs(a.size.height - b.size.height) <= FRAME_TOLERANCE
}

/// Re-list and match the expected identity. Returns the single match or
/// emits the refusal verdict itself.
func findTarget(
    _ records: [WindowRecord],
    title: String, subrole: String, frame: CGRect,
) -> WindowRecord?? {
    let matches = records.filter { w in
        guard let wf = w.frame, framesMatch(wf, frame) else { return false }
        if !title.isEmpty && w.title != title { return false }
        if subrole != "-" {
            guard let ws = w.subrole, ws == subrole else { return false }
        }
        return true
    }
    if matches.isEmpty {
        emit(["verdict": "not-found", "detail": "no window matched the expected identity"])
        return nil
    }
    if matches.count > 1 {
        emit([
            "verdict": "ambiguous",
            "candidates": matches.map { "\($0.index):\($0.title)" },
        ])
        return nil
    }
    return matches[0]
}

func cmdAct(_ args: [String]) -> Int32 {
    guard let pid = argValue(args, "--pid").flatMap({ pid_t($0) }) else {
        FileHandle.standardError.write(Data("window-ops: act needs --pid\n".utf8))
        return 2
    }
    guard let op = argValue(args, "--op") else {
        FileHandle.standardError.write(Data("window-ops: act needs --op\n".utf8))
        return 2
    }
    guard let expectedFrame = parseFrame(argValue(args, "--frame")) else {
        FileHandle.standardError.write(Data("window-ops: act needs --frame x,y,w,h\n".utf8))
        return 2
    }
    let title = argValue(args, "--title") ?? ""
    let subrole = argValue(args, "--subrole") ?? "-"

    let (_, records) = listWindows(pid)
    guard let target = findTarget(records, title: title, subrole: subrole, frame: expectedFrame),
          let window = target else { return 0 }

    var targetDisplay: CGRect? = nil
    var axError: AXError = .success
    switch op {
    case "move":
        guard let x = argValue(args, "--x").flatMap({ Double($0) }),
              let y = argValue(args, "--y").flatMap({ Double($0) }) else {
            emit(["verdict": "failed", "detail": "move needs --x and --y"])
            return 0
        }
        axError = setAX(window.element, kAXPositionAttribute, CGPoint(x: x, y: y))
    case "resize":
        guard let w = argValue(args, "--width").flatMap({ Double($0) }),
              let h = argValue(args, "--height").flatMap({ Double($0) }) else {
            emit(["verdict": "failed", "detail": "resize needs --width and --height"])
            return 0
        }
        axError = setAX(window.element, kAXSizeAttribute, CGSize(width: w, height: h))
    case "minimize":
        axError = setAX(window.element, "AXMiniaturized", true)
    case "restore":
        axError = setAX(window.element, "AXMiniaturized", false)
    case "maximize":
        // The display the window's center sits on; the whole display
        // frame becomes the target — position AND size, one op.
        let center = window.frame.map {
            CGPoint(x: $0.midX, y: $0.midY)
        } ?? CGPoint(x: expectedFrame.midX, y: expectedFrame.midY)
        let display = displayFrame(containing: center)
        targetDisplay = display
        axError = setAX(window.element, kAXPositionAttribute, display.origin)
        if axError == .success {
            axError = setAX(
                window.element, kAXSizeAttribute,
                CGSize(width: display.width, height: display.height))
        }
    case "focus":
        // Order matters: activate the app first so the window's AXMain/
        // AXFocused sets land on the active process, then raise.
        _ = NSRunningApplication(processIdentifier: pid)?
            .activate(options: [])
        axError = setAX(window.element, "AXMain", true)
        if axError == .success {
            axError = setAX(window.element, "AXFocused", true)
        }
        if axError == .success {
            axError = AXUIElementPerformAction(
                window.element, kAXRaiseAction as CFString)
        }
    default:
        emit(["verdict": "failed", "detail": "unknown op \(op)"])
        return 0
    }

    if axError != .success {
        emit([
            "verdict": "failed",
            "detail": "AX error \(axError.rawValue) applying \(op)",
        ])
        return 0
    }

    // Post-act readback of the SAME element: the mutation vehicle's own
    // evidence. A fresh listing is the caller's postcondition poll —
    // this read only proves the set was accepted and echoes what the
    // element reports now.
    let post = describe(window.element, index: window.index)
    var payload: [String: Any] = [
        "verdict": "performed",
        "window": windowJSON(post),
    ]
    if let targetDisplay {
        payload["displayFrame"] = frameJSON(targetDisplay)
    }
    emit(payload)
    return 0
}

// MARK: - main

let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else {
    FileHandle.standardError.write(Data("""
        usage:
          window-ops state --pid PID
          window-ops act --pid PID --op OP --title TITLE --subrole SUBROLE \
            --frame "x,y,w,h" [--x N --y N] [--width N --height N]
        """.utf8))
    exit(2)
}
let rest = Array(argv.dropFirst())
let code: Int32
switch command {
case "state": code = cmdState(rest)
case "act": code = cmdAct(rest)
default:
    FileHandle.standardError.write(Data("window-ops: unknown subcommand '\(command)'\n".utf8))
    code = 2
}
exit(code)
