import ApplicationServices
import Foundation

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return v
}
func s(_ v: AnyObject?) -> String { (v as? String) ?? (v as? NSNumber)?.stringValue ?? "" }

func dump(_ el: AXUIElement, _ label: String, depth: Int) {
    let role = s(attr(el, kAXRoleAttribute)); let sub = s(attr(el, kAXSubroleAttribute))
    let title = s(attr(el, kAXTitleAttribute)); let desc = s(attr(el, kAXDescriptionAttribute))
    var pos = ""; var size = ""
    if let p = attr(el, kAXPositionAttribute) { var pt = CGPoint.zero; AXValueGetValue(p as! AXValue, .cgPoint, &pt); pos = "\(Int(pt.x)),\(Int(pt.y))" }
    if let z = attr(el, kAXSizeAttribute) { var sz = CGSize.zero; AXValueGetValue(z as! AXValue, .cgSize, &sz); size = "\(Int(sz.width))x\(Int(sz.height))" }
    print("\(label) role=\(role) sub=\(sub) title=\(title) desc=\(desc) pos=\(pos) size=\(size)")
    if depth > 0, let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] {
        for (i, k) in kids.enumerated() { dump(k, "\(label).\(i)", depth: depth - 1) }
    }
}

guard CommandLine.arguments.count > 1, let pid = pid_t(CommandLine.arguments[1]) else { exit(2) }
let app = AXUIElementCreateApplication(pid)
if let fw = attr(app, kAXFocusedWindowAttribute) {
    dump(fw as! AXUIElement, "focusedWindow", depth: 2)
} else { print("no focused window") }
if let mw = attr(app, kAXMainWindowAttribute) {
    dump(mw as! AXUIElement, "mainWindow", depth: 1)
} else { print("no main window") }
