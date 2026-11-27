// Posts keyboard events through the macOS event stream — the #372 half of
// the B-IME input contract (specs/ime-input/spec.md §5–§7, issue #372).
//
//   swiftc -O input-post.swift -o input-post
//   ./input-post key press --key a --mods cmd,shift --tap session
//   ./input-post type --text "こんにちは" --tap hid
//   ./input-post post-text --text "bulk entry" --tap session
//   ./input-post to-pid <pid> key press --key return
//
// SAFETY: this helper posts REAL input events. It is a delivery vehicle
// only — every ae-a8n input operation must arrive through runInputPlan
// (src/input/runner.ts) with the mutation gate, the global-input
// authorization and the three-step focus proof already satisfied. Running
// it by hand bypasses all of that and can type into whatever happens to
// be focused.
//
// `key`/`type` go through the HID or session event tap and are the
// session-stream channel: they reach whatever holds focus, so the
// caller's focus proof is the only thing keeping them off a foreign app.
// `post-text` is the direct-entry channel — bulk unicode, never IME
// evidence (spec §4.2). `to-pid` posts with CGEventPostToPid: whether
// that path traverses the input-method stack or bypasses it is
// UNVERIFIED (spec §7, T001 experiment) — the receipt says so.
//
// Output is one JSON receipt on stdout; diagnostics on stderr. Usage
// errors exit 2 BEFORE anything is posted; runtime failures exit 1.
import CoreGraphics
import Foundation

// MARK: - Key table

/// A named key: macOS virtual keycode plus, for modifiers, the
/// CGEventFlags bit it sets while held.
struct KeyDef {
    let code: CGKeyCode
    let flag: CGEventFlags?
}

