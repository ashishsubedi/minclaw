import SwiftUI

public struct MarkdownTextView: View {
    let text: String

    public init(text: String) {
        self.text = text
    }

    public var body: some View {
        Text(parsedAttributedString)
            .lineSpacing(3)
    }

    private var parsedAttributedString: AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        if let attr = try? AttributedString(markdown: text, options: options) {
            return attr
        }
        return AttributedString(text)
    }
}

public struct HistoryPanelView: View {
    @ObservedObject var viewModel: VoiceViewModel

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header bar
            HStack {
                HStack(spacing: 7) {
                    PulsingStatusOrb(state: viewModel.state)
                    Text("MinClaw Voice")
                        .font(.system(size: 12, weight: .bold, design: .rounded))
                        .foregroundColor(.white.opacity(0.95))
                }

                Spacer()

                // Dynamic Status / Tool Activity Badge
                if !viewModel.statusMessage.isEmpty {
                    StatusActivityBadge(statusMessage: viewModel.statusMessage, state: viewModel.state)
                        .transition(.scale.combined(with: .opacity))
                }

                // Interactive Reset Session Button
                if !viewModel.turns.isEmpty {
                    ResetSessionButton {
                        viewModel.onResetSession?()
                    }
                    .transition(.scale.combined(with: .opacity))
                }

                // Interactive Close Button
                CloseHUDButton {
                    viewModel.dismiss(force: true)
                }
            }
            .padding(.bottom, 2)

            // Conversation history list
            if viewModel.turns.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 22))
                        .foregroundColor(.cyan.opacity(0.85))
                        .shadow(color: .cyan.opacity(0.5), radius: 8)
                    Text("Hold Right-Option to speak")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundColor(.white.opacity(0.75))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 18)
            } else {
                ScrollViewReader { proxy in
                    ScrollView(showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 12) {
                            ForEach(Array(viewModel.turns.enumerated()), id: \.element.id) { index, turn in
                                if turn.role == "user" {
                                    UserBubble(text: turn.text)
                                        .id(turn.id)
                                        .transition(.asymmetric(
                                            insertion: .scale(scale: 0.95).combined(with: .opacity).combined(with: .move(edge: .bottom)),
                                            removal: .opacity
                                        ))
                                } else {
                                    AssistantBubble(text: turn.text)
                                        .id(turn.id)
                                        .transition(.asymmetric(
                                            insertion: .scale(scale: 0.95).combined(with: .opacity).combined(with: .move(edge: .bottom)),
                                            removal: .opacity
                                        ))
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .frame(maxHeight: 280)
                    .onChange(of: viewModel.turns.count) {
                        if let lastId = viewModel.turns.last?.id {
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                                proxy.scrollTo(lastId, anchor: .bottom)
                            }
                        }
                    }
                }
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18)
                .fill(Color(nsColor: .windowBackgroundColor).opacity(0.88))
                .background(
                    RoundedRectangle(cornerRadius: 18)
                        .fill(Material.ultraThinMaterial)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18)
                        .stroke(panelBorderGradient, lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.45), radius: 24, x: 0, y: 12)
        )
        .onHover { isHovered in
            if isHovered {
                viewModel.stopAutoHideTimer()
            } else if viewModel.state == .idle {
                viewModel.startAutoHideTimer(after: 15.0)
            }
        }
        .onExitCommand {
            viewModel.dismiss(force: true)
        }
    }

    private var panelBorderGradient: LinearGradient {
        LinearGradient(
            colors: [
                Color.white.opacity(0.28),
                Color.white.opacity(0.08),
                Color.white.opacity(0.04)
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

// Concentric Breathing Status Orb
struct PulsingStatusOrb: View {
    let state: VoiceState

    @ViewBuilder
    var body: some View {
        if state == .idle {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
                .shadow(color: statusColor.opacity(0.2), radius: 2)
                .frame(width: 14, height: 14)
        } else {
            TimelineView(.animation) { timeline in
                let time = timeline.date.timeIntervalSinceReferenceDate
                let pulse = CGFloat((sin(time * 3.0) + 1.0) / 2.0)
                let color = statusColor

                ZStack {
                    Circle()
                        .stroke(color.opacity(Double(0.45 - pulse * 0.35)), lineWidth: 1.5)
                        .scaleEffect(CGFloat(1.0 + pulse * 0.6))

                    Circle()
                        .fill(color)
                        .frame(width: 8, height: 8)
                        .shadow(color: color.opacity(0.8), radius: 6)
                }
                .frame(width: 14, height: 14)
            }
        }
    }

    private var statusColor: Color {
        switch state {
        case .listening: return .cyan
        case .thinking: return .orange
        case .speaking: return Color(red: 0.25, green: 0.95, blue: 0.6)
        case .idle: return .gray.opacity(0.55)
        }
    }
}

// Dynamic Tool & Status Activity Badge
struct StatusActivityBadge: View {
    let statusMessage: String
    let state: VoiceState

    var body: some View {
        HStack(spacing: 5) {
            toolGlyph
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(badgeTint)

            Text(statusMessage)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundColor(.white.opacity(0.9))
                .lineLimit(1)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 3.5)
        .background(
            Capsule()
                .fill(Color.white.opacity(0.1))
                .overlay(
                    Capsule()
                        .stroke(badgeTint.opacity(0.4), lineWidth: 1)
                )
        )
        .shadow(color: badgeTint.opacity(0.25), radius: 6)
    }

    private var badgeTint: Color {
        switch state {
        case .listening: return .cyan
        case .thinking: return .orange
        case .speaking: return Color.green
        case .idle: return .white.opacity(0.5)
        }
    }

    private var toolGlyph: some View {
        let lower = statusMessage.lowercased()
        let iconName: String
        if lower.contains("web") || lower.contains("search") {
            iconName = "globe.americas.fill"
        } else if lower.contains("shell") || lower.contains("command") {
            iconName = "terminal.fill"
        } else if lower.contains("calendar") {
            iconName = "calendar.badge.clock"
        } else if lower.contains("email") || lower.contains("mail") {
            iconName = "envelope.fill"
        } else if lower.contains("memory") || lower.contains("remember") {
            iconName = "brain.head.profile"
        } else if lower.contains("transcrib") {
            iconName = "waveform.badge.mic"
        } else {
            iconName = "gearshape.2.fill"
        }
        return Image(systemName: iconName)
    }
}

// Reset Button with sleek frosted pill design and hover animation
struct ResetSessionButton: View {
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: "arrow.counterclockwise")
                    .font(.system(size: 9, weight: .bold))
                Text("New")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
            }
            .foregroundColor(isHovered ? .white : .white.opacity(0.75))
            .padding(.horizontal, 7)
            .padding(.vertical, 3.5)
            .background(
                Capsule()
                    .fill(isHovered ? Color.white.opacity(0.2) : Color.white.opacity(0.1))
                    .overlay(
                        Capsule()
                            .stroke(isHovered ? Color.white.opacity(0.35) : Color.white.opacity(0.15), lineWidth: 1)
                    )
            )
            .scaleEffect(isHovered ? 1.05 : 1.0)
            .animation(.spring(response: 0.2, dampingFraction: 0.6), value: isHovered)
        }
        .buttonStyle(PlainButtonStyle())
        .onHover { isHovered = $0 }
    }
}

