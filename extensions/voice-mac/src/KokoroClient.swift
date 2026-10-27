import Foundation
import AVFoundation
import AppKit

public class KokoroClient: NSObject, AVAudioPlayerDelegate {
    private let socketPath: String
    private var audioPlayer: AVAudioPlayer?
    private var activeSayProcess: Process?
    private var playbackGeneration: Int = 0

    public var onPlaybackFinished: (() -> Void)?

    public override init() {
        let stateDir = ProcessInfo.processInfo.environment["MINCLAW_STATE_DIR"] ?? "\(FileManager.default.homeDirectoryForCurrentUser.path)/.minclaw"
        self.socketPath = "\(stateDir)/kokoro.sock"
        super.init()
    }

    public func findKokoroScriptPath() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates: [String] = []

        if let envScript = ProcessInfo.processInfo.environment["MINCLAW_KOKORO_SCRIPT"], !envScript.isEmpty {
            candidates.append(envScript)
        }

        // Relative to binary location (e.g. extensions/voice-mac/bin/minclaw-voice -> ../tts/kokoro_server.py)
        if let execPath = Bundle.main.executablePath {
            let execURL = URL(fileURLWithPath: execPath)
            let relativePath = execURL.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("tts/kokoro_server.py").path
            candidates.append(relativePath)
        }

        // Current working directory
        let cwd = FileManager.default.currentDirectoryPath
        candidates.append("\(cwd)/extensions/voice-mac/tts/kokoro_server.py")

        // Standard workspace paths
        candidates.append("\(home)/workspace/minclaw/extensions/voice-mac/tts/kokoro_server.py")
        candidates.append("\(home)/workspace/minclaw-voice/extensions/voice-mac/tts/kokoro_server.py")

