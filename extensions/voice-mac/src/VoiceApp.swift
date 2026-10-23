import Foundation
import AppKit
import SwiftUI
import Combine

public class VoiceApp: NSObject, NSApplicationDelegate {
    private var window: NSPanel!
    private var viewModel: VoiceViewModel!
    private var hotkeyListener: HotkeyListener!
    private var audioRecorder: AudioRecorder!
    private var transcriber: Transcriber!
    private var daemonClient: DaemonClient!
    private var kokoroClient: KokoroClient!
    private let tempAudioURL = URL(fileURLWithPath: "/tmp/minclaw_voice_input.wav")

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

        // Pre-warm / ensure Kokoro server is ready
        DispatchQueue.global(qos: .utility).async { [weak self] in
            self?.kokoroClient.ensureServerRunning()
        }

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

        window = NSPanel(
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

        let rootView = Group {
            if mode == .notch {
                NotchHUDView(viewModel: viewModel)
            } else {
                FloatingHUDView(viewModel: viewModel)
            }
        }
        .frame(width: windowWidth, height: windowHeight, alignment: mode == .notch ? .top : .bottom)

        window.contentView = NSHostingView(rootView: rootView)
        window.orderOut(nil) // Start hidden
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
            self.viewModel.setThinking(prompt: "Transcribing audio...")

            // Run transcription in background
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self = self else { return }
                let transcription = self.transcriber.transcribe(audioFileURL: self.tempAudioURL)

                DispatchQueue.main.async {
                    if let prompt = transcription, !prompt.isEmpty {
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

        // Response from daemon
        daemonClient.onMessage = { [weak self] response in
            guard let self = self else { return }
            print("[voice:app] 🤖 MinClaw replied (\(response.text.count) chars)")

            self.viewModel.setSpeaking(response: response.text)

            // Synthesize and speak via Kokoro (af_heart)
            self.kokoroClient.speak(text: response.text, voice: "af_heart") { [weak self] in
                print("[voice:app] Audio playback completed")
                self?.viewModel.setIdle()
            }
        }

        daemonClient.onError = { [weak self] err in
            print("[voice:app] Daemon error: \(err)")
            self?.viewModel.addTurn(role: "assistant", text: "Error: \(err)")
            self?.viewModel.setIdle()
        }

        // Visibility observer
        viewModel.$isVisible.receive(on: DispatchQueue.main).sink { [weak self] visible in
            guard let self = self else { return }
            if visible {
                self.window.orderFrontRegardless()
            } else {
                self.window.orderOut(nil)
            }
        }.store(in: &cancellables)
    }

    private var cancellables = Set<AnyCancellable>()
}
