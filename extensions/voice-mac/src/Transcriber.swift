import Foundation

public class Transcriber {
    private let whisperPath: String
    private let model: String
    private let language: String

    public init(whisperPath: String? = nil, model: String? = nil, language: String = "en") {
        self.language = language
        if let path = whisperPath {
            self.whisperPath = path
        } else {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let defaultMlx = "\(home)/.venv-vllm-metal/bin/mlx_whisper"
            if FileManager.default.fileExists(atPath: defaultMlx) {
                self.whisperPath = defaultMlx
            } else {
                self.whisperPath = "/opt/homebrew/bin/mlx_whisper"
            }
        }
        if let model = model, !model.isEmpty {
            self.model = model
        } else if let envModel = ProcessInfo.processInfo.environment["WHISPER_MODEL"], !envModel.isEmpty {
            self.model = envModel
        } else {
            self.model = "mlx-community/whisper-small-4bit"
        }
    }

    public func prewarm() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self, FileManager.default.fileExists(atPath: self.whisperPath) else { return }
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: self.whisperPath)
            proc.arguments = ["--help"]
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            try? proc.run()
            proc.waitUntilExit()
            print("[voice:stt] ⚡ MLX Whisper warmed up")
        }
    }

    public func transcribe(audioFileURL: URL) -> String? {
        guard FileManager.default.fileExists(atPath: audioFileURL.path) else {
            print("[voice:stt] Audio file not found at \(audioFileURL.path)")
            return nil
        }

        guard FileManager.default.fileExists(atPath: whisperPath) else {
            print("[voice:stt] MLX Whisper binary not found at \(whisperPath)")
            return nil
        }

        let prefix = "minclaw_voice_\(Int(Date().timeIntervalSince1970 * 1000))"
        let tmpDir = "/tmp"
        let txtPath = "\(tmpDir)/\(prefix).txt"

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: whisperPath)
        proc.arguments = [
            audioFileURL.path,
            "--model", model,
            "--language", language,
            "--condition-on-previous-text", "False",
            "--output-dir", tmpDir,
            "--output-name", prefix,
            "--output-format", "txt"
        ]

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe

        do {
            try proc.run()
            proc.waitUntilExit()

            if proc.terminationStatus != 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let errStr = String(data: data, encoding: .utf8) ?? ""
                print("[voice:stt] Whisper process failed (code \(proc.terminationStatus)): \(errStr)")
                return nil
            }

            guard FileManager.default.fileExists(atPath: txtPath),
                  let text = try? String(contentsOfFile: txtPath, encoding: .utf8) else {
                return nil
            }

            try? FileManager.default.removeItem(atPath: txtPath)
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }

            // Guard against noise / punctuation-only transcripts (e.g. ".", "...", "!", "-")
            guard trimmed.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) else {
                print("[voice:stt] Filtered noise/punctuation-only transcript: \"\(trimmed)\"")
                return ""
            }

            return trimmed
        } catch {
            print("[voice:stt] Transcription execution error: \(error)")
            return nil
        }
    }
}