let KEY_TABLE: [String: KeyDef] = [
    // Letters (ANSI positions).
    "a": KeyDef(code: 0x00, flag: nil), "s": KeyDef(code: 0x01, flag: nil),
    "d": KeyDef(code: 0x02, flag: nil), "f": KeyDef(code: 0x03, flag: nil),
    "h": KeyDef(code: 0x04, flag: nil), "g": KeyDef(code: 0x05, flag: nil),
    "z": KeyDef(code: 0x06, flag: nil), "x": KeyDef(code: 0x07, flag: nil),
    "c": KeyDef(code: 0x08, flag: nil), "v": KeyDef(code: 0x09, flag: nil),
    "b": KeyDef(code: 0x0B, flag: nil), "q": KeyDef(code: 0x0C, flag: nil),
    "w": KeyDef(code: 0x0D, flag: nil), "e": KeyDef(code: 0x0E, flag: nil),
    "r": KeyDef(code: 0x0F, flag: nil), "y": KeyDef(code: 0x10, flag: nil),
    "t": KeyDef(code: 0x11, flag: nil),
    // Numbers and punctuation.
    "1": KeyDef(code: 0x12, flag: nil), "2": KeyDef(code: 0x13, flag: nil),
    "3": KeyDef(code: 0x14, flag: nil), "4": KeyDef(code: 0x15, flag: nil),
    "6": KeyDef(code: 0x16, flag: nil), "5": KeyDef(code: 0x17, flag: nil),
    "=": KeyDef(code: 0x18, flag: nil), "9": KeyDef(code: 0x19, flag: nil),
    "7": KeyDef(code: 0x1A, flag: nil), "-": KeyDef(code: 0x1B, flag: nil),
    "8": KeyDef(code: 0x1C, flag: nil), "0": KeyDef(code: 0x1D, flag: nil),
    "]": KeyDef(code: 0x1E, flag: nil), "o": KeyDef(code: 0x1F, flag: nil),
    "u": KeyDef(code: 0x20, flag: nil), "[": KeyDef(code: 0x21, flag: nil),
    "i": KeyDef(code: 0x22, flag: nil), "p": KeyDef(code: 0x23, flag: nil),
    "l": KeyDef(code: 0x25, flag: nil), "j": KeyDef(code: 0x26, flag: nil),
    "'": KeyDef(code: 0x27, flag: nil), "k": KeyDef(code: 0x28, flag: nil),
    ";": KeyDef(code: 0x29, flag: nil), "\\": KeyDef(code: 0x2A, flag: nil),
    ",": KeyDef(code: 0x2B, flag: nil), "/": KeyDef(code: 0x2C, flag: nil),
    "n": KeyDef(code: 0x2D, flag: nil), "m": KeyDef(code: 0x2E, flag: nil),
    ".": KeyDef(code: 0x2F, flag: nil), "`": KeyDef(code: 0x32, flag: nil),
    // Named keys.
    "space": KeyDef(code: 0x31, flag: nil), "tab": KeyDef(code: 0x30, flag: nil),
    "delete": KeyDef(code: 0x33, flag: nil), "backspace": KeyDef(code: 0x33, flag: nil),
    "escape": KeyDef(code: 0x35, flag: nil), "esc": KeyDef(code: 0x35, flag: nil),
    "return": KeyDef(code: 0x24, flag: nil), "enter": KeyDef(code: 0x24, flag: nil),
    "forwarddelete": KeyDef(code: 0x75, flag: nil),
    // Arrows and navigation.
    "left": KeyDef(code: 0x7B, flag: nil), "right": KeyDef(code: 0x7C, flag: nil),
    "down": KeyDef(code: 0x7D, flag: nil), "up": KeyDef(code: 0x7E, flag: nil),
    "home": KeyDef(code: 0x73, flag: nil), "end": KeyDef(code: 0x77, flag: nil),
    "pageup": KeyDef(code: 0x74, flag: nil), "pagedown": KeyDef(code: 0x79, flag: nil),
    "help": KeyDef(code: 0x72, flag: nil),
    // Function keys.
    "f1": KeyDef(code: 0x7A, flag: nil), "f2": KeyDef(code: 0x78, flag: nil),
    "f3": KeyDef(code: 0x63, flag: nil), "f4": KeyDef(code: 0x76, flag: nil),
    "f5": KeyDef(code: 0x60, flag: nil), "f6": KeyDef(code: 0x61, flag: nil),
    "f7": KeyDef(code: 0x62, flag: nil), "f8": KeyDef(code: 0x64, flag: nil),
    "f9": KeyDef(code: 0x65, flag: nil), "f10": KeyDef(code: 0x6D, flag: nil),
    "f11": KeyDef(code: 0x67, flag: nil), "f12": KeyDef(code: 0x6F, flag: nil),
    "f13": KeyDef(code: 0x69, flag: nil), "f14": KeyDef(code: 0x6B, flag: nil),
    "f15": KeyDef(code: 0x71, flag: nil), "f16": KeyDef(code: 0x6A, flag: nil),
    "f17": KeyDef(code: 0x40, flag: nil), "f18": KeyDef(code: 0x4F, flag: nil),
    "f19": KeyDef(code: 0x50, flag: nil), "f20": KeyDef(code: 0x5A, flag: nil),
    // Modifiers — posted as flagsChanged, tracked via their CGEventFlags bit.
    "shift": KeyDef(code: 0x38, flag: .maskShift),
    "rightshift": KeyDef(code: 0x3C, flag: .maskShift),
    "command": KeyDef(code: 0x37, flag: .maskCommand),
    "cmd": KeyDef(code: 0x37, flag: .maskCommand),
    "rightcommand": KeyDef(code: 0x36, flag: .maskCommand),
    "control": KeyDef(code: 0x3B, flag: .maskControl),
    "ctrl": KeyDef(code: 0x3B, flag: .maskControl),
    "rightcontrol": KeyDef(code: 0x3E, flag: .maskControl),
    "option": KeyDef(code: 0x3A, flag: .maskAlternate),
    "opt": KeyDef(code: 0x3A, flag: .maskAlternate),
    "alt": KeyDef(code: 0x3A, flag: .maskAlternate),
    "rightoption": KeyDef(code: 0x3D, flag: .maskAlternate),
    "fn": KeyDef(code: 0x3F, flag: .maskSecondaryFn),
    // Caps lock is a toggle key, not a held modifier: posted as a regular
    // key event like any other.
    "capslock": KeyDef(code: 0x39, flag: nil),
]

/// Modifier names accepted in --mods (held-modifier flags on a key event).
/// These are flag names, not key names; caps lock is deliberately absent
/// because CGEventFlags has no held bit for it.
let MOD_FLAGS: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand,
    "ctrl": .maskControl, "control": .maskControl,
    "opt": .maskAlternate, "option": .maskAlternate, "alt": .maskAlternate,
    "shift": .maskShift,
    "fn": .maskSecondaryFn,
]

enum TapKind {
    case hid, session

    var location: CGEventTapLocation {
        switch self {
        case .hid: return .cghidEventTap
        case .session: return .cgSessionEventTap
        }
    }
    var name: String {
        switch self {
        case .hid: return "hid"
        case .session: return "session"
        }
    }
}

