// Lists the windows of the current session's window server.
//
//   swiftc -O list-windows.swift -o list-windows
//   ./list-windows [pid]
//
// Each line is `pid|owner|windowNumber|name|layer|width,height|x,y`.
// The window list comes from the caller's own window server connection, so
// what it shows is this session's screen and nothing else.
import CoreGraphics
import Foundation

let wanted = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) : nil
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("the window list could not be read\n".data(using: .utf8)!)
    exit(1)
}
for window in windows {
    let pid = window[kCGWindowOwnerPID as String] as? Int ?? -1
    if let wanted = wanted, pid != wanted { continue }
    let owner = window[kCGWindowOwnerName as String] as? String ?? "?"
    let number = window[kCGWindowNumber as String] as? Int ?? -1
    let name = window[kCGWindowName as String] as? String ?? ""
    let layer = window[kCGWindowLayer as String] as? Int ?? -1
    let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let width = Int(bounds["Width"] as? Double ?? 0)
    let height = Int(bounds["Height"] as? Double ?? 0)
    let x = Int(bounds["X"] as? Double ?? 0)
    let y = Int(bounds["Y"] as? Double ?? 0)
    print("\(pid)|\(owner)|\(number)|\(name)|\(layer)|\(width),\(height)|\(x),\(y)")
}
