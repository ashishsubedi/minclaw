import Foundation
import AVFoundation
import AppKit

public class KokoroClient: NSObject, AVAudioPlayerDelegate {
    private let socketPath: String
    private var audioPlayer: AVAudioPlayer?
    private var activeSayProcess: Process?

    public var onPlaybackFinished: (() -> Void)?

    public override init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.socketPath = "\(home)/.minclaw/kokoro.sock"
        super.init()
    }

    public func isServerRunning() -> Bool {
        return FileManager.default.fileExists(atPath: socketPath)
    }

    public func ensureServerRunning() {
        if isServerRunning() { return }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let pythonPath = "\(home)/.venv-vllm-metal/bin/python3"
        let scriptPath = "\(home)/workspace/minclaw-voice/extensions/voice-mac/tts/kokoro_server.py"

        guard FileManager.default.fileExists(atPath: pythonPath),
              FileManager.default.fileExists(atPath: scriptPath) else {
            print("[voice:kokoro] Missing python or kokoro_server.py; will fallback to system TTS")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: pythonPath)
        proc.arguments = [scriptPath]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            print("[voice:kokoro] Launched Kokoro background server...")
            // Wait up to 2 seconds for socket
            for _ in 0..<20 {
                usleep(100_000)
                if isServerRunning() { break }
            }
        } catch {
            print("[voice:kokoro] Failed to start Kokoro server: \(error)")
        }
    }

    public func stopPlayback() {
        if let player = audioPlayer, player.isPlaying {
            player.stop()
            audioPlayer = nil
            print("[voice:kokoro] Interrupted active playback (barge-in)")
        }

        if let proc = activeSayProcess, proc.isRunning {
            proc.terminate()
            activeSayProcess = nil
        }
    }

    public func speak(text: String, voice: String = "af_heart", speed: Float = 1.0, completion: (() -> Void)? = nil) {
        stopPlayback()

        let cleanText = cleanMarkdown(text)
        guard !cleanText.isEmpty else {
            completion?()
            return
        }

        ensureServerRunning()

        let tempOut = "/tmp/minclaw_kokoro_\(Int(Date().timeIntervalSince1970 * 1000)).wav"

        // Attempt Kokoro synthesis over Unix socket
        if let audioFile = synthesizeViaSocket(text: cleanText, outputPath: tempOut, voice: voice, speed: speed) {
            playAudioFile(URL(fileURLWithPath: audioFile)) {
                completion?()
            }
        } else {
            // Fallback to system say
            print("[voice:kokoro] Falling back to macOS 'say'...")
            speakViaSystemSay(cleanText) {
                completion?()
            }
        }
    }

    private func cleanMarkdown(_ text: String) -> String {
        var clean = text
        clean = clean.replacingOccurrences(of: "\\*\\*([^*]+)\\*\\*", with: "$1", options: .regularExpression)
        clean = clean.replacingOccurrences(of: "\\*([^*]+)\\*", with: "$1", options: .regularExpression)
        clean = clean.replacingOccurrences(of: "`([^`]+)`", with: "$1", options: .regularExpression)
        clean = clean.replacingOccurrences(of: "#+\\s+", with: "", options: .regularExpression)
        clean = clean.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^\\)]+\\)", with: "$1", options: .regularExpression)
        return clean.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func synthesizeViaSocket(text: String, outputPath: String, voice: String, speed: Float) -> String? {
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

        let req: [String: Any] = [
            "action": "synthesize",
            "text": text,
            "output_path": outputPath,
            "voice": voice,
            "speed": speed
        ]

        guard var data = try? JSONSerialization.data(withJSONObject: req) else { return nil }
        data.append(contentsOf: [0x0A])

        let written = data.withUnsafeBytes { ptr in
            write(fd, ptr.baseAddress, data.count)
        }
        guard written == data.count else { return nil }

        // Read response
        var buffer = Data()
        let chunk = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
        defer { chunk.deallocate() }

        let bytesRead = read(fd, chunk, 4096)
        guard bytesRead > 0 else { return nil }
        buffer.append(chunk, count: bytesRead)

        guard let json = try? JSONSerialization.jsonObject(with: buffer) as? [String: Any],
              let status = json["status"] as? String, status == "ok",
              let path = json["output_path"] as? String,
              FileManager.default.fileExists(atPath: path) else {
            return nil
        }

        return path
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

    private func speakViaSystemSay(_ text: String, completion: (() -> Void)?) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        proc.arguments = ["-v", "Samantha", text]
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