let USAGE = """
usage:
  input-post key <down|up|press> --key NAME [--mods a,b,c] [--tap hid|session] [--delay-ms N]
  input-post type --text STRING [--tap hid|session] [--delay-ms N]
  input-post post-text --text STRING [--tap hid|session]
  input-post to-pid PID key <down|up|press> --key NAME [--mods a,b,c]
  input-post to-pid PID type --text STRING
  input-post to-pid PID post-text --text STRING

key names: see KEY_TABLE in input-post.swift (letters, digits, named keys,
modifiers). --mods accepts cmd/command, ctrl/control, opt/option/alt,
shift, fn. to-pid uses CGEventPostToPid — IME pass-through is UNVERIFIED.
"""

func failUsage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("input-post: \(message)\n\(USAGE)".utf8))
    exit(2)
}

// MARK: - Argument parsing (everything validated before anything posts)

struct Parsed {
    var positionals: [String] = []
    var key: String?
    var text: String?
    var mods: String?
    var tap: TapKind = .session
    var delayMs: Int = 0
}

func parse(_ args: [String]) -> Parsed {
    var p = Parsed()
    var i = 0
    while i < args.count {
        let arg = args[i]
        func takeValue() -> String {
            i += 1
            guard i < args.count else { failUsage("\(arg) expects a value") }
            return args[i]
        }
        switch arg {
        case "--key": p.key = takeValue()
        case "--text": p.text = takeValue()
        case "--mods": p.mods = takeValue()
        case "--tap":
            let v = takeValue()
            guard let tap = ["hid": TapKind.hid, "session": TapKind.session][v] else {
                failUsage("--tap expects hid or session")
            }
            p.tap = tap
        case "--delay-ms":
            let v = takeValue()
            guard let ms = Int(v), ms >= 0, ms <= 5000 else {
                failUsage("--delay-ms expects an integer 0...5000")
            }
            p.delayMs = ms
        default:
            if arg.hasPrefix("--") { failUsage("unknown option \(arg)") }
            p.positionals.append(arg)
        }
        i += 1
    }
    return p
}

func resolveKey(_ name: String) -> KeyDef {
    guard let key = KEY_TABLE[name.lowercased()] else {
        failUsage("unknown key name '\(name)'")
    }
    return key
}

func resolveMods(_ csv: String?) -> CGEventFlags {
    guard let csv = csv, !csv.isEmpty else { return [] }
    var flags = CGEventFlags()
    for raw in csv.split(separator: ",") {
        let name = raw.trimmingCharacters(in: .whitespaces).lowercased()
        guard let flag = MOD_FLAGS[name] else {
            failUsage("unknown modifier '\(name)' (expected one of: cmd, command, ctrl, control, opt, option, alt, shift, fn)")
        }
        flags.insert(flag)
    }
    return flags
}

// MARK: - Plan (validated fully before any post)

enum Action {
    /// Named key: verb down/up = one event, press = down+up pair.
    case key(down: Bool, press: Bool)
    /// Per-character unicode keyDown+keyUp — the IME-path candidate.
    case typeSequential
    /// Bulk unicode keyDown chunks — direct entry, never IME evidence.
    case postText
}

struct Plan {
    let action: Action
    let key: KeyDef?
    let mods: CGEventFlags
    let text: String
    let tap: TapKind
    let delayMs: Int
    let toPid: pid_t?
    /// Number of CGEvents this plan will post (for the receipt).
    let eventCount: Int
    let summary: String
}

func buildPlan(args: [String]) -> Plan {
    guard !args.isEmpty else { failUsage("missing subcommand") }

    var toPid: pid_t? = nil
    var rest = args
    if args[0] == "to-pid" {
        guard args.count >= 2, let pid = pid_t(args[1]) else {
            failUsage("to-pid expects a pid")
        }
        toPid = pid
        rest = Array(args.dropFirst(2))
    }
    guard !rest.isEmpty else { failUsage("missing action after to-pid") }

    let actionName = rest[0]
    let p = parse(Array(rest.dropFirst()))

    switch actionName {
    case "key":
        guard p.positionals.count == 1,
              let verb = p.positionals.first,
              ["down", "up", "press"].contains(verb),
              let keyName = p.key else {
            failUsage("key expects: key <down|up|press> --key NAME [--mods a,b,c]")
        }
        let key = resolveKey(keyName)
        let mods = resolveMods(p.mods)
        let down = verb != "up"
        let press = verb == "press"
        return Plan(
            action: .key(down: down, press: press),
            key: key, mods: mods, text: "",
            tap: p.tap, delayMs: p.delayMs, toPid: toPid,
            eventCount: press ? 2 : 1,
            summary: "key \(verb) \(keyName)" + (p.mods.map { " [\($0)]" } ?? "")
        )
    case "type":
        guard let text = p.text, !text.isEmpty else {
            failUsage("type expects: type --text STRING")
        }
        // One unicode keyDown per Character plus a plain keyUp so no key
        // state lingers. A Character longer than one UTF-16 unit still
        // posts as a single event carrying its whole utf16 sequence.
        let chars = Array(text)
        return Plan(
            action: .typeSequential,
            key: nil, mods: [], text: text,
            tap: p.tap, delayMs: p.delayMs, toPid: toPid,
            eventCount: chars.count * 2,
            summary: "type-sequential (\(chars.count) chars)"
        )
    case "post-text":
        guard let text = p.text, !text.isEmpty else {
            failUsage("post-text expects: post-text --text STRING")
        }
        // Bulk unicode in <=20-uniChar chunks, keyDown only.
        let units = Array(text.utf16)
        var chunks = 0
        var offset = 0
        while offset < units.count {
            offset += min(20, units.count - offset)
            chunks += 1
        }
        return Plan(
            action: .postText,
            key: nil, mods: [], text: text,
            tap: p.tap, delayMs: 0, toPid: toPid,
            eventCount: chunks,
            summary: "post-text (\(units.count) utf16 units, \(chunks) events)"
        )
    default:
        failUsage("unknown action '\(actionName)'")
    }
}

