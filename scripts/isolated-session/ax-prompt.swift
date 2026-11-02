// Asks macOS about the Accessibility permission, in whichever session runs
// this.
//
// With `ask` (the default) it also *raises* the prompt: macOS shows
// "Terminal wants to control this computer" on this session's screen, and
// the grant lands on Terminal.app — which is what we want, because every
// child of it (osascript, node) then inherits the permission.
//
// Without `ask` it only reports the current state and never raises a dialog.
//
// The permission is per user and per session: a grant given in the console
// session says nothing about the test user's session.
import ApplicationServices
import Foundation

let ask = CommandLine.arguments.count < 2 || CommandLine.arguments[1] == "ask"

if ask {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(options)
    print(trusted ? "AX_TRUSTED" : "AX_NOT_TRUSTED (a dialog should be on this session's screen now)")
} else {
    print(AXIsProcessTrusted() ? "AX_TRUSTED" : "AX_NOT_TRUSTED")
}