// Close Button with Micro Spring Hover Animation
struct CloseHUDButton: View {
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(isHovered ? .white : .white.opacity(0.6))
                .padding(5)
                .background(
                    Circle()
                        .fill(isHovered ? Color.red.opacity(0.55) : Color.white.opacity(0.1))
                )
                .scaleEffect(isHovered ? 1.12 : 1.0)
                .animation(.spring(response: 0.2, dampingFraction: 0.6), value: isHovered)
        }
        .buttonStyle(PlainButtonStyle())
        .onHover { isHovered = $0 }
    }
}

// User Bubble with Modern Siri/iMessage Dynamic Gradient
struct UserBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 40)
            MarkdownTextView(text: text)
                .font(.system(size: 13, weight: .regular))
                .foregroundColor(.white)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 15)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color(red: 0.06, green: 0.52, blue: 0.98),
                                    Color(red: 0.20, green: 0.38, blue: 0.95)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 15)
                                .stroke(Color.white.opacity(0.28), lineWidth: 1)
                        )
                )
                .shadow(color: Color.blue.opacity(0.35), radius: 8, x: 0, y: 3)
        }
    }
}

// Assistant Bubble with Frosted Obsidian & Twinkling Sparkles
struct AssistantBubble: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            TwinklingSparkle()
                .padding(.top, 4)

            MarkdownTextView(text: text)
                .font(.system(size: 13, weight: .regular))
                .foregroundColor(.white.opacity(0.96))
                .textSelection(.enabled)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 15)
                        .fill(Color.white.opacity(0.08))
                        .overlay(
                            RoundedRectangle(cornerRadius: 15)
                                .stroke(
                                    LinearGradient(
                                        colors: [Color.purple.opacity(0.35), Color.white.opacity(0.1)],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    ),
                                    lineWidth: 1
                                )
                        )
                )
                .shadow(color: Color.black.opacity(0.25), radius: 6, x: 0, y: 2)

            Spacer(minLength: 30)
        }
    }
}

// Twinkling Iridescent Sparkle Icon
struct TwinklingSparkle: View {
    var body: some View {
        Image(systemName: "sparkles")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(
                LinearGradient(
                    colors: [
                        Color(red: 0.85, green: 0.45, blue: 1.0),
                        Color(red: 0.45, green: 0.75, blue: 1.0)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .shadow(color: Color.purple.opacity(0.5), radius: 4)
    }
}
