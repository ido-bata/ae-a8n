// Queries and selects macOS text input sources (TIS) — the #372 half of
// the B-IME input contract (specs/ime-input/spec.md §6/§7, issue #372).
//
//   swiftc -O input-source.swift -o input-source
//   ./input-source current
//   ./input-source list
//   ./input-source select --mode com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese
//
// `current`/`list` are read-only. `select` changes the user-global input
// method — shared-state under spec §5.1, gated by the input contract's
// cleanup rule (prior mode must be restored). Whether a Japanese input
// source exists at all is an environment fact this helper reports
// honestly: `list` shows what is installed; a machine without one has no
// mode to select and the capability stays `unavailable`/`needs-human`.
//
// Output is one JSON object on stdout; diagnostics on stderr. Usage
// errors exit 2; runtime failures exit 1.
import Carbon
import Foundation

let USAGE = """
usage:
  input-source current                  print the current input source as JSON
  input-source list                     print every input source as JSON
  input-source select --mode ID-OR-NAME select an input source by id or localized name
"""

func failUsage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("input-source: \(message)\n\(USAGE)".utf8))
    exit(2)
}

func failRuntime(_ message: String) -> Never {
    FileHandle.standardError.write(Data("input-source: \(message)\n".utf8))
    exit(1)
}

func tisString(_ source: TISInputSource, _ property: CFString) -> String? {
    guard let raw = TISGetInputSourceProperty(source, property) else { return nil }
    return unsafeBitCast(raw, to: CFString.self) as String
}

func tisBool(_ source: TISInputSource, _ property: CFString) -> Bool {
    guard let raw = TISGetInputSourceProperty(source, property) else { return false }
    let cf = unsafeBitCast(raw, to: CFTypeRef.self)
    guard CFGetTypeID(cf) == CFBooleanGetTypeID() else { return false }
    return CFBooleanGetValue(unsafeBitCast(cf, to: CFBoolean.self))
}

func jsonEscape(_ s: String) -> String {
    var out = ""
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out
}

/// The mode identity used for select/restore: the input source ID when
/// present (stable across renames), else the localized name.
func modeOf(_ source: TISInputSource) -> String? {
    tisString(source, kTISPropertyInputSourceID) ?? tisString(source, kTISPropertyLocalizedName)
}

func sourceJSON(_ source: TISInputSource, selected: Bool) -> String {
    let id = tisString(source, kTISPropertyInputSourceID) ?? ""
    let name = tisString(source, kTISPropertyLocalizedName) ?? ""
    let type = tisString(source, kTISPropertyInputSourceType) ?? ""
    let enabled = tisBool(source, kTISPropertyInputSourceIsEnabled)
    let selectable = tisBool(source, kTISPropertyInputSourceIsSelectCapable)
    return "{\"id\":\"\(jsonEscape(id))\",\"name\":\"\(jsonEscape(name))\",\"type\":\"\(jsonEscape(type))\",\"enabled\":\(enabled),\"selectable\":\(selectable),\"selected\":\(selected)}"
}

func allSources() -> [TISInputSource] {
    guard let list = TISCreateInputSourceList(nil, false) else { return [] }
    return (list.takeRetainedValue() as? [TISInputSource]) ?? []
}

// MARK: - subcommands

func current() {
    guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else {
        print("{\"mode\":null}")
        return
    }
    let mode = modeOf(source)
    if let mode = mode {
        // sourceJSON emits {"id":...}; splice the mode field in front.
        let fields = String(sourceJSON(source, selected: true).dropFirst())
        print("{\"mode\":\"\(jsonEscape(mode))\",\(fields)")
    } else {
        print("{\"mode\":null}")
    }
}

func list() {
    let currentSource = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
    let currentID = currentSource.flatMap { tisString($0, kTISPropertyInputSourceID) }
    let entries = allSources().map { source -> String in
        let id = tisString(source, kTISPropertyInputSourceID)
        return sourceJSON(source, selected: id != nil && id == currentID)
    }
    print("{\"sources\":[\(entries.joined(separator: ","))]}")
}

func select(mode: String) {
    // Match by input source ID first (stable), then localized name —
    // the order a caller's stored mode expects.
    let candidates = allSources()
    func matches(_ source: TISInputSource) -> Bool {
        tisString(source, kTISPropertyInputSourceID) == mode ||
        tisString(source, kTISPropertyLocalizedName) == mode
    }
    guard let source = candidates.first(where: matches) else {
        failRuntime("no input source matches '\(mode)' — run 'input-source list' to see what is installed")
    }
    guard tisBool(source, kTISPropertyInputSourceIsEnabled) else {
        failRuntime("input source '\(mode)' is installed but not enabled in System Settings")
    }
    guard tisBool(source, kTISPropertyInputSourceIsSelectCapable) else {
        failRuntime("input source '\(mode)' cannot be selected programmatically")
    }
    let status = TISSelectInputSource(source)
    guard status == noErr else {
        failRuntime("TISSelectInputSource failed with OSStatus \(status)")
    }
    // Read back what is actually current — report observed, never assumed.
    var observed: String? = nil
    if let unmanaged = TISCopyCurrentKeyboardInputSource() {
        observed = modeOf(unmanaged.takeRetainedValue())
    }
    print("{\"ok\":true,\"requested\":\"\(jsonEscape(mode))\",\"observed\":\(observed.map { "\"\(jsonEscape($0))\"" } ?? "null")}")
}

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { failUsage("missing subcommand") }

func optionValue(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

switch command {
case "current":
    current()
case "list":
    list()
case "select":
    guard let mode = optionValue("--mode"), !mode.isEmpty else {
        failUsage("select expects --mode ID-OR-NAME")
    }
    select(mode: mode)
default:
    failUsage("unknown subcommand '\(command)'")
}
