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
    /// How often macOS took the tap away. While it is away no key can be
    /// seen, so the log has to say so instead of reporting a quiet zero.
    var gaps = 0
    var tap: CFMachPort?

    func start() {
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, _ in
            // macOS hands the callback two pseudo-events when it disables the
            // tap, and their payload is not a key event at all. Read as one,
            // they look like input with a source pid — measured 2026-11-03:
            // the "programmatic" pid turned out to be the witness's own, and
            // type was -2 (tapDisabledByUserInput), not a key.
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                KeyWatch.shared.gaps += 1
                if let tap = KeyWatch.shared.tap {
                    CGEvent.tapEnable(tap: tap, enable: true)
                }
                let line = String(format: "key-tap-disabled %.3f type=%d\n", Date().timeIntervalSince1970, type.rawValue)
                FileHandle.standardError.write(Data(line.utf8))
                return Unmanaged.passUnretained(event)
            }
            // A key event typed on the keyboard carries no source process.
            // An event posted by a program carries the pid of that program.
            let sourcePid = event.getIntegerValueField(.eventSourceUnixProcessID)
            let isProgrammatic = sourcePid != 0
            KeyWatch.shared.total += 1
            if isProgrammatic {
                KeyWatch.shared.programmatic += 1
                // Which program posted it. The count alone says "something on
                // this desktop synthesized input"; the pid says what, and
                // without it the count cannot be attributed.
                let line = String(format: "programmatic-key %.3f pid=%lld type=%d\n", Date().timeIntervalSince1970, sourcePid, type.rawValue)
                FileHandle.standardError.write(Data(line.utf8))
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
        self.tap = tap
        started = true
    }
}

KeyWatch.shared.start()

// NSWorkspace reports nothing for a plain command-line process on this macOS:
// measured 2026-11-03, `frontmostApplication` was nil and `lsappinfo front`
// printed NULL while System Events named the terminal that was in front. So
// when NSWorkspace is silent, the same question is asked through System
// Events — once a second, name and pid only, nothing else read or stored.
var fallback: (name: String, pid: Int, at: Date)? = nil

func frontmostFromSystemEvents() -> (String, Int)? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = [
        // One -e: `with timeout` must wrap a whole statement list, and
        // `which`-style fragments split by line do not compile (measured:
        // -2741, "property found where , expected").
        "-e",
        """
        with timeout of 2 seconds
        tell application "System Events"
        set p to first process whose frontmost is true
        return (name of p) & "|" & ((unix id of p) as string)
        end tell
        end timeout
        """,
    ]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0,
          let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
          let bar = text.lastIndex(of: "|"),
          let pid = Int(text[text.index(after: bar)...]) else {
        return nil
    }
    return (String(text[..<bar]), pid)
}

while true {
    var name = "?"
    var pid = -1
    if let app = NSWorkspace.shared.frontmostApplication {
        name = app.localizedName ?? "?"
        pid = Int(app.processIdentifier)
    } else {
        if fallback == nil || Date().timeIntervalSince(fallback!.at) >= 1.0 {
            if let answer = frontmostFromSystemEvents() {
                fallback = (answer.0, answer.1, Date())
            } else {
                fallback = ("?", -1, Date())
            }
        }
        name = fallback!.name
        pid = fallback!.pid
    }
    name = name.replacingOccurrences(of: "|", with: "/")
    let location = CGEvent(source: nil)?.location ?? .zero
    let keys = KeyWatch.shared.total
    let synthetic = KeyWatch.shared.programmatic
    let watching = !KeyWatch.shared.started
        ? "keys=unwatched"
        : (KeyWatch.shared.gaps == 0 ? "keys=watched" : "keys=gapped(\(KeyWatch.shared.gaps))")
    print(String(format: "%.3f|%@|%d|%d,%d|%@|%d|%d", Date().timeIntervalSince1970, name, pid, Int(location.x), Int(location.y), watching, keys, synthetic))
    fflush(stdout)
    // Sleep by running this thread's run loop, not by blocking the thread:
    // the key tap's CFRunLoopSource is attached to this loop, and a
    // Thread.sleep never services it. Blocking would leave `started` true
    // while no callback ever runs — `keys=watched` with zero counts, the false
    // "quiet zero" this tool must not produce.
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: interval))
}
