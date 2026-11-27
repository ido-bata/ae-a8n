// Focused-window AX mutation probe for the #357 panel-gate PoC
// (follow-up to axsetsize.swift, which only set kAXSizeAttribute).
//
//   swiftc -O ax-focused-set.swift -o ax-focused-set
//   ./ax-focused-set --pid 1234 --op resize --width 560 --height 440
//   ./ax-focused-set --pid 1234 --op move --x 200 --y 200
//   ./ax-focused-set --pid 1234 --op state
//
// Addresses ONLY the app's AXFocusedWindow element — the single window
// reference AE vends even while its window enumeration is empty (#406).
// Emits one JSON object on stdout; diagnostics on stderr. Exit 0 even
// for honest refusals (no focused window / AX error) — the verdict is
// data, matching window-ops.swift's contract.
//
// This is a PoC probe, not a shipped vehicle: it has no census or
// identity re-check. Any production use must go through the
// census-first resolve → identity re-verify → bounded postcondition
// chain described in docs/gui-supervision-safety-gates.md.
import ApplicationServices
import CoreGraphics
import Foundation

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

func setPoint(_ element: AXUIElement, _ name: String, _ point: CGPoint) -> AXError {
    var p = point
    guard let value = AXValueCreate(.cgPoint, &p) else { return .failure }
    return AXUIElementSetAttributeValue(element, name as CFString, value)
}

func setSize(_ element: AXUIElement, _ name: String, _ size: CGSize) -> AXError {
    var s = size
    guard let value = AXValueCreate(.cgSize, &s) else { return .failure }
    return AXUIElementSetAttributeValue(element, name as CFString, value)
}

func frameJSON(_ element: AXUIElement) -> [String: Any] {
    var out: [String: Any] = [:]
    if let p = axPoint(element, kAXPositionAttribute) {
        out["x"] = p.x
        out["y"] = p.y
    }
    if let s = axSize(element, kAXSizeAttribute) {
        out["width"] = s.width
        out["height"] = s.height
    }
    return out
}

func windowJSON(_ element: AXUIElement) -> [String: Any] {
    return [
        "title": axString(element, kAXTitleAttribute)
            ?? axString(element, kAXDescriptionAttribute) ?? NSNull(),
        "role": axString(element, kAXRoleAttribute) ?? NSNull(),
        "subrole": axString(element, kAXSubroleAttribute) ?? NSNull(),
        "frame": frameJSON(element),
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

func argValue(_ args: [String], _ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let args = Array(CommandLine.arguments.dropFirst())
guard let pidText = argValue(args, "--pid"), let pid = pid_t(pidText) else {
    FileHandle.standardError.write(Data("ax-focused-set: needs --pid\n".utf8))
    exit(2)
}
let op = argValue(args, "--op") ?? "state"

let app = AXUIElementCreateApplication(pid)
guard let fwRaw = attribute(app, kAXFocusedWindowAttribute),
      CFGetTypeID(fwRaw) == AXUIElementGetTypeID() else {
    emit(["verdict": "no-focused-window", "pid": Int(pid)])
    exit(0)
}
let focused = fwRaw as! AXUIElement

switch op {
case "state":
    emit(["verdict": "ok", "pid": Int(pid), "window": windowJSON(focused)])
case "resize":
    guard let wText = argValue(args, "--width"), let hText = argValue(args, "--height"),
          let w = Double(wText), let h = Double(hText) else {
        emit(["verdict": "failed", "detail": "resize needs --width and --height"])
        exit(0)
    }
    let before = windowJSON(focused)
    let err = setSize(focused, kAXSizeAttribute, CGSize(width: w, height: h))
    usleep(400_000)
    emit([
        "verdict": err == .success ? "performed" : "failed",
        "axError": err.rawValue,
        "before": before,
        "after": windowJSON(focused),
    ])
case "move":
    guard let xText = argValue(args, "--x"), let yText = argValue(args, "--y"),
          let x = Double(xText), let y = Double(yText) else {
        emit(["verdict": "failed", "detail": "move needs --x and --y"])
        exit(0)
    }
    let before = windowJSON(focused)
    let err = setPoint(focused, kAXPositionAttribute, CGPoint(x: x, y: y))
    usleep(400_000)
    emit([
        "verdict": err == .success ? "performed" : "failed",
        "axError": err.rawValue,
        "before": before,
        "after": windowJSON(focused),
    ])
default:
    emit(["verdict": "failed", "detail": "unknown op \(op)"])
}
exit(0)
