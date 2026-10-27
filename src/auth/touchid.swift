import Foundation
import CoreGraphics
import LocalAuthentication

func isLocked() -> Bool {
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

func main() {
    let args = CommandLine.arguments
    if args.count < 2 {
        fputs("Usage: minclaw-touchid <is-locked|prompt|check> [reason]\n", stderr)
        exit(1)
    }

    let action = args[1]
    switch action {
    case "is-locked":
        if isLocked() {
            print("true")
            exit(0)
        } else {
            print("false")
            exit(1)
        }

    case "check", "can-prompt":
        let context = LAContext()
        var authError: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError) ||
           context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) {
            print("available")
            exit(0)
        } else {
            print("unavailable")
            exit(2)
        }

    case "prompt":
        let reason = args.count > 2 ? args[2] : "Unlock MinClaw Dashboard"
        let context = LAContext()
        var authError: NSError?

        let policy: LAPolicy
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError) {
            policy = .deviceOwnerAuthenticationWithBiometrics
        } else if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &authError) {
            policy = .deviceOwnerAuthentication
        } else {
            let msg = authError?.localizedDescription ?? "Biometrics/Authentication unavailable"
            fputs("Unavailable: \(msg)\n", stderr)
            exit(2)
        }

        let semaphore = DispatchSemaphore(value: 0)
        var exitCode: Int32 = 1

        context.evaluatePolicy(policy, localizedReason: reason) { success, error in
            if success {
                print("authenticated")
                exitCode = 0
            } else {
                if let laError = error as? LAError {
                    switch laError.code {
                    case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet:
                        fputs("Unavailable: \(laError.localizedDescription)\n", stderr)
                        exitCode = 2
                    default:
                        fputs("Failed: \(laError.localizedDescription)\n", stderr)
                        exitCode = 1
                    }
                } else if let err = error {
                    fputs("Failed: \(err.localizedDescription)\n", stderr)
                    exitCode = 1
                } else {
                    fputs("Failed\n", stderr)
                    exitCode = 1
                }
            }
            semaphore.signal()
        }

        semaphore.wait()
        exit(exitCode)

    default:
        fputs("Unknown action: \(action)\n", stderr)
        exit(1)
    }
}

main()
