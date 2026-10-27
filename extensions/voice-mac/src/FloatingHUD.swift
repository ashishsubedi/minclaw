import SwiftUI

public struct FloatingHUDView: View {
    @ObservedObject var viewModel: VoiceViewModel

    public var body: some View {
        VStack(spacing: 12) {
            // Expandable Conversation History (appears above the bottom pill)
            if !viewModel.turns.isEmpty {
                HistoryPanelView(viewModel: viewModel)
                    .frame(width: 430)
                    .transition(
                        .asymmetric(
                            insertion: .scale(scale: 0.94, anchor: .bottom).combined(with: .opacity).combined(with: .move(edge: .bottom)),
                            removal: .scale(scale: 0.96, anchor: .bottom).combined(with: .opacity)
                        )
                    )
            }

            // Bottom Flow Dynamic Island Capsule
            HStack(spacing: 12) {
                // Waveform Wing
                SoundwaveWing(
                    level: viewModel.audioLevel,
                    state: viewModel.state,
                    isLeft: true
                )
                .frame(width: 44, height: 24)

                // Center Notch Body & Status
                NotchCenterBadge(
                    state: viewModel.state,
                    audioLevel: viewModel.audioLevel,
                    statusMessage: viewModel.statusMessage,
                    isVoiceNotRecognized: viewModel.isVoiceNotRecognized,
                    onTouchIdUnlock: viewModel.onTouchIdUnlock
                )
                .frame(minWidth: 140)

                // Waveform Wing
                SoundwaveWing(
                    level: viewModel.audioLevel,
                    state: viewModel.state,
                    isLeft: false
                )
                .frame(width: 44, height: 24)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
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
                            .stroke(Color.white.opacity(0.2), lineWidth: 0.8)
                    )
            )
            .shadow(color: auraShadowColor, radius: 18, x: 0, y: 8)
            .animation(.spring(response: 0.35, dampingFraction: 0.72), value: viewModel.state)
        }
        .padding(.bottom, 24)
    }

    private var auraShadowColor: Color {
        if viewModel.isVoiceNotRecognized {
            return Color.red.opacity(0.65)
        }
        switch viewModel.state {
        case .listening:
            return Color.cyan.opacity(0.55 + Double(viewModel.audioLevel) * 0.3)
        case .thinking:
            return Color.orange.opacity(0.65)
        case .speaking:
            return Color(red: 0.2, green: 0.85, blue: 0.55).opacity(0.6)
        case .idle:
            return Color.black.opacity(0.3)
        }
    }
}
