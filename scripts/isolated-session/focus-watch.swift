// A witness for "the other session did not touch this desktop".
//
// It samples, twice a second, which application is frontmost in *this*
// session and where the mouse pointer is. Run it in the console session
// while the isolated session works; the log says whether anything moved.
//
// It reads no window contents and no other app's data: only the frontmost
// application's name and process id, and the pointer's position.
//
//   swiftc -O focus-watch.swift -o focus-watch
//   ./focus-watch > focus.log
import Cocoa
import CoreGraphics

let interval = 0.2
while true {
    let app = NSWorkspace.shared.frontmostApplication
    let location = CGEvent(source: nil)?.location ?? .zero
    let name = (app?.localizedName ?? "?").replacingOccurrences(of: "|", with: "/")
    let pid = app?.processIdentifier ?? -1
    print(String(format: "%.3f|%@|%d|%d,%d", Date().timeIntervalSince1970, name, pid, Int(location.x), Int(location.y)))
    fflush(stdout)
    Thread.sleep(forTimeInterval: interval)
}
