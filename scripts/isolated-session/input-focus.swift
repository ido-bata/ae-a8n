// Reads who holds keyboard focus — the #372 half of the B-IME input
// contract (specs/ime-input/spec.md §5.3, issue #372).
//
//   swiftc -O input-focus.swift -o input-focus
//   ./input-focus read
//   ./input-focus read --pid 4242
//
// This is the readback half of the three-step focus proof: session-stream
// input has no address, so before anything posts the contract must know
// *who actually holds focus*. `read` answers that through the
// Accessibility API — the frontmost app's AXFocusedUIElement /
// AXFocusedWindow plus the kAXFocused flag on its windows — and prints a
// JSON FocusHolder-shaped record. `--pid` scopes the read to one process
// (useful when the target app is not frontmost).
//
// READ-ONLY: this helper never sets AXFocused/AXMain and never activates
// an app. Focus *request* is deliberately not here — it is a mutation
// with its own gate, and #372 ships readback only.
//
// Output is one JSON object on stdout; diagnostics on stderr. Exit 0
// even when focus cannot be proven — the JSON says pid:null rather than
// failing, because "unproven" is a first-class answer the contract
// refuses on, not an error to retry.
import AppKit
import ApplicationServices
import Foundation

let USAGE = """
usage:
  input-focus read [--pid PID]    print the current focus holder as JSON
"""

func failUsage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("input-focus: \(message)\n\(USAGE)".utf8))
    exit(2)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? value : nil
}

/// AX attribute values arrive as AnyObject; an AXUIElement is a CF type,
/// so `as?` always "succeeds". Check the type id and bitcast instead.
func asElement(_ value: AnyObject?) -> AXUIElement? {
    guard let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func axString(_ element: AXUIElement, _ name: String) -> String {
    guard let value = attribute(element, name) else { return "" }
    if let s = value as? String { return s }
    if let n = value as? NSNumber { return n.stringValue }
    return "\(value)"
}

/// "Role[index]" path elements from the focused element up to (but not
/// including) the application element — the stable-ish identity the
/// contract's FocusHolder.element carries. Depth-capped; falls back to
/// role-only when the parent chain breaks.
func elementPath(_ element: AXUIElement, app: AXUIElement) -> String? {
    var parts: [String] = []
    var current: AXUIElement? = element
    var depth = 0
    while let el = current, depth < 16 {
        let role = axString(el, kAXRoleAttribute)
        guard !role.isEmpty else { break }
        var label = role
        if let parent = asElement(attribute(el, kAXParentAttribute)) {
            if CFEqual(parent, app) {
                // Top-level element: index among same-role siblings.
                if let siblings = attribute(parent, kAXChildrenAttribute) as? [AXUIElement] {
                    let same = siblings.filter { axString($0, kAXRoleAttribute) == role }
                    if let idx = same.firstIndex(where: { CFEqual($0, el) }) {
                        label = "\(role)[\(idx)]"
                    }
                }
                parts.insert(label, at: 0)
                break
            }
            if let siblings = attribute(parent, kAXChildrenAttribute) as? [AXUIElement] {
                let same = siblings.filter { axString($0, kAXRoleAttribute) == role }
                if let idx = same.firstIndex(where: { CFEqual($0, el) }), same.count > 1 {
                    label = "\(role)[\(idx)]"
                }
            }
        }
        parts.insert(label, at: 0)
        current = asElement(attribute(el, kAXParentAttribute))
        depth += 1
    }
    return parts.isEmpty ? nil : parts.joined(separator: "/")
}

/// The pid of whoever is frontmost. NSWorkspace is the primary source; a
/// plain CLI process can get nil from it (measured in focus-watch.swift),
/// so the WindowServer's frontmost layer-0 window is the fallback — same
/// order the witness uses.
func frontmostPid() -> pid_t? {
    if let app = NSWorkspace.shared.frontmostApplication {
        return app.processIdentifier
    }
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for entry in list {
        guard let layer = entry[kCGWindowLayer as String] as? Int, layer == 0,
              let pid = entry[kCGWindowOwnerPID as String] as? Int32 else { continue }
        return pid
    }
    return nil
}

func readFocus(pid requested: pid_t?) {
    let pid = requested ?? frontmostPid()
    guard let pid else {
        print("{\"pid\":null,\"reason\":\"no frontmost application could be determined\"}")
        return
    }

    let appName: String? = NSRunningApplication(processIdentifier: pid)?.localizedName
    let app = AXUIElementCreateApplication(pid)

    // kAXFocusedUIElement on the application element names the exact
    // element holding keyboard focus; kAXFocusedWindow names the window.
    let focusedElement = asElement(attribute(app, kAXFocusedUIElementAttribute))
    let focusedWindow = asElement(attribute(app, kAXFocusedWindowAttribute))

    // Window-level kAXFocused readback: which window reports AXFocused.
    var focusedWindowIndex: Int? = nil
    if let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] {
        for (index, window) in windows.enumerated() {
            if let flag = attribute(window, kAXFocusedAttribute) as? NSNumber, flag.boolValue {
                focusedWindowIndex = index
                break
            }
        }
    }
    if focusedWindowIndex == nil, let fw = focusedWindow,
       let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement],
       let idx = windows.firstIndex(where: { CFEqual($0, fw) }) {
        focusedWindowIndex = idx
    }

    let element = focusedElement.flatMap { elementPath($0, app: app) }
    let observedAt = ISO8601DateFormatter().string(from: Date())

    func esc(_ s: String?) -> String {
        guard let s = s else { return "null" }
        let escaped = s.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    var json = "{\"pid\":\(pid),\"app\":\(esc(appName)),\"element\":\(esc(element)),\"focusedWindowIndex\":"
    json += focusedWindowIndex.map(String.init) ?? "null"
    json += ",\"observedAt\":\"\(observedAt)\"}"
    print(json)
}

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { failUsage("missing subcommand") }
guard command == "read" else { failUsage("unknown subcommand '\(command)'") }

var requestedPid: pid_t? = nil
if let i = args.firstIndex(of: "--pid") {
    guard i + 1 < args.count, let pid = pid_t(args[i + 1]), pid > 0 else {
        failUsage("--pid expects a positive integer")
    }
    requestedPid = pid
}
readFocus(pid: requestedPid)
