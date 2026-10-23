import SwiftUI

public struct FloatingHUDView: View {
    @ObservedObject var viewModel: VoiceViewModel

    public var body: some View {
        VStack(spacing: 12) {
            // Expandable Conversation History (appears above the bottom pill)
            if !viewModel.turns.isEmpty {
                HistoryPanelView(viewModel: viewModel)
                    .frame(width: 420)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Bottom Flow Pill
            HStack(spacing: 10) {
                // Waveform indicator
                HStack(spacing: 3) {
                    ForEach(0..<5) { idx in
                        let factor = Float(idx == 2 ? 1.0 : (idx == 1 || idx == 3 ? 0.7 : 0.4))
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.cyan)
                            .frame(width: 3, height: max(4, CGFloat(viewModel.audioLevel * factor * 20)))
                            .animation(.spring(response: 0.15, dampingFraction: 0.5), value: viewModel.audioLevel)
                    }
                }
                .frame(width: 30)

                // Status text
                Text(pillText)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundColor(.white)

                // State Icon
                pillIcon
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(pillColor)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(
                Capsule()
                    .fill(Color.black.opacity(0.88))
                    .overlay(
                        Capsule()
                            .stroke(pillColor.opacity(0.4), lineWidth: 1.5)
                    )
            )
            .shadow(color: pillColor.opacity(0.3), radius: 14, x: 0, y: 6)
        }
        .padding(.bottom, 24)
    }

    private var pillText: String {
        switch viewModel.state {
        case .listening: return "Listening..."
        case .thinking: return "Thinking..."
        case .speaking: return "Speaking..."
        case .idle: return "MinClaw Voice"
        }
    }

    private var pillColor: Color {
        switch viewModel.state {
        case .listening: return .cyan
        case .thinking: return .orange
        case .speaking: return .green
        case .idle: return .gray.opacity(0.5)
        }
    }

    private var pillIcon: some View {
        Group {
            switch viewModel.state {
            case .listening:
                Image(systemName: "mic.fill")
            case .thinking:
                Image(systemName: "ellipsis")
            case .speaking:
                Image(systemName: "speaker.wave.2.fill")
            case .idle:
                Image(systemName: "circle.fill")
            }
        }
    }
}
