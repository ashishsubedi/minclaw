import AppKit
import Foundation

// Unbuffer stdout and stderr so logs flush immediately when redirected to file
setbuf(stdout, nil)
setbuf(stderr, nil)

// Parse command line arguments
var selectedMode: UIMode = .notch
var selectedHotkey: HotkeyType = .rightOption
var selectedModel: String? = nil

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
    } else if arg == "--model", !args.isEmpty {
        selectedModel = args.removeFirst()
    } else if arg == "--record-phrase", !args.isEmpty {
        let outputPath = args.removeFirst()
        var duration: Double = 5.0
        if !args.isEmpty, let d = Double(args.first!) {
            _ = args.removeFirst()
            duration = d
        }
        let url = URL(fileURLWithPath: outputPath)
        let parentDir = url.deletingLastPathComponent().path
        if !FileManager.default.fileExists(atPath: parentDir) {
            try? FileManager.default.createDirectory(atPath: parentDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let recorder = AudioRecorder()
        print("[voice:record] 🎙️ Recording phrase to \(outputPath) for \(duration)s...")
        if !recorder.startRecording(to: url) {
            fputs("Failed to start audio recording\n", stderr)
            exit(1)
        }
        Thread.sleep(forTimeInterval: duration)
        recorder.stopRecording()
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: outputPath)
        print("[voice:record] ✅ Recorded successfully to \(outputPath)")
        exit(0)
    } else if arg == "--check-locked" {
        print(isScreenLocked() ? "true" : "false")
        exit(0)
    } else if arg == "--help" || arg == "-h" {
        print("""
        Usage: minclaw-voice [options]

        Options:
          --mode <notch|bottom>         UI display mode (default: notch)
          --hotkey <key>                Push-to-talk key: right-option, fn, left-option, right-command (default: right-option)
          --model <model>               Whisper model (default: mlx-community/whisper-small-mlx-4bit or $WHISPER_MODEL)
          --record-phrase <path> [sec]  Record phrase directly to wav file and exit
          --check-locked                Output true/false for lock screen state
          --help                        Show help
        """)
        exit(0)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // Runs as menu-bar/background accessory, no dock icon

let delegate = VoiceApp(mode: selectedMode, hotkey: selectedHotkey, model: selectedModel)
app.delegate = delegate
app.run()
