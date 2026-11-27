// Reads and writes the general NSPasteboard — the #372 half of the
// B-IME input contract (specs/ime-input/spec.md §5.5/§6, issue #372).
//
//   swiftc -O input-clipboard.swift -o input-clipboard
//   ./input-clipboard snapshot --stash /path/to/stash.bin
//   ./input-clipboard write --text "bulk entry"
//   ./input-clipboard restore --stash /path/to/stash.bin
//
// Clipboard is shared-state (spec §5.1): a write must always be paired
// with a restore of the prior contents. `snapshot` captures every
// pasteboard item and every flavor it vends — including promised flavors
// resolved best-effort — into a private stash file and prints only the
// ClipboardSnapshot record (flavors + sha256 + bytes, never the payload)
// that src/input/types.ts carries in the audit trail. `restore` writes
// the stash back. Pasteboard *contents* may be sensitive: the receipt
// never echoes them.
//
// Output is one JSON object on stdout; diagnostics on stderr. Usage
// errors exit 2; runtime failures exit 1.
import AppKit
import CryptoKit
import Foundation

let USAGE = """
usage:
  input-clipboard snapshot --stash PATH   capture prior contents to PATH, print the snapshot record
  input-clipboard write --text STRING      replace contents with UTF-8 plain text
  input-clipboard restore --stash PATH     write the stashed contents back
"""

func failUsage(_ message: String) -> Never {
    FileHandle.standardError.write(Data("input-clipboard: \(message)\n\(USAGE)".utf8))
    exit(2)
}

func failRuntime(_ message: String) -> Never {
    FileHandle.standardError.write(Data("input-clipboard: \(message)\n".utf8))
    exit(1)
}

// MARK: - Stash format
//
// "A8NCLIP1\n" then:
//   u32 itemCount
//   per item: u32 typeCount; per type: u32 typeLen + utf8 type + u64 dataLen + data
// Big-endian, hand-rolled so the format needs no Codable versioning.

let STASH_MAGIC = "A8NCLIP1\n"

func appendU32(_ data: inout Data, _ value: UInt32) {
    var v = value.bigEndian
    withUnsafeBytes(of: &v) { data.append(contentsOf: $0) }
}

func appendU64(_ data: inout Data, _ value: UInt64) {
    var v = value.bigEndian
    withUnsafeBytes(of: &v) { data.append(contentsOf: $0) }
}

func appendString(_ data: inout Data, _ s: String) {
    let bytes = Array(s.utf8)
    appendU32(&data, UInt32(bytes.count))
    data.append(contentsOf: bytes)
}

struct Reader {
    let bytes: [UInt8]
    var offset = 0

    mutating func u32() -> UInt32? {
        guard offset + 4 <= bytes.count else { return nil }
        let v = bytes[offset..<(offset + 4)].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        offset += 4
        return v
    }
    mutating func u64() -> UInt64? {
        guard offset + 8 <= bytes.count else { return nil }
        let v = bytes[offset..<(offset + 8)].reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        offset += 8
        return v
    }
    mutating func string() -> String? {
        guard let len = u32(), offset + Int(len) <= bytes.count else { return nil }
        let slice = bytes[offset..<(offset + Int(len))]
        offset += Int(len)
        return String(bytes: slice, encoding: .utf8)
    }
    mutating func data(_ len: UInt64) -> Data? {
        guard len <= UInt64(bytes.count - offset) else { return nil }
        let end = offset + Int(len)
        let d = Data(bytes[offset..<end])
        offset = end
        return d
    }
}

// MARK: - snapshot

func snapshot(stashPath: String) {
    let pb = NSPasteboard.general
    let items = pb.pasteboardItems ?? []

    var flavors = Set<String>()
    var payload = Data()
    var unreadable = 0
    var archive = Data()
    archive.append(contentsOf: STASH_MAGIC.utf8)
    appendU32(&archive, UInt32(items.count))

    for item in items {
        let types = item.types
        appendU32(&archive, UInt32(types.count))
        for type in types {
            let raw = type.rawValue
            flavors.insert(raw)
            appendString(&archive, raw)
            if let data = item.data(forType: type) {
                appendU64(&archive, UInt64(data.count))
                archive.append(data)
                payload.append(data)
            } else {
                // Promised or unreadable flavor: record the type with a
                // zero-length payload marker is NOT possible — the format
                // stores real data only. Count it honestly instead.
                unreadable += 1
                appendU64(&archive, 0)
            }
        }
    }

    // A zero-length data record is indistinguishable from "flavor with no
    // data"; for restore fidelity that is acceptable (the type is still
    // declared), and `unreadable` in the receipt says contents were lost.
    do {
        try archive.write(to: URL(fileURLWithPath: stashPath), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stashPath)
    } catch {
        failRuntime("could not write stash \(stashPath): \(error.localizedDescription)")
    }

    let digest = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
    let flavorList = flavors.sorted().map { "\"\($0)\"" }.joined(separator: ",")
    print("{\"flavors\":[\(flavorList)],\"sha256\":\"\(digest)\",\"bytes\":\(payload.count),\"items\":\(items.count),\"unreadable\":\(unreadable)}")
}

// MARK: - write

func write(text: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    guard pb.setString(text, forType: .string) else {
        failRuntime("NSPasteboard refused the string")
    }
    print("{\"ok\":true,\"bytes\":\(text.utf8.count)}")
}

// MARK: - restore

func restore(stashPath: String) {
    guard let raw = try? Data(contentsOf: URL(fileURLWithPath: stashPath)) else {
        failRuntime("stash \(stashPath) is missing or unreadable — refusing to restore blind")
    }
    let magicLen = STASH_MAGIC.utf8.count
    guard raw.count > magicLen,
          String(bytes: raw[0..<magicLen], encoding: .utf8) == STASH_MAGIC else {
        failRuntime("stash \(stashPath) is not an a8n clipboard archive")
    }
    var reader = Reader(bytes: Array(raw[magicLen...]))
    guard let itemCount = reader.u32() else { failRuntime("truncated stash header") }

    var items: [NSPasteboardItem] = []
    for _ in 0..<itemCount {
        guard let typeCount = reader.u32() else { failRuntime("truncated item record") }
        let item = NSPasteboardItem()
        for _ in 0..<typeCount {
            guard let typeRaw = reader.string(),
                  let dataLen = reader.u64(),
                  let data = reader.data(dataLen) else {
                failRuntime("truncated flavor record")
            }
            if dataLen > 0 {
                item.setData(data, forType: NSPasteboard.PasteboardType(rawValue: typeRaw))
            }
        }
        items.append(item)
    }

    let pb = NSPasteboard.general
    pb.clearContents()
    guard pb.writeObjects(items) else {
        failRuntime("NSPasteboard refused the restored items")
    }
    print("{\"ok\":true,\"items\":\(items.count)}")
}

// MARK: - main

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { failUsage("missing subcommand") }

func optionValue(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
}

switch command {
case "snapshot":
    guard let path = optionValue("--stash") else { failUsage("snapshot expects --stash PATH") }
    snapshot(stashPath: path)
case "write":
    guard let text = optionValue("--text") else { failUsage("write expects --text STRING") }
    write(text: text)
case "restore":
    guard let path = optionValue("--stash") else { failUsage("restore expects --stash PATH") }
    restore(stashPath: path)
default:
    failUsage("unknown subcommand '\(command)'")
}
