import AppKit
import Foundation

// Parse command line arguments
var selectedMode: UIMode = .notch
var selectedHotkey: HotkeyType = .rightOption

var args = CommandLine.arguments.dropFirst()
while !args.isEmpty {
    let arg = args.removeFirst()
    if arg == "--mode", !args.isEmpty {
        let val = args.removeFirst().lowercased()
        if val == "bottom" {
            selectedMode = .bottom
        } else {
            selectedMode = .notch
        }
    } else if arg == "--hotkey", !args.isEmpty {
        let val = args.removeFirst().lowercased()
        switch val {
        case "fn": selectedHotkey = .fn
        case "left-option": selectedHotkey = .leftOption
        case "right-command": selectedHotkey = .rightCommand
        default: selectedHotkey = .rightOption
        }
    } else if arg == "--help" || arg == "-h" {
        print("""
        Usage: minclaw-voice [options]

        Options:
          --mode <notch|bottom>     UI display mode (default: notch)
          --hotkey <key>            Push-to-talk key: right-option, fn, left-option, right-command (default: right-option)
          --help                    Show help
        """)
        exit(0)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // Runs as menu-bar/background accessory, no dock icon

let delegate = VoiceApp(mode: selectedMode, hotkey: selectedHotkey)
app.delegate = delegate
app.run()
