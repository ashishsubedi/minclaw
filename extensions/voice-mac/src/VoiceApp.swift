import Foundation
import AppKit
import SwiftUI
import Combine

public class VoicePanel: NSPanel {
    public var onEscape: (() -> Void)?

    public override var canBecomeKey: Bool {
        return true
    }

    public override var canBecomeMain: Bool {
        return true
    }

    public override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { // ESC key
            onEscape?()
            return
        }
        super.keyDown(with: event)
    }

    public override func cancelOperation(_ sender: Any?) {
        onEscape?()
    }
}

public class VoiceApp: NSObject, NSApplicationDelegate {
    private var window: VoicePanel!
    private var viewModel: VoiceViewModel!
    private var hotkeyListener: HotkeyListener!
    private var audioRecorder: AudioRecorder!
    private var transcriber: Transcriber!
    private var daemonClient: DaemonClient!
    private var kokoroClient: KokoroClient!
    private let tempAudioURL = URL(fileURLWithPath: "/tmp/minclaw_voice_input.wav")

    private var localKeyMonitor: Any?
    private var globalKeyMonitor: Any?

    private var mode: UIMode = .notch
    private var hotkeyType: HotkeyType = .rightOption

    public init(mode: UIMode = .notch, hotkey: HotkeyType = .rightOption) {
        self.mode = mode
        self.hotkeyType = hotkey
        super.init()
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        viewModel = VoiceViewModel(uiMode: mode)
        audioRecorder = AudioRecorder()
        transcriber = Transcriber()
        daemonClient = DaemonClient()
        kokoroClient = KokoroClient()
        hotkeyListener = HotkeyListener(targetKey: hotkeyType)

        setupWindow()
        setupEventHandlers()

        // Connect to daemon
        _ = daemonClient.connect()

        // Pre-warm / ensure Kokoro server is ready in background
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.kokoroClient.ensureServerRunning()
        }

        // Pre-warm STT
        transcriber.prewarm()

        // Start listening for hotkey
        hotkeyListener.start()

