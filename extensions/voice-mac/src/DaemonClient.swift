import Foundation

public struct ChatResponse {
    public let text: String
    public let done: Bool
    public let sessionId: String
}

public class DaemonClient {
    private let socketPath: String
    private var socketFD: Int32 = -1
    private var isConnected: Bool = false
    private let readQueue = DispatchQueue(label: "minclaw.voice.daemon.read")

    public var onMessage: ((ChatResponse) -> Void)?
    public var onStatus: ((String) -> Void)?
    public var onError: ((String) -> Void)?

    public init(socketPath: String? = nil) {
        if let path = socketPath {
            self.socketPath = path
        } else {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            self.socketPath = "\(home)/.minclaw/daemon.sock"
        }
    }

    public func connect() -> Bool {
        if isConnected { return true }

        guard FileManager.default.fileExists(atPath: socketPath) else {
            print("[voice:daemon] Socket not found at \(socketPath). Is MinClaw daemon running?")
            return false
        }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            print("[voice:daemon] Failed to create socket")
            return false
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        guard socketPath.utf8.count < maxLen else {
            close(fd)
            return false
        }

        strncpy(&addr.sun_path.0, socketPath, maxLen - 1)

        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, len)
            }
        }

        guard connectResult == 0 else {
            close(fd)
            print("[voice:daemon] Failed to connect to socket: \(String(cString: strerror(errno)))")
            return false
        }

        socketFD = fd
        isConnected = true
        startReading()
        print("[voice:daemon] Connected to MinClaw daemon socket at \(socketPath)")
        return true
    }

    public func disconnect() {
        if socketFD >= 0 {
            close(socketFD)
            socketFD = -1
        }
        isConnected = false
    }

    public func sendChatMessage(sessionId: String = "voice:macbook", text: String) -> Bool {
        if !isConnected {
            if !connect() { return false }
        }

        let payload: [String: Any] = [
            "type": "chat",
            "sessionId": sessionId,
            "text": text
        ]

        do {
            var data = try JSONSerialization.data(withJSONObject: payload, options: [])
            data.append(contentsOf: [0x0A]) // \n

            let bytesWritten = data.withUnsafeBytes { ptr in
                write(socketFD, ptr.baseAddress, data.count)
            }

            return bytesWritten == data.count
        } catch {
            print("[voice:daemon] JSON encode error: \(error)")
            return false
        }
    }

    private func startReading() {
        readQueue.async { [weak self] in
            guard let self = self else { return }
            var buffer = Data()
            let chunk = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            defer { chunk.deallocate() }

            while self.isConnected && self.socketFD >= 0 {
                let bytesRead = read(self.socketFD, chunk, 4096)
                if bytesRead <= 0 {
                    print("[voice:daemon] Socket read end or error")
                    self.disconnect()
                    break
                }

                buffer.append(chunk, count: bytesRead)

                // Process complete lines
                while let newlineIndex = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer.subdata(in: 0..<newlineIndex)
                    buffer.removeSubrange(0...newlineIndex)

                    if let line = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !line.isEmpty {
                        self.handleIncomingLine(line)
                    }
                }
            }
        }
    }

    private func handleIncomingLine(_ line: String) {
        guard let data = line.data(using: .utf8) else { return }
        do {
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = json["type"] as? String else { return }

            if type == "chat_response" {
                let sid = json["sessionId"] as? String ?? ""
                let text = json["text"] as? String ?? ""
                let done = json["done"] as? Bool ?? true
                let resp = ChatResponse(text: text, done: done, sessionId: sid)
                DispatchQueue.main.async { [weak self] in
                    self?.onMessage?(resp)
                }
            } else if type == "chat_status" {
                let text = json["text"] as? String ?? ""
                DispatchQueue.main.async { [weak self] in
                    self?.onStatus?(text)
                }
            } else if type == "error" {
                let errMsg = json["message"] as? String ?? "Unknown error"
                DispatchQueue.main.async { [weak self] in
                    self?.onError?(errMsg)
                }
            }
        } catch {
            print("[voice:daemon] Parse line error: \(error)")
        }
    }
}
