import SwiftUI

public struct NotchHUDView: View {
    @ObservedObject var viewModel: VoiceViewModel

    public var body: some View {
        VStack(spacing: 0) {
            // Main Top Notch Bar
            HStack(spacing: 12) {
                // Left Wing: Reactive & Dynamic Soundwave
                SoundwaveWing(
                    level: viewModel.audioLevel,
                    state: viewModel.state,
                    isLeft: true
                )
                .frame(width: 48, height: 26)

                // Center Notch Body & Interactive Status
                HStack(spacing: 8) {
                    NotchCenterBadge(
                        state: viewModel.state,
                        audioLevel: viewModel.audioLevel,
                        statusMessage: viewModel.statusMessage,
                        isVoiceNotRecognized: viewModel.isVoiceNotRecognized,
                        onTouchIdUnlock: viewModel.onTouchIdUnlock
                    )
                }
                .padding(.horizontal, 12)
                .frame(minWidth: 150)

                // Right Wing: Reactive & Dynamic Soundwave
                SoundwaveWing(
                    level: viewModel.audioLevel,
                    state: viewModel.state,
                    isLeft: false
                )
                .frame(width: 48, height: 26)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(
                Capsule()
                    .fill(Color.black.opacity(0.92))
                    .overlay(
                        Capsule()
                            .fill(Material.ultraThinMaterial)
                            .opacity(0.3)
                    )
                    .overlay(
                        NotchGlowBorder(state: viewModel.state, level: viewModel.audioLevel)
                    )
                    .overlay(
                        Capsule()
                            .stroke(Color.white.opacity(0.18), lineWidth: 0.8)
                    )
            )
            .shadow(color: auraShadowColor, radius: auraRadius, x: 0, y: auraOffsetY)
            .animation(.spring(response: 0.35, dampingFraction: 0.72), value: viewModel.state)

            // Dropdown Conversation History
            if !viewModel.turns.isEmpty {
                HistoryPanelView(viewModel: viewModel)
                    .frame(width: 430)
                    .padding(.top, 10)
                    .transition(
                        .asymmetric(
                            insertion: .scale(scale: 0.94, anchor: .top).combined(with: .opacity).combined(with: .move(edge: .top)),
                            removal: .scale(scale: 0.96, anchor: .top).combined(with: .opacity)
                        )
                    )
            }
        }
        .padding(.top, 4)
    }

    private var auraShadowColor: Color {
        if viewModel.isVoiceNotRecognized {
            return Color.red.opacity(0.65)
        }
        switch viewModel.state {
        case .listening:
            return Color.cyan.opacity(0.55 + Double(viewModel.audioLevel) * 0.35)
        case .thinking:
            return Color.orange.opacity(0.65)
        case .speaking:
            return Color(red: 0.2, green: 0.85, blue: 0.55).opacity(0.6)
        case .idle:
            return Color.clear
        }
    }

    private var auraRadius: CGFloat {
        if viewModel.isVoiceNotRecognized {
            return 18
        }
        switch viewModel.state {
        case .listening:
            return CGFloat(14 + viewModel.audioLevel * 14)
        case .thinking:
            return 18
        case .speaking:
            return 16
        case .idle:
            return 0
        }
    }

    private var auraOffsetY: CGFloat {
        (viewModel.state == .idle && !viewModel.isVoiceNotRecognized) ? 0 : 5
    }
}

// Center Notch Interactive Badge
struct NotchCenterBadge: View {
    let state: VoiceState
    let audioLevel: Float
    let statusMessage: String
    var isVoiceNotRecognized: Bool = false
    var onTouchIdUnlock: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 8) {
            if isVoiceNotRecognized {
                Button(action: {
                    onTouchIdUnlock?()
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "lock.fill")
                            .foregroundColor(.yellow)
                            .font(.system(size: 11))
                        Text("Voice not recognized")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .foregroundColor(.white)
                        HStack(spacing: 3) {
                            Image(systemName: "touchid")
                                .font(.system(size: 10, weight: .bold))
                            Text("Unlock")
                                .font(.system(size: 10, weight: .bold, design: .rounded))
                        }
                        .foregroundColor(.cyan)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.white.opacity(0.18)))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(
                        Capsule()
                            .fill(Color.red.opacity(0.4))
                            .overlay(Capsule().stroke(Color.red.opacity(0.8), lineWidth: 1))
                    )
                }
                .buttonStyle(PlainButtonStyle())
            } else {
                switch state {
                case .listening:
                    PulsingCircle(color: .cyan, level: audioLevel)
                    Text("Listening...")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundColor(.white)
                        .shadow(color: .cyan.opacity(0.6), radius: 6)

                case .thinking:
                    ThinkingOrb()
                    if isToolExecuting {
                        HStack(spacing: 5) {
                            toolIcon
                                .font(.system(size: 11, weight: .bold))
                                .foregroundColor(.orange)
                            Text(cleanedToolName)
                                .font(.system(size: 12, weight: .semibold, design: .rounded))
                                .foregroundColor(.white.opacity(0.95))
                        }
                    } else {
                        Text("Thinking...")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundColor(.white.opacity(0.95))
                    }

                case .speaking:
                    SpeakingEqualizerOrb()
                    Text("Speaking...")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundColor(.white)
                        .shadow(color: Color.green.opacity(0.6), radius: 6)

                case .idle:
                    Circle()
                        .fill(Color.white.opacity(0.35))
                        .frame(width: 6, height: 6)
                    Text("MinClaw")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundColor(.white.opacity(0.7))
                }
            }
        }
    }

    private var isToolExecuting: Bool {
        statusMessage.lowercased().hasPrefix("running tool:") || statusMessage.lowercased().hasPrefix("tool:")
    }

    private var cleanedToolName: String {
        var str = statusMessage
        if let range = str.range(of: "Running tool:", options: .caseInsensitive) {
            str.removeSubrange(range)
        } else if let range = str.range(of: "Tool:", options: .caseInsensitive) {
            str.removeSubrange(range)
        }
        return str.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var toolIcon: some View {
        let name = cleanedToolName.lowercased()
        let sysName: String
        if name.contains("web") || name.contains("search") {
            sysName = "globe.americas.fill"
        } else if name.contains("shell") || name.contains("bash") {
            sysName = "terminal.fill"
        } else if name.contains("calendar") {
            sysName = "calendar"
        } else if name.contains("email") || name.contains("mail") {
            sysName = "envelope.fill"
        } else if name.contains("memory") || name.contains("remember") {
            sysName = "brain.head.profile"
        } else {
            sysName = "gearshape.2.fill"
        }
        return Image(systemName: sysName)
    }
}