        print("[voice:app] 🎙️ MinClaw Voice Extension started.")
        print("[voice:app] Mode: '\(mode.rawValue)', Hotkey: '\(hotkeyType.rawValue)'.")
    }

    private func setupWindow() {
        let screen = NSScreen.main ?? NSScreen.screens.first!
        let screenFrame = screen.frame
        let windowWidth: CGFloat = 460
        let windowHeight: CGFloat = 380

        let posX = (screenFrame.width - windowWidth) / 2
        let posY = mode == .notch ? (screenFrame.height - windowHeight) : 20

        let contentRect = NSRect(x: posX, y: posY, width: windowWidth, height: windowHeight)

        window = VoicePanel(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = false

        window.onEscape = { [weak self] in
            self?.dismissAndStop()
        }

        let rootView = Group {
            if mode == .notch {
                NotchHUDView(viewModel: viewModel)
            } else {
                FloatingHUDView(viewModel: viewModel)
            }
        }
        .frame(width: windowWidth, height: windowHeight, alignment: mode == .notch ? .top : .bottom)

        window.contentView = NSHostingView(rootView: rootView)

        // Pre-render frame to prevent initial UI stutter
        window.alphaValue = 0.0
        window.orderFront(nil)
        window.orderOut(nil)
        window.alphaValue = 1.0
    }

    public func dismissAndStop() {
        print("[voice:app] 🛑 Dismissing UI and halting speech playback")
        kokoroClient.stopPlayback()
        viewModel.dismiss(force: true)
    }

    public func resetVoiceSession() {
        print("[voice:app] 🔄 Resetting voice session")
        kokoroClient.stopPlayback()
        viewModel.clearSessionHistory()
        _ = daemonClient.sendResetCommand(sessionId: "voice:macbook")
    }

    private func isIntermediateStatusMessage(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        if lower.hasPrefix("running tool:") ||
           lower.hasPrefix("running confirmed command:") ||
           lower.hasPrefix("tool:") ||
           lower.hasPrefix("working...") ||
           lower.hasPrefix("thinking...") ||
           lower.hasPrefix("calling model:") ||
           lower.hasPrefix("_tool calls:_") ||
           lower.hasPrefix("**tool calls**") {
            return true
        }
        return false
    }

    private func setupEventHandlers() {
        // Audio level updates
        audioRecorder.onLevelUpdate = { [weak self] level in
            DispatchQueue.main.async {
                self?.viewModel.audioLevel = level
            }
        }

        // Push-to-talk press
        hotkeyListener.onPress = { [weak self] in
            guard let self = self else { return }
            print("[voice:app] Key pressed -> Start recording")

            // Play earcon (Tink)
            NSSound(named: "Tink")?.play()

            // Interrupt any active speech (barge-in)
            self.kokoroClient.stopPlayback()

            // Pre-warm Kokoro model in case it was idle
            self.kokoroClient.ensureServerRunning()

            // Show window
            self.window.orderFrontRegardless()
            self.viewModel.setListening()

            // Start recording audio
            _ = self.audioRecorder.startRecording(to: self.tempAudioURL)
        }

        // Push-to-talk release
        hotkeyListener.onRelease = { [weak self] in
            guard let self = self else { return }
            print("[voice:app] Key released -> Stop recording & Transcribe")

            // Play earcon (Pop)
            NSSound(named: "Pop")?.play()

            self.audioRecorder.stopRecording()
            self.viewModel.setTranscribing()

            // Run transcription in background
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self = self else { return }
                let transcription = self.transcriber.transcribe(audioFileURL: self.tempAudioURL)

                DispatchQueue.main.async {
                    let hasAlphanumeric = transcription?.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) ?? false
                    if let prompt = transcription, !prompt.isEmpty, hasAlphanumeric {
                        print("[voice:app] 🗣️ User said: \"\(prompt)\"")
                        self.viewModel.setThinking(prompt: prompt)

                        // Send message to MinClaw daemon
                        let sent = self.daemonClient.sendChatMessage(sessionId: "voice:macbook", text: prompt)
                        if !sent {
                            self.viewModel.addTurn(role: "assistant", text: "MinClaw daemon is offline. Run 'minclaw start' to boot it.")
                            self.viewModel.setIdle()
                        }
                    } else {
                        print("[voice:app] No speech detected")
                        self.viewModel.setIdle()
                    }
                }
            }
        }

        // Intermediate status from daemon (e.g. "Running tool: calendar")
        daemonClient.onStatus = { [weak self] status in
            DispatchQueue.main.async {
                guard let self = self else { return }
                print("[voice:app] ⏳ Status: \(status)")
                self.viewModel.statusMessage = status
            }
        }

        // Final response from daemon
        daemonClient.onMessage = { [weak self] response in
            guard let self = self else { return }
            print("[voice:app] 🤖 MinClaw final reply (\(response.text.count) chars)")

            // Filter out intermediate status or tool messages
            if self.isIntermediateStatusMessage(response.text) {
                print("[voice:app] ⏳ Caught intermediate status/tool message in onMessage: \(response.text)")
                self.viewModel.statusMessage = response.text
                return
            }

            guard self.viewModel.isVisible else {
                print("[voice:app] UI is not visible; skipping audio playback")
                return
            }

            self.viewModel.setSpeaking(response: response.text)

            // Synthesize and speak via Kokoro (af_heart)
            self.kokoroClient.speak(text: response.text, voice: "af_heart") { [weak self] in
                guard let self = self else { return }
                print("[voice:app] Audio playback completed")
                self.viewModel.setIdle()
            }
        }

        daemonClient.onError = { [weak self] err in
            print("[voice:app] Daemon error: \(err)")
            self?.viewModel.addTurn(role: "assistant", text: "Error: \(err)")
            self?.viewModel.setIdle()
        }

        // Session reset wiring
        viewModel.onResetSession = { [weak self] in
            self?.resetVoiceSession()
        }

        daemonClient.onSessionCleared = { [weak self] in
            self?.viewModel.clearSessionHistory()
        }

        // Visibility observer: when UI hides, immediately halt all speech
        viewModel.$isVisible.receive(on: DispatchQueue.main).sink { [weak self] visible in
            guard let self = self else { return }
            if visible {
                self.window.orderFrontRegardless()
            } else {
                self.window.orderOut(nil)
                self.kokoroClient.stopPlayback()
            }
        }.store(in: &cancellables)

        // Local ESC and Cmd+K monitor
        localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            if self.viewModel.isVisible {
                if event.keyCode == 53 {
                    self.dismissAndStop()
                    return nil
                }
                if event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers?.lowercased() == "k" {
                    self.resetVoiceSession()
                    return nil
                }
            }
            return event
        }

        // Global ESC monitor (when other apps have focus)
        globalKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return }
            if event.keyCode == 53 && self.viewModel.isVisible {
                DispatchQueue.main.async {
                    self.dismissAndStop()
                }
            }
        }
    }

    private var cancellables = Set<AnyCancellable>()
}
