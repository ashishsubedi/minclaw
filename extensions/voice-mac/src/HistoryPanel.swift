import SwiftUI

public struct HistoryPanelView: View {
    @ObservedObject var viewModel: VoiceViewModel

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header bar
            HStack {
                HStack(spacing: 6) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                    Text("MinClaw Voice")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundColor(.white.opacity(0.9))
                }

                Spacer()

                if !viewModel.statusMessage.isEmpty {
                    Text(viewModel.statusMessage)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.white.opacity(0.6))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.white.opacity(0.1)))
                }

                Button(action: {
                    viewModel.dismiss()
                }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.white.opacity(0.5))
                        .padding(4)
                }
                .buttonStyle(PlainButtonStyle())
            }
            .padding(.bottom, 2)

            // Conversation history list
            if viewModel.turns.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 20))
                        .foregroundColor(.cyan.opacity(0.8))
                    Text("Hold Right-Option to speak")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.white.opacity(0.7))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
            } else {
                ScrollView(showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(viewModel.turns) { turn in
                            if turn.role == "user" {
                                UserBubble(text: turn.text)
                            } else {
                                AssistantBubble(text: turn.text)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
                .frame(maxHeight: 280)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(Color(nsColor: .windowBackgroundColor).opacity(0.85))
                .background(
                    RoundedRectangle(cornerRadius: 16)
                        .fill(Material.ultraThinMaterial)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(Color.white.opacity(0.15), lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.35), radius: 20, x: 0, y: 10)
        )
        .onHover { isHovered in
            if isHovered {
                viewModel.stopAutoHideTimer()
            } else if viewModel.state == .idle {
                viewModel.startAutoHideTimer(after: 10.0)
            }
        }
    }

    private var statusColor: Color {
        switch viewModel.state {
        case .listening: return .cyan
        case .thinking: return .orange
        case .speaking: return .green
        case .idle: return .gray.opacity(0.5)
        }
    }
}

struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer()
            Text(text)
                .font(.system(size: 13, weight: .regular))
                .foregroundColor(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 14)
                        .fill(
                            LinearGradient(
                                colors: [Color.cyan.opacity(0.4), Color.blue.opacity(0.4)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(Color.cyan.opacity(0.3), lineWidth: 1)
                        )
                )
        }
    }
}

struct AssistantBubble: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 12))
                .foregroundColor(.purple)
                .padding(.top, 4)

            Text(text)
                .font(.system(size: 13, weight: .regular))
                .foregroundColor(.white.opacity(0.95))
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 14)
                        .fill(Color.white.opacity(0.08))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(Color.white.opacity(0.1), lineWidth: 1)
                        )
                )

            Spacer()
        }
    }
}