// Glowing Siri/Apple-Intelligence Rotating Gradient Border
struct NotchGlowBorder: View {
    let state: VoiceState
    let level: Float

    @ViewBuilder
    var body: some View {
        if state == .idle {
            Capsule()
                .stroke(Color.clear, lineWidth: 0.5)
        } else {
            TimelineView(.animation) { timeline in
                let time = timeline.date.timeIntervalSinceReferenceDate
                let angle = Angle.degrees(time * (state == .listening ? 90 : 60))

                Capsule()
                    .stroke(
                        AngularGradient(
                            gradient: gradientForState,
                            center: .center,
                            angle: angle
                        ),
                        lineWidth: strokeWidth
                    )
                    .blur(radius: 2.5)
                    .opacity(0.85)
            }
        }
    }

    private var strokeWidth: CGFloat {
        switch state {
        case .listening: return CGFloat(1.8 + level * 2.0)
        case .thinking: return 2.0
        case .speaking: return 2.0
        case .idle: return 0.5
        }
    }

    private var gradientForState: Gradient {
        switch state {
        case .listening:
            return Gradient(colors: [
                Color.cyan,
                Color.blue,
                Color.purple,
                Color.cyan.opacity(0.8),
                Color.cyan
            ])
        case .thinking:
            return Gradient(colors: [
                Color.orange,
                Color(red: 1.0, green: 0.3, blue: 0.6),
                Color.purple,
                Color.orange.opacity(0.8),
                Color.orange
            ])
        case .speaking:
            return Gradient(colors: [
                Color(red: 0.2, green: 0.9, blue: 0.6),
                Color.cyan,
                Color.teal,
                Color(red: 0.2, green: 0.9, blue: 0.6).opacity(0.8),
                Color(red: 0.2, green: 0.9, blue: 0.6)
            ])
        case .idle:
            return Gradient(colors: [Color.clear])
        }
    }
}

// Dynamic Multi-Bar Soundwave Wing with Alive Rhythmic Animations
public struct SoundwaveWing: View {
    let level: Float
    let state: VoiceState
    let isLeft: Bool

    @ViewBuilder
    public var body: some View {
        if state == .idle {
            HStack(spacing: 3) {
                ForEach(0..<4) { index in
                    let i = isLeft ? (3 - index) : index
                    let factor = [0.4, 0.7, 1.0, 0.65][i]
                    let barH = CGFloat(3.0 + 3.0 * factor)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(LinearGradient(
                            colors: [Color.white.opacity(0.25), Color.white.opacity(0.12)],
                            startPoint: .top,
                            endPoint: .bottom
                        ))
                        .frame(width: 3, height: barH)
                }
            }
        } else {
            TimelineView(.animation) { timeline in
                let time = timeline.date.timeIntervalSinceReferenceDate
                HStack(spacing: 3) {
                    ForEach(0..<4) { index in
                        let barH = calculateHeight(index: index, time: time)
                        RoundedRectangle(cornerRadius: 2)
                            .fill(barGradient(index: index))
                            .frame(width: 3, height: barH)
                            .shadow(color: barGlowColor, radius: 3)
                    }
                }
            }
        }
    }

