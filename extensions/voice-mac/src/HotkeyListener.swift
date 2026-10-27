import Foundation
import AppKit
import CoreGraphics

public func isScreenLocked() -> Bool {
    if let testLocked = ProcessInfo.processInfo.environment["MINCLAW_TEST_LOCKED"] {
        if testLocked == "1" || testLocked.lowercased() == "true" { return true }
        if testLocked == "0" || testLocked.lowercased() == "false" { return false }
    }
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else {
        return false
    }
    if let isLocked = dict["CGSSessionScreenIsLocked"] as? Bool {
        return isLocked
    }
    if let isLockedNum = dict["CGSSessionScreenIsLocked"] as? NSNumber {
        return isLockedNum.boolValue
    }
    return false
}

public enum HotkeyType: String {
    case rightOption = "right-option"
    case leftOption = "left-option"
    case fn = "fn"
    case rightCommand = "right-command"
}

public class HotkeyListener {
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var isKeyDown: Bool = false
    private let targetKey: HotkeyType

    public var onPress: (() -> Void)?
    public var onRelease: (() -> Void)?

    public init(targetKey: HotkeyType = .rightOption) {
        self.targetKey = targetKey
    }

    public func start() {
        stop()

        let flagsHandler: (NSEvent) -> Void = { [weak self] event in
            guard let self = self else { return }
            self.handleFlagsChanged(event)
        }

        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: flagsHandler)
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.handleFlagsChanged(event)
            return event
        }

        print("[voice:hotkey] Listening for \(targetKey.rawValue) (push-and-hold)...")
    }

    public func stop() {
        if let g = globalMonitor {
            NSEvent.removeMonitor(g)
            globalMonitor = nil
        }
        if let l = localMonitor {
            NSEvent.removeMonitor(l)
            localMonitor = nil
        }
        isKeyDown = false
    }

    public func reset() {
        isKeyDown = false
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        if isScreenLocked() {
            if isKeyDown {
                isKeyDown = false
            }
            return
        }

        let keyCode = event.keyCode
        let flags = event.modifierFlags

        var matchesTarget = false
        var active = false

        switch targetKey {
        case .rightOption:
            // Key code 61 is Right Option on macOS
            if keyCode == 61 {
                matchesTarget = true
                active = flags.contains(.option)
            }
        case .leftOption:
            // Key code 58 is Left Option
            if keyCode == 58 {
                matchesTarget = true
                active = flags.contains(.option)
            }
        case .rightCommand:
            // Key code 54 is Right Command
            if keyCode == 54 {
                matchesTarget = true
                active = flags.contains(.command)
            }
        case .fn:
            // Key code 63 is Fn / Globe
            if keyCode == 63 || flags.contains(.function) {
                matchesTarget = true
                active = flags.contains(.function)
            }
        }

        if matchesTarget {
            if active && !isKeyDown {
                if isScreenLocked() {
                    return
                }
                isKeyDown = true
                DispatchQueue.main.async { [weak self] in
                    self?.onPress?()
                }
            } else if !active && isKeyDown {
                isKeyDown = false
                DispatchQueue.main.async { [weak self] in
                    self?.onRelease?()
                }
            }
        }
    }
}
