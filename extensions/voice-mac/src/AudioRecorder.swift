import Foundation
import AVFoundation

public class AudioRecorder: NSObject {
    private var audioRecorder: AVAudioRecorder?
    private var meterTimer: Timer?
    public var onLevelUpdate: ((Float) -> Void)?

    public override init() {
        super.init()
    }

    public func startRecording(to fileURL: URL) -> Bool {
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 16000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false
        ]

        do {
            audioRecorder = try AVAudioRecorder(url: fileURL, settings: settings)
            audioRecorder?.isMeteringEnabled = true
            guard let recorder = audioRecorder, recorder.record() else {
                return false
            }

            // Start meter timer at ~30 FPS
            meterTimer?.invalidate()
            meterTimer = Timer.scheduledTimer(withTimeInterval: 0.033, repeats: true) { [weak self] _ in
                guard let self = self, let rec = self.audioRecorder, rec.isRecording else { return }
                rec.updateMeters()
                let avgPower = rec.averagePower(forChannel: 0) // -160 to 0 dB
                // Normalize from dB to 0.0 ... 1.0 linear scale
                let minDb: Float = -60.0
                let normalized: Float
                if avgPower < minDb {
                    normalized = 0.0
                } else if avgPower >= 0 {
                    normalized = 1.0
                } else {
                    normalized = (avgPower - minDb) / (-minDb)
                }
                self.onLevelUpdate?(normalized)
            }
            return true
        } catch {
            print("[voice:recorder] Failed to initialize AVAudioRecorder: \(error)")
            return false
        }
    }

    public func stopRecording() {
        meterTimer?.invalidate()
        meterTimer = nil
        audioRecorder?.stop()
        audioRecorder = nil
        onLevelUpdate?(0.0)
    }
}
