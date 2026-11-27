// Witness app for the #379 CGEvent/IME PoC — an owned, disposable GUI
// process that records exactly what the text-input stack delivers to it.
//
//   swiftc -O ime-witness.swift -o ime-witness -framework AppKit
//   launchctl asuser 501 /tmp/ae379/ime-witness /tmp/ae379/witness.log 30
//
// It opens a small window with an NSTextView, activates itself, and for
// `duration` seconds writes one JSON line per observed input event:
//   - keyDown NSEvents (characters, keyCode, flags, window/app key state)
//   - NSTextInputClient insertText (committed text) and setMarkedText
//     (uncommitted composition) calls — the IME oracle
//   - NSText.didChangeNotification dumps (full contents + marked range)
//
// This is a PoC probe, not product code: it lives under
// docs/evidence/ime-poc-<date>/ alongside the captured logs.
import AppKit

let args = CommandLine.arguments
let logPath = args.count > 1 ? args[1] : "/tmp/ime-witness.log"
let duration: TimeInterval = args.count > 2 ? (Double(args[2]) ?? 30) : 30

func jescape(_ s: String) -> String {
    var out = ""
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if u.value < 0x20 { out += String(format: "\\u%04x", u.value) }
            else { out += String(u) }
        }
    }
    return out
}

final class WitnessTextView: NSTextView {
    let logURL: URL
    var seq = 0

    init(logURL: URL, frame: NSRect) {
        self.logURL = logURL
        super.init(frame: frame, textContainer: nil)
        isRichText = false
        allowsUndo = false
        isAutomaticQuoteSubstitutionEnabled = false
        isAutomaticDashSubstitutionEnabled = false
        isAutomaticTextReplacementEnabled = false
        isAutomaticSpellingCorrectionEnabled = false
        isContinuousSpellCheckingEnabled = false
        textContainerInset = NSSize(width: 4, height: 4)
    }

    required init?(coder: NSCoder) { fatalError("unused") }

    func emit(_ record: String) {
        let line = "{\"t\":\(Date().timeIntervalSince1970*1000),\"seq\":\(seq),\(record)}\n"
        seq += 1
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile(); h.write(Data(line.utf8)); h.closeFile()
        } else {
            try? Data(line.utf8).write(to: logURL)
        }
    }

    func stateBits() -> String {
        let marked = hasMarkedText()
        let mr = markedRange()
        var markedText = "null"
        if marked, mr.location != NSNotFound {
            let r = mr
            let s = (string as NSString).substring(with: r)
            markedText = "\"\(jescape(s))\""
        }
        return "\"keyWindow\":\(window?.isKeyWindow == true),\"mainWindow\":\(window?.isMainWindow == true),\"appActive\":\(NSApp.isActive),\"hasMarkedText\":\(marked),\"markedText\":\(markedText)"
    }

    override func keyDown(with event: NSEvent) {
        emit("\"kind\":\"keyDown\",\"chars\":\"\(jescape(event.characters ?? ""))\",\"charsNoMods\":\"\(jescape(event.charactersIgnoringModifiers ?? ""))\",\"keyCode\":\(event.keyCode),\"flags\":\(event.modifierFlags.rawValue),\"ts\":\(event.timestamp),\"repeat\":\(event.isARepeat),\"firstResponder\":\"\(window?.firstResponder.map{ String(describing: type(of: $0)) } ?? "nil")\",\(stateBits())")
        super.keyDown(with: event)
    }

    override func flagsChanged(with event: NSEvent) {
        emit("\"kind\":\"flagsChanged\",\"keyCode\":\(event.keyCode),\"flags\":\(event.modifierFlags.rawValue),\(stateBits())")
        super.flagsChanged(with: event)
    }

    override func insertText(_ insertString: Any, replacementRange: NSRange) {
        emit("\"kind\":\"insertText\",\"text\":\"\(jescape((insertString as? NSAttributedString)?.string ?? (insertString as? String) ?? ""))\",\(stateBits())")
        super.insertText(insertString, replacementRange: replacementRange)
    }

    override func insertText(_ insertString: Any) {
        let t = (insertString as? NSAttributedString)?.string ?? (insertString as? String) ?? ""
        emit("\"kind\":\"insertText1\",\"text\":\"\(jescape(t))\",\(stateBits())")
        super.insertText(insertString)
    }

    override func setMarkedText(_ string: Any?, selectedRange: NSRange, replacementRange: NSRange) {
        let s = (string as? NSAttributedString)?.string ?? (string as? String) ?? ""
        emit("\"kind\":\"setMarkedText\",\"text\":\"\(jescape(s))\",\"replacementRange\":\(replacementRange.location),\(stateBits())")
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
    }

    override func unmarkText() {
        emit("\"kind\":\"unmarkText\",\(stateBits())")
        super.unmarkText()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let win = NSWindow(
    contentRect: NSRect(x: 200, y: 200, width: 480, height: 220),
    styleMask: [.titled, .closable, .resizable],
    backing: .buffered, defer: false)
win.title = "ime-witness"

let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 480, height: 220))
scroll.hasVerticalScroller = true
let tv = WitnessTextView(logURL: URL(fileURLWithPath: logPath), frame: scroll.bounds)
tv.autoresizingMask = [.width, .height]
scroll.documentView = tv
win.contentView = scroll
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
win.makeFirstResponder(tv)

// Clear/create the log up front with a header record.
let header = "{\"t\":\(Date().timeIntervalSince1970*1000),\"kind\":\"start\",\"pid\":\(ProcessInfo.processInfo.processIdentifier),\"duration\":\(duration)}\n"
try? Data(header.utf8).write(to: URL(fileURLWithPath: logPath))

NotificationCenter.default.addObserver(
    forName: NSText.didChangeNotification, object: tv.textStorage, queue: nil
) { _ in
    let marked = tv.hasMarkedText()
    let contents = tv.string
    var mr = "null"
    let rr = tv.markedRange()
    if rr.location != NSNotFound { mr = "{\"loc\":\(rr.location),\"len\":\(rr.length)}" }
    let rec = "{\"kind\":\"didChange\",\"contents\":\"\(jescape(contents))\",\"hasMarkedText\":\(marked),\"markedRange\":\(mr)}\n"
    if let h = try? FileHandle(forWritingTo: URL(fileURLWithPath: logPath)) {
        h.seekToEndOfFile(); h.write(Data(rec.utf8)); h.closeFile()
    }
}

// Re-activate on demand: while /tmp/ae379/FOCUSME exists, keep trying to
// become key (the PoC driver touches the file, posts, then removes it).
let focusURL = URL(fileURLWithPath: "/tmp/ae379/FOCUSME")
Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in
    if FileManager.default.fileExists(atPath: focusURL.path) {
        app.activate(ignoringOtherApps: true)
        win.makeKeyAndOrderFront(nil)
        win.makeFirstResponder(tv)
        try? FileManager.default.removeItem(at: focusURL)
    }
}

DispatchQueue.main.asyncAfter(deadline: .now() + duration) {
    let rec = "{\"kind\":\"end\",\"t\":\(Date().timeIntervalSince1970*1000)}\n"
    if let h = try? FileHandle(forWritingTo: URL(fileURLWithPath: logPath)) {
        h.seekToEndOfFile(); h.write(Data(rec.utf8)); h.closeFile()
    }
    exit(0)
}

app.run()