        for path in candidates {
            if FileManager.default.fileExists(atPath: path) {
                return path
            }
        }
        return nil
    }

    public func findPythonPath() -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates: [String] = []

        if let envPython = ProcessInfo.processInfo.environment["MINCLAW_PYTHON"], !envPython.isEmpty {
            candidates.append(envPython)
        }
        if let envPython = ProcessInfo.processInfo.environment["PYTHON_PATH"], !envPython.isEmpty {
            candidates.append(envPython)
        }

        candidates.append("\(home)/.venv-vllm-metal/bin/python3")
        candidates.append("/opt/homebrew/bin/python3")
        candidates.append("/usr/local/bin/python3")
        candidates.append("/usr/bin/python3")

        for path in candidates {
            if FileManager.default.fileExists(atPath: path) {
                return path
            }
        }
        return nil
    }

    public func isServerRunning() -> Bool {
        guard FileManager.default.fileExists(atPath: socketPath) else { return false }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard socketPath.utf8.count < maxLen else { return false }
        strncpy(&addr.sun_path.0, socketPath, maxLen - 1)

        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, len)
            }
        }

        if connectResult == 0 {
            return true
        } else {
            // Stale socket file on disk
            try? FileManager.default.removeItem(atPath: socketPath)
            return false
        }
    }

    public func ensureServerRunning() {
        if isServerRunning() {
            sendWarmup()
            return
        }

        guard let pythonPath = findPythonPath(),
              let scriptPath = findKokoroScriptPath() else {
            print("[voice:kokoro] ⚠️ Missing python or kokoro_server.py; will fallback to system TTS")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: pythonPath)
        proc.arguments = [scriptPath]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            print("[voice:kokoro] 🚀 Launched Kokoro background server (\(pythonPath))")

            // Wait up to 3 seconds for socket creation
            for _ in 0..<30 {
                usleep(100_000)
                if isServerRunning() {
                    sendWarmup()
                    break
                }
            }
        } catch {
            print("[voice:kokoro] Failed to start Kokoro server: \(error)")
        }
    }

    private func sendWarmup() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else { return }
            let req: [String: Any] = ["action": "warmup"]
            _ = self.sendSocketRequest(req)
        }
    }

    public func stopPlayback() {
        playbackGeneration += 1

        if let player = audioPlayer {
            player.stop()
            audioPlayer = nil
            print("[voice:kokoro] ⏹️ Stopped audio playback")
        }

        if let proc = activeSayProcess, proc.isRunning {
            proc.terminate()
            activeSayProcess = nil
            print("[voice:say] ⏹️ Terminated system say process")
        }

        onPlaybackFinished = nil
    }

    public func speak(text: String, voice: String = "af_heart", speed: Float = 1.0, lang: String = "en", completion: (() -> Void)? = nil) {
        stopPlayback()
        let currentGen = playbackGeneration

        let cleanText = cleanMarkdown(text)
        guard !cleanText.isEmpty else {
            completion?()
            return
        }

        ensureServerRunning()

        let tempOut = "/tmp/minclaw_kokoro_\(Int(Date().timeIntervalSince1970 * 1000)).wav"

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self, self.playbackGeneration == currentGen else { return }

            // Synthesize via Kokoro Unix socket (language filter handled by Kokoro server)
            let audioFile = self.synthesizeViaSocket(text: cleanText, outputPath: tempOut, voice: voice, speed: speed, lang: lang)

            DispatchQueue.main.async {
                guard self.playbackGeneration == currentGen else {
                    print("[voice:kokoro] 🚫 Playback cancelled while synthesizing; discarding audio")
                    if let file = audioFile {
                        try? FileManager.default.removeItem(atPath: file)
                    }
                    return
                }

                if let file = audioFile {
                    self.playAudioFile(URL(fileURLWithPath: file)) {
                        guard self.playbackGeneration == currentGen else { return }
                        completion?()
                    }
                } else {
                    // Fallback to system say
                    print("[voice:kokoro] Falling back to macOS 'say'...")
                    self.speakViaSystemSay(cleanText) {
                        guard self.playbackGeneration == currentGen else { return }
                        completion?()
                    }
                }
            }
        }
    }

    public func stripEmojis(_ text: String) -> String {
        return String(text.unicodeScalars.filter { scalar in
            if scalar.properties.isEmojiPresentation { return false }
            if scalar.properties.isEmoji && scalar.value > 0x2000 { return false }
            switch scalar.value {
            case 0x1F600...0x1F64F, 0x1F300...0x1F5FF, 0x1F680...0x1F6FF,
                 0x1F1E0...0x1F1FF, 0x2600...0x26FF, 0x2700...0x27BF,
                 0xFE00...0xFE0F, 0x1F900...0x1F9FF, 0x1FA00...0x1FA6F,
                 0x1FA70...0x1FAFF:
                return false
            default:
                return true
            }
        })
    }

    public func cleanMarkdown(_ text: String) -> String {
        var clean = stripEmojis(text)
        // Bold & Italics
        clean = clean.replacingOccurrences(of: "\\*\\*([^*]+)\\*\\*", with: "$1", options: .regularExpression)
        clean = clean.replacingOccurrences(of: "\\*([^*]+)\\*", with: "$1", options: .regularExpression)
        clean = clean.replacingOccurrences(of: "__([^_]+)__", with: "$1", options: .regularExpression)
        clean = clean.replacingOccurrences(of: "_([^_]+)_", with: "$1", options: .regularExpression)
        // Strikethrough
        clean = clean.replacingOccurrences(of: "~~([^~]+)~~", with: "$1", options: .regularExpression)
        // Inline code and codeblocks
        clean = clean.replacingOccurrences(of: "```[a-zA-Z]*\\n([\\s\\S]*?)\\n```", with: "$1", options: .regularExpression)
        clean = clean.replacingOccurrences(of: "`([^`]+)`", with: "$1", options: .regularExpression)
        // Headers
        clean = clean.replacingOccurrences(of: "(?m)^#{1,6}\\s+", with: "", options: .regularExpression)
        // Links: [label](url) -> label
        clean = clean.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^\\)]+\\)", with: "$1", options: .regularExpression)
        // Blockquotes: > quote
        clean = clean.replacingOccurrences(of: "(?m)^>\\s+", with: "", options: .regularExpression)
        return clean.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func sendSocketRequest(_ payload: [String: Any]) -> [String: Any]? {
        guard FileManager.default.fileExists(atPath: socketPath) else { return nil }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        strncpy(&addr.sun_path.0, socketPath, maxLen - 1)

        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, len)
            }
        }
        guard connectResult == 0 else { return nil }

        guard var data = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        data.append(contentsOf: [0x0A])

        let written = data.withUnsafeBytes { ptr in
            write(fd, ptr.baseAddress, data.count)
        }
        guard written == data.count else { return nil }

        var buffer = Data()
        let chunk = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
        defer { chunk.deallocate() }

        let bytesRead = read(fd, chunk, 4096)
        guard bytesRead > 0 else { return nil }
        buffer.append(chunk, count: bytesRead)

        return (try? JSONSerialization.jsonObject(with: buffer)) as? [String: Any]
    }

    private func synthesizeViaSocket(text: String, outputPath: String, voice: String, speed: Float, lang: String = "en") -> String? {
        let req: [String: Any] = [
            "action": "synthesize",
            "text": text,
            "output_path": outputPath,
            "voice": voice,
            "speed": speed,
            "lang": lang
        ]

        guard let json = sendSocketRequest(req),
              let status = json["status"] as? String, status == "ok",
              let path = json["output_path"] as? String,
              FileManager.default.fileExists(atPath: path) else {
            return nil
        }

        return path
    }

    public func verifySpeaker(audioPath: String) -> (enrolled: Bool, verified: Bool, score: Float) {
        guard FileManager.default.fileExists(atPath: audioPath) else {
            return (enrolled: false, verified: true, score: 0.0)
        }
        ensureServerRunning()
        let req: [String: Any] = [
            "action": "verify_speaker",
            "audio_path": audioPath
        ]
        guard let resp = sendSocketRequest(req) else {
            // Fail-safe open if Kokoro server is unreachable
            return (enrolled: false, verified: true, score: 0.0)
        }
        let enrolled = resp["enrolled"] as? Bool ?? false
        let verified = resp["verified"] as? Bool ?? true
        let score = (resp["score"] as? NSNumber)?.floatValue ?? 0.0
        return (enrolled: enrolled, verified: verified, score: score)
    }

    public func getVoiceprintStatus() -> [String: Any]? {
        ensureServerRunning()
        let req: [String: Any] = [
            "action": "voiceprint_status"
        ]
        return sendSocketRequest(req)
    }

    private func playAudioFile(_ url: URL, completion: (() -> Void)?) {
        do {
            audioPlayer = try AVAudioPlayer(contentsOf: url)
            audioPlayer?.delegate = self
            self.onPlaybackFinished = completion
            audioPlayer?.play()
        } catch {
            print("[voice:kokoro] Audio playback error: \(error)")
            completion?()
        }
    }

    private func speakViaSystemSay(_ text: String, voice: String = "Samantha", completion: (() -> Void)?) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        proc.arguments = ["-v", voice, text]
        activeSayProcess = proc

        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.activeSayProcess = nil
                completion?()
            }
        }

        do {
            try proc.run()
        } catch {
            print("[voice:say] Execution error: \(error)")
            completion?()
        }
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        audioPlayer = nil
        DispatchQueue.main.async { [weak self] in
            self?.onPlaybackFinished?()
            self?.onPlaybackFinished = nil
        }
    }
}
