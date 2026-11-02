// A witness for "the other session did not touch this desktop".
//
// It samples, twice a second, which application is frontmost in *this*
// session and where the mouse pointer is. Run it in the console session
// while the isolated session works; the log says whether anything moved.
//
// It also watches for key events, but **records nothing about what was
// typed**: only a count, and whether the event came from the keyboard or
// was posted programmatically. A programmatic key event in this session
// would be the agent's own synthetic input landing on the human's desktop —
// the one thing this witness exists to catch. Key *content* is never read
// and never written.
//
// It reads no window contents and no other app's data: only the frontmost
// application's name and process id, the pointer's position, and key-event
// counters.
//
//   swiftc -O focus-watch.swift -o focus-watch
//   ./focus-watch > focus.log
import Cocoa
import CoreGraphics

let interval = 0.2

// Key events, counted but not read. The tap is only able to see key events
// when this process is trusted for accessibility; without that, the counters
// stay at zero and the log says so, so an unmonitored run is never reported
// as a run with zero key input.
final class KeyWatch {
    static let shared = KeyWatch()
    var total = 0
    var programmatic = 0
    var started = false

    func start() {
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, _ in
            // A key event typed on the keyboard carries no source process.
            // An event posted by a program carries the pid of that program.
            let sourcePid = event.getIntegerValueField(.eventSourceUnixProcessID)
            let isProgrammatic = sourcePid != 0
            KeyWatch.shared.total += 1
            if isProgrammatic {
                KeyWatch.shared.programmatic += 1
            }
            return Unmanaged.passUnretained(event)
        }
        let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: callback,
            userInfo: nil
        )
        guard let tap else {
            FileHandle.standardError.write(Data("focus-watch: the key-event tap was refused (accessibility?)\n".utf8))
            return
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        started = true
    }
}

KeyWatch.shared.start()

while true {
    let app = NSWorkspace.shared.frontmostApplication
    let location = CGEvent(source: nil)?.location ?? .zero
    let name = (app?.localizedName ?? "?").replacingOccurrences(of: "|", with: "/")
    let pid = app?.processIdentifier ?? -1
    let keys = KeyWatch.shared.total
    let synthetic = KeyWatch.shared.programmatic
    let watching = KeyWatch.shared.started ? "keys=watched" : "keys=unwatched"
    print(String(format: "%.3f|%@|%d|%d,%d|%@|%d|%d", Date().timeIntervalSince1970, name, pid, Int(location.x), Int(location.y), watching, keys, synthetic))
    fflush(stdout)
    Thread.sleep(forTimeInterval: interval)
}
