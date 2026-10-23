import SwiftUI

public struct NotchHUDView: View {
    @ObservedObject var viewModel: VoiceViewModel

    public var body: some View {
        VStack(spacing: 0) {
            // Top Notch Bar
            HStack(spacing: 12) {
                // Left Wing: Reactive soundwave
                SoundwaveWing(level: viewModel.audioLevel, isLeft: true)
                    .frame(width: 44, height: 24)

                // Center Notch Body & Status
                HStack(spacing: 8) {
                    if viewModel.state == .listening {
                        Circle()
                            .fill(Color.cyan)
                            .frame(width: 8, height: 8)
                            .scaleEffect(1.0 + CGFloat(viewModel.audioLevel) * 0.5)
                        Text("Listening...")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundColor(.white)
                    } else if viewModel.state == .thinking {
                        Circle()
                            .fill(Color.orange)
                            .frame(width: 8, height: 8)
                        Text("Thinking...")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundColor(.white.opacity(0.9))
                    } else if viewModel.state == .speaking {
                        Image(systemName: "waveform")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(.green)
                        Text("Speaking...")
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundColor(.white)
                    } else {
                        Circle()
                            .fill(Color.white.opacity(0.3))
                            .frame(width: 6, height: 6)
                        Text("MinClaw")
                            .font(.system(size: 12, weight: .medium, design: .rounded))
                            .foregroundColor(.white.opacity(0.7))
                    }
                }
                .padding(.horizontal, 10)
                .frame(minWidth: 140)

                // Right Wing: Reactive soundwave
                SoundwaveWing(level: viewModel.audioLevel, isLeft: false)
                    .frame(width: 44, height: 24)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(
                Capsule()
                    .fill(Color.black.opacity(0.92))
                    .overlay(
                        Capsule()
                            .stroke(glowGradient, lineWidth: glowLineWidth)
                            .blur(radius: glowBlurRadius)
                    )
                    .overlay(
                        Capsule()
                            .stroke(Color.white.opacity(0.2), lineWidth: 1)
                    )
            )
            .shadow(color: glowColor.opacity(Double(glowOpacity)), radius: 12, x: 0, y: 4)

            // Dropdown Conversation History
            if !viewModel.turns.isEmpty {
                HistoryPanelView(viewModel: viewModel)
                    .frame(width: 420)
                    .padding(.top, 10)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.top, 4)
    }

    private var glowColor: Color {
        switch viewModel.state {
        case .listening: return .cyan
        case .thinking: return .orange
        case .speaking: return .purple
        case .idle: return .clear
        }
    }

    private var glowOpacity: Float {
        switch viewModel.state {
        case .listening: return 0.5 + viewModel.audioLevel * 0.5
        case .thinking: return 0.6
        case .speaking: return 0.7
        case .idle: return 0.0
        }
    }

    private var glowLineWidth: CGFloat {
        viewModel.state == .listening ? CGFloat(2.0 + viewModel.audioLevel * 2.0) : 1.5
    }

    private var glowBlurRadius: CGFloat {
        viewModel.state == .listening ? CGFloat(4.0 + viewModel.audioLevel * 4.0) : 2.0
    }

    private var glowGradient: LinearGradient {
        LinearGradient(
            colors: [glowColor.opacity(Double(glowOpacity)), glowColor.opacity(0.3)],
            startPoint: .leading,
            endPoint: .trailing
        )
    }
}

struct SoundwaveWing: View {
    let level: Float
    let isLeft: Bool

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<4) { index in
                let factor = barFactor(for: index)
                RoundedRectangle(cornerRadius: 2)
                    .fill(
                        LinearGradient(
                            colors: [Color.cyan.opacity(0.8), Color.purple.opacity(0.8)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(width: 3, height: max(4, CGFloat(level * factor * 22)))
                    .animation(.spring(response: 0.15, dampingFraction: 0.5), value: level)
            }
        }
    }

    private func barFactor(for index: Int) -> Float {
        let i = isLeft ? (3 - index) : index
        switch i {
        case 0: return 0.4
        case 1: return 0.7
        case 2: return 1.0
        case 3: return 0.6
        default: return 0.5
        }
    }
}
