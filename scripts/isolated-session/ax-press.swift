// Presses a button by its accessibility title, in a process of this session.
//
//   swiftc -O ax-press.swift -o ax-press
//   ./ax-press <pid> <button title>
//
// Prints PRESSED / NOT_FOUND / MISSING. It needs the Accessibility
// permission (which this session already has) and nothing else — no
// Automation grant, no System Events.
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

/// Depth-first, because AE nests its dialog buttons a few levels down.
func press(_ element: AXUIElement, title: String, depth: Int) -> Bool {
    if depth > 12 { return false }
    let role = text(attribute(element, kAXRoleAttribute))
    let name = text(attribute(element, kAXTitleAttribute))
    let description = text(attribute(element, kAXDescriptionAttribute))
    let value = text(attribute(element, kAXValueAttribute))
    if role == "AXButton" && (name == title || description == title || value == title) {
        let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
        if result == .success { return true }
    }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        for child in children {
            if press(child, title: title, depth: depth + 1) { return true }
        }
    }
    return false
}

guard CommandLine.arguments.count > 2, let pid = pid_t(CommandLine.arguments[1]) else {
    print("usage: ax-press <pid> <button title>")
    exit(2)
}
let title = CommandLine.arguments[2]
let app = AXUIElementCreateApplication(pid)
guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty else {
    print("MISSING")
    exit(1)
}
for window in windows where press(window, title: title, depth: 0) {
    print("PRESSED")
    exit(0)
}
print("NOT_FOUND")
exit(1)
