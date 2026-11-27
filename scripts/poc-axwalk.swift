// Real-host PoC helper for issue #411 (drag-drop alternative paths).
//
//   swiftc -O poc-axwalk.swift -o poc-axwalk
//   ./poc-axwalk --pid 12345 [--depth 14] [--max-nodes 4000] [--all-windows]
//
// Dumps the Accessibility subtree of a process as a JSON array on stdout:
// one object per node with its path, depth, role/subrole, text-ish
// attributes and frame. Used to locate AE-internal drag sources/targets
// (Project panel rows, Timeline layer rows, panel tabs) that the window
// census cannot see — panels inside the main window have no CGWindow.
//
// Read-only: only AXUIElementCopyAttributeValue is ever called. Roots are
// the app's AXWindows; when that list is empty (AE's known non-vending
// state) AXChildren window-shaped elements are used instead, same rule as
// the production AX_PANE_WALK_SCRIPT.
//
// Output is one JSON document {"pid":N,"roots":[...nodes...]} on stdout;
// diagnostics on stderr. Usage errors exit 2.
import Cocoa

func failUsage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("poc-axwalk: \(message)\n".utf8))
    exit(2)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? value : nil
}

func axString(_ element: AXUIElement, _ name: String) -> String? {
    guard let raw = attribute(element, name) else { return nil }
    if let s = raw as? String { return s }
    // AXValue-typed attributes (numbers, ranges) still stringify usefully.
    return "\(raw)"
}

func axFrame(_ element: AXUIElement) -> [Double]? {
    var origin = CGPoint.zero
    var size = CGSize.zero
    var v: AnyObject?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &v) == .success,
          let posVal = v,
          AXValueGetValue(posVal as! AXValue, .cgPoint, &origin) else { return nil }
    v = nil
    guard AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &v) == .success,
          let sizeVal = v,
          AXValueGetValue(sizeVal as! AXValue, .cgSize, &size) else { return nil }
    return [origin.x, origin.y, size.width, size.height]
}

func jsonEscape(_ s: String) -> String {
    var out = ""
    for ch in s {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.asciiValue ?? 0 < 0x20 {
                out += String(format: "\\u%04x", ch.asciiValue ?? 0)
            } else {
                out.append(ch)
            }
        }
    }
    return out
}

func truncated(_ s: String?, _ max: Int = 120) -> String? {
    guard let s = s, !s.isEmpty else { return nil }
    return s.count > max ? String(s.prefix(max)) + "…" : s
}

final class Walker {
    var nodes = 0
    var maxNodes: Int
    var maxDepth: Int
    var lines: [String] = []
    init(maxDepth: Int, maxNodes: Int) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
    }
    func walk(_ el: AXUIElement, path: String, depth: Int) {
        guard nodes < maxNodes, depth <= maxDepth else { return }
        nodes += 1
        let role = axString(el, kAXRoleAttribute) ?? ""
        let subrole = axString(el, "AXSubrole")
        let title = truncated(axString(el, kAXTitleAttribute))
        let desc = truncated(axString(el, kAXDescriptionAttribute), 80)
        let value = truncated(axString(el, kAXValueAttribute))
        let ident = truncated(axString(el, "AXIdentifier"), 60)
        let frame = axFrame(el)
        var obj = "{\"p\":\"\(path)\",\"d\":\(depth),\"role\":\"\(role)\""
        if let subrole = subrole { obj += ",\"sub\":\"\(jsonEscape(subrole))\"" }
        if let title = title { obj += ",\"t\":\"\(jsonEscape(title))\"" }
        if let desc = desc { obj += ",\"desc\":\"\(jsonEscape(desc))\"" }
        if let value = value { obj += ",\"v\":\"\(jsonEscape(value))\"" }
        if let ident = ident { obj += ",\"id\":\"\(jsonEscape(ident))\"" }
        if let frame = frame {
            obj += ",\"f\":[\(frame.map { String(format: "%.1f", $0) }.joined(separator: ","))]"
        }
        obj += "}"
        lines.append(obj)
        var children: [AXUIElement] = []
        if let raw = attribute(el, kAXChildrenAttribute) as? [AXUIElement] {
            children = raw
        } else if let raw = attribute(el, "AXVisibleChildren") as? [AXUIElement] {
            children = raw
        }
        for (i, child) in children.enumerated() {
            walk(child, path: "\(path).\(i)", depth: depth + 1)
        }
    }
}

// MARK: - args

var pid: pid_t = 0
var depth = 14
var maxNodes = 4000
var allWindows = false
var i = 1
let args = CommandLine.arguments
guard args.count >= 2 else { failUsage("missing arguments (see header)") }
while i < args.count {
    let a = args[i]
    func take() -> String {
        i += 1
        guard i < args.count else { failUsage("\(a) expects a value") }
        return args[i]
    }
    switch a {
    case "--pid":
        let v = take()
        guard let n = pid_t(v) else { failUsage("--pid expects a number") }
        pid = n
    case "--depth":
        depth = Int(take()) ?? depth
    case "--max-nodes":
        maxNodes = Int(take()) ?? maxNodes
    case "--all-windows":
        allWindows = true
    default:
        failUsage("unknown argument \(a)")
    }
    i += 1
}
guard pid != 0 else { failUsage("--pid is required") }

// MARK: - collect roots

let app = AXUIElementCreateApplication(pid)
var roots: [AXUIElement] = []
if let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] {
    roots = windows
}
if roots.isEmpty {
    if let children = attribute(app, kAXChildrenAttribute) as? [AXUIElement] {
        for el in children {
            let role = axString(el, kAXRoleAttribute) ?? ""
            if ["AXWindow", "AXLayoutArea", "AXDialog", "AXFloatingWindow",
                "AXSheet", "AXSystemDialog"].contains(role) {
                roots.append(el)
            }
        }
    }
}
guard !roots.isEmpty else {
    FileHandle.standardError.write(Data("poc-axwalk: no AX window roots for pid \(pid)\n".utf8))
    print("{\"pid\":\(pid),\"roots\":[],\"note\":\"no AX windows vended\"}")
    exit(0)
}

// Largest-first ordering; --all-windows dumps every root, otherwise only
// the largest (the main window) to keep output focused.
func area(_ el: AXUIElement) -> Double {
    guard let f = axFrame(el) else { return 0 }
    return f[2] * f[3]
}
roots.sort { area($0) > area($1) }
if !allWindows { roots = Array(roots.prefix(1)) }

var allNodes: [String] = []
for (idx, root) in roots.enumerated() {
    let walker = Walker(maxDepth: depth, maxNodes: maxNodes)
    walker.walk(root, path: "\(idx)", depth: 0)
    allNodes.append(contentsOf: walker.lines)
}
FileHandle.standardError.write(
    Data("poc-axwalk: pid=\(pid) roots=\(roots.count) nodes=\(allNodes.count) depth<=\(depth)\n".utf8))
print("{\"pid\":\(pid),\"roots\":\(roots.count),\"nodes\":[\(allNodes.joined(separator: ","))]}")
