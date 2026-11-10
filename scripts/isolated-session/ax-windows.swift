// Lists the accessibility windows of a process, from the session it runs in.
//
//   swiftc -O ax-windows.swift -o ax-windows
//   ./ax-windows <pid>
//
// Unlike CGWindowList, this needs the Accessibility permission — and unlike
// System Events, it needs nothing else. If it sees the windows, the GUI
// fallback can press buttons without the Automation grant at all.
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? value : nil
}

func text(_ value: AnyObject?) -> String {
    guard let value = value else { return "" }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return "\(value)"
}

func walk(_ element: AXUIElement, depth: Int, maxDepth: Int) {
    let role = text(attribute(element, kAXRoleAttribute))
    let subrole = text(attribute(element, kAXSubroleAttribute))
    let title = text(attribute(element, kAXTitleAttribute))
    let description = text(attribute(element, kAXDescriptionAttribute))
    let value = text(attribute(element, kAXValueAttribute))
    var line = String(repeating: "  ", count: depth) + "role=\(role)"
    if !subrole.isEmpty { line += " subrole=\(subrole)" }
    if !title.isEmpty { line += " title=\(title)" }
    if !description.isEmpty { line += " desc=\(description)" }
    if !value.isEmpty { line += " value=\(value.prefix(80))" }
    print(line)
    if depth >= maxDepth { return }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children { walk(child, depth: depth + 1, maxDepth: maxDepth) }
    }
}

guard CommandLine.arguments.count > 1, let pid = pid_t(CommandLine.arguments[1]) else {
    print("usage: ax-windows <pid>")
    exit(2)
}

print("trusted=\(AXIsProcessTrusted())")
let app = AXUIElementCreateApplication(pid)
if let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] {
    print("windows=\(windows.count)")
    for window in windows { walk(window, depth: 1, maxDepth: 4) }
} else {
    print("windows: none (the application answered nothing for AXWindows)")
}