    private func calculateHeight(index: Int, time: Double) -> CGFloat {
        let i = isLeft ? (3 - index) : index
        let factor = [0.4, 0.7, 1.0, 0.65][i]

        switch state {
        case .listening:
            let micBoost = CGFloat(level * Float(factor) * 22.0)
            return min(24.0, max(4.0, micBoost))

        case .thinking:
            // Fluid undulating sine wave
            let wave = sin(time * 4.5 + Double(i) * 0.9)
            let waveH = CGFloat(6.0 + 8.0 * (wave + 1.0) / 2.0 * factor)
            return min(20.0, max(4.0, waveH))

        case .speaking:
            // Multi-frequency dancing equalizer
            let wave1 = sin(time * 6.5 + Double(i) * 1.3)
            let wave2 = cos(time * 9.0 + Double(i) * 0.7)
            let combined = (wave1 + wave2 + 2.0) / 4.0
            let speakH = CGFloat(5.0 + 15.0 * combined * factor)
            return min(24.0, max(4.0, speakH))

        case .idle:
            return 4.0
        }
    }

    private func barGradient(index: Int) -> LinearGradient {
        switch state {
        case .listening:
            return LinearGradient(
                colors: [Color.cyan, Color(red: 0.2, green: 0.45, blue: 1.0)],
                startPoint: .top,
                endPoint: .bottom
            )
        case .thinking:
            return LinearGradient(
                colors: [Color.orange, Color(red: 0.95, green: 0.25, blue: 0.65)],
                startPoint: .top,
                endPoint: .bottom
            )
        case .speaking:
            return LinearGradient(
                colors: [Color(red: 0.25, green: 0.95, blue: 0.65), Color.cyan],
                startPoint: .top,
                endPoint: .bottom
            )
        case .idle:
            return LinearGradient(
                colors: [Color.white.opacity(0.3), Color.white.opacity(0.15)],
                startPoint: .top,
                endPoint: .bottom
            )
        }
    }

    private var barGlowColor: Color {
        switch state {
        case .listening: return Color.cyan.opacity(0.5)
        case .thinking: return Color.orange.opacity(0.5)
        case .speaking: return Color.green.opacity(0.5)
        case .idle: return Color.clear
        }
    }
}

// Concentric Pulsing Microphone Core
struct PulsingCircle: View {
    let color: Color
    let level: Float

    var body: some View {
        ZStack {
            Circle()
                .stroke(color.opacity(0.4), lineWidth: 1.5)
                .frame(width: CGFloat(10 + level * 14), height: CGFloat(10 + level * 14))
                .animation(.easeOut(duration: 0.1), value: level)

            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
                .shadow(color: color, radius: 6)
        }
        .frame(width: 16, height: 16)
    }
}

// Thinking Breathing Orb with Ripple Waves
struct ThinkingOrb: View {
    var body: some View {
        TimelineView(.animation) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            let pulse = (sin(time * 3.5) + 1.0) / 2.0 // 0.0 to 1.0
            let scale = CGFloat(1.0 + pulse * 0.35)

            ZStack {
                Circle()
                    .stroke(Color.orange.opacity(Double(0.5 - pulse * 0.4)), lineWidth: 1.5)
                    .scaleEffect(scale * 1.3)

                Circle()
                    .fill(
                        RadialGradient(
                            colors: [Color.orange, Color(red: 0.95, green: 0.3, blue: 0.5)],
                            center: .center,
                            startRadius: 1,
                            endRadius: 6
                        )
                    )
                    .frame(width: 8, height: 8)
                    .shadow(color: Color.orange.opacity(0.8), radius: 6)
            }
            .frame(width: 16, height: 16)
        }
    }
}

// Speaking Equalizer Orb
struct SpeakingEqualizerOrb: View {
    var body: some View {
        TimelineView(.animation) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            let pulse = CGFloat((sin(time * 5.0) + 1.0) / 2.0)

            ZStack {
                Circle()
                    .stroke(Color.green.opacity(0.4), lineWidth: 1.2)
                    .scaleEffect(CGFloat(1.1 + pulse * 0.4))

                Image(systemName: "waveform")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(Color(red: 0.25, green: 0.95, blue: 0.65))
                    .shadow(color: Color.green.opacity(0.7), radius: 5)
            }
            .frame(width: 16, height: 16)
        }
    }
}