// MARK: - Event construction and posting

/// Build the i-th CGEvent of the plan. Returns nil only on an internal
/// inconsistency (index out of range), which the caller reports as a
/// runtime failure — never as a partial silent post.
func makeEvent(for plan: Plan, index: Int) -> CGEvent? {
    switch plan.action {
    case .key(let down, let press):
        guard let key = plan.key else { return nil }
        // press posts down (index 0) then up (index 1); a lone "down"
        // or "up" is a single event.
        let isDown = press ? index == 0 : down
        if let own = key.flag {
            // Modifier keys post as flagsChanged carrying the
            // post-transition modifier state: held mods, plus this key's
            // own flag while it is down.
            guard let event = CGEvent(source: nil) else { return nil }
            event.type = .flagsChanged
            event.setIntegerValueField(.keyboardEventKeycode, value: Int64(key.code))
            var flags = plan.mods
            if isDown { flags.insert(own) }
            event.flags = flags
            return event
        }
        guard let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .combinedSessionState), virtualKey: key.code, keyDown: isDown) else { return nil }
        event.flags = plan.mods
        return event
    case .typeSequential:
        let chars = Array(plan.text)
        guard index / 2 < chars.count else { return nil }
        let charIndex = index / 2
        let isDown = index % 2 == 0
        guard let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .combinedSessionState), virtualKey: 0, keyDown: isDown) else { return nil }
        if isDown {
            let units = Array(String(chars[charIndex]).utf16)
            units.withUnsafeBufferPointer { buffer in
                event.keyboardSetUnicodeString(
                    stringLength: units.count, unicodeString: buffer.baseAddress)
            }
        }
        event.flags = plan.mods
        return event
    case .postText:
        let units = Array(plan.text.utf16)
        // Chunk boundaries must match buildPlan's counting: 20-unit chunks.
        let start = index * 20
        guard start < units.count else { return nil }
        let chunk = Array(units[start..<min(start + 20, units.count)])
        guard let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .combinedSessionState), virtualKey: 0, keyDown: true) else { return nil }
        chunk.withUnsafeBufferPointer { buffer in
            event.keyboardSetUnicodeString(
                stringLength: chunk.count, unicodeString: buffer.baseAddress)
        }
        return event
    }
}

// MARK: - main

let plan = buildPlan(args: Array(CommandLine.arguments.dropFirst()))

var posted = 0
for i in 0..<plan.eventCount {
    guard let event = makeEvent(for: plan, index: i) else {
        FileHandle.standardError.write(Data("input-post: failed to create event \(i)\n".utf8))
        exit(1)
    }
    if let pid = plan.toPid {
        event.postToPid(pid)
    } else {
        event.post(tap: plan.tap.location)
    }
    posted += 1
    if plan.delayMs > 0, i + 1 < plan.eventCount {
        usleep(useconds_t(plan.delayMs) * 1000)
    }
}

var fields = "\"ok\":true"
fields += ",\"summary\":\"\(plan.summary)\""
fields += ",\"events\":\(posted)"
if let pid = plan.toPid {
    fields += ",\"channel\":\"pid\",\"pid\":\(pid),\"imePassThrough\":\"unverified\""
} else {
    fields += ",\"channel\":\"\(plan.tap.name)\""
}
switch plan.action {
case .typeSequential:
    fields += ",\"evidence\":\"tier1b-candidate\",\"chars\":\(Array(plan.text).count)"
case .postText:
    fields += ",\"evidence\":\"direct-entry-not-ime\""
default:
    break
}
print("{\(fields)}")
