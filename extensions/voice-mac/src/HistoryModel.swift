import Foundation
import SwiftUI
import Combine

public enum VoiceState: Equatable {
    case idle
    case listening
    case thinking
    case speaking
}

public enum UIMode: String {
    case notch = "notch"
    case bottom = "bottom"
}

public struct ConversationTurn: Identifiable, Equatable {
    public let id = UUID()
    public let role: String // "user" or "assistant"
    public var text: String
    public let timestamp = Date()
}

public class VoiceViewModel: ObservableObject {
    @Published public var state: VoiceState = .idle
    @Published public var audioLevel: Float = 0.0
    @Published public var turns: [ConversationTurn] = []
    @Published public var isVisible: Bool = false
    @Published public var uiMode: UIMode = .notch
    @Published public var statusMessage: String = ""
    @Published public var isVoiceNotRecognized: Bool = false

    private var autoHideTimer: Timer?
    public let maxTurns: Int = 5
    public var onResetSession: (() -> Void)?
    public var onTouchIdUnlock: (() -> Void)?

    public init(uiMode: UIMode = .notch) {
        self.uiMode = uiMode
    }

    public func setListening() {
        stopAutoHideTimer()
        isVoiceNotRecognized = false
        state = .listening
        statusMessage = "Listening..."
        withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
            isVisible = true
        }
    }

    public func setTranscribing() {
        stopAutoHideTimer()
        isVoiceNotRecognized = false
        state = .thinking
        statusMessage = "Transcribing audio..."
        audioLevel = 0.0
    }

    public func setThinking(prompt: String) {
        stopAutoHideTimer()
        isVoiceNotRecognized = false
        state = .thinking
        statusMessage = "Thinking..."
        audioLevel = 0.0
        // Add user turn
        addTurn(role: "user", text: prompt)
    }

    public func setSpeaking(response: String) {
        stopAutoHideTimer()
        isVoiceNotRecognized = false
        state = .speaking
        statusMessage = "Speaking..."
        // Add assistant turn
        addTurn(role: "assistant", text: response)
    }

    public func setVoiceNotRecognized() {
        stopAutoHideTimer()
        state = .idle
        isVoiceNotRecognized = true
        statusMessage = "🔒 Voice not recognized"
        audioLevel = 0.0
        startAutoHideTimer(after: 30.0)
    }

    public func setIdle() {
        state = .idle
        isVoiceNotRecognized = false
        statusMessage = ""
        audioLevel = 0.0
        startAutoHideTimer(after: 15.0)
    }

    public func clearSessionHistory() {
        if Thread.isMainThread {
            self.turns.removeAll()
            self.state = .idle
            self.isVoiceNotRecognized = false
            self.statusMessage = "Session cleared"
            self.audioLevel = 0.0
            self.startAutoHideTimer(after: 15.0)
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.clearSessionHistory()
            }
        }
    }

    public func addTurn(role: String, text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }

        // If last turn has same role, update it, else append
        if let last = turns.last, last.role == role {
            turns[turns.count - 1].text = clean
        } else {
            turns.append(ConversationTurn(role: role, text: clean))
            if turns.count > maxTurns {
                turns.removeFirst(turns.count - maxTurns)
            }
        }
    }

    public func dismiss(force: Bool = false) {
        // If not forced (e.g. from auto-hide timer or hover), keep HUD visible while agent is working!
        if !force && (state == .thinking || state == .speaking || state == .listening) {
            print("[voice:model] ⏳ Agent is active (\(state)). Keeping HUD visible.")
            return
        }

        stopAutoHideTimer()
        withAnimation(.easeOut(duration: 0.2)) {
            isVisible = false
            state = .idle
            statusMessage = ""
            isVoiceNotRecognized = false
        }
    }

    public func startAutoHideTimer(after seconds: TimeInterval = 15.0) {
        stopAutoHideTimer()
        // Only schedule auto-hide if state is idle
        guard state == .idle else {
            print("[voice:model] ⏳ Not scheduling auto-hide because agent is busy (\(state))")
            return
        }
        autoHideTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if self.state == .idle {
                    self.dismiss(force: true)
                } else {
                    print("[voice:model] ⏳ Auto-hide timer fired but agent is working (\(self.state)). Suppressing hide.")
                }
            }
        }
    }

    public func stopAutoHideTimer() {
        autoHideTimer?.invalidate()
        autoHideTimer = nil
    }
}
