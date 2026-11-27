import ApplicationServices
import Foundation
func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return v
}
func frame(_ el: AXUIElement) -> String {
    var p = CGPoint.zero; var z = CGSize.zero
    if let pv = attr(el, kAXPositionAttribute) { AXValueGetValue(pv as! AXValue, .cgPoint, &p) }
    if let zv = attr(el, kAXSizeAttribute) { AXValueGetValue(zv as! AXValue, .cgSize, &z) }
    return "\(Int(p.x)),\(Int(p.y)) \(Int(z.width))x\(Int(z.height))"
}
let args = CommandLine.arguments
let pid = pid_t(args[1])!
let w = Double(args[2])!, h = Double(args[3])!
let app = AXUIElementCreateApplication(pid)
guard let fw = attr(app, kAXFocusedWindowAttribute) else { print("NO-FOCUSED"); exit(3) }
let el = fw as! AXUIElement
print("before=\(frame(el))")
var sz = CGSize(width: w, height: h)
let v = AXValueCreate(.cgSize, &sz)!
let r = AXUIElementSetAttributeValue(el, kAXSizeAttribute as CFString, v)
print("setResult=\(r.rawValue)")
usleep(500000)
print("after=\(frame(el))")
