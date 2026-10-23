import { existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { getStateDir } from "../../../src/auth/credentials.ts";

export interface KokoroSynthesizeOptions {
  text: string;
  voice?: string;
  speed?: number;
  outputPath?: string;
}

export interface KokoroResponse {
  status: "ok" | "error";
  output_path?: string;
  duration?: number;
  elapsed?: number;
  message?: string;
  loaded?: boolean;
}

const SOCKET_PATH = join(getStateDir(), "kokoro.sock");

/**
 * Check if the Kokoro server socket is active.
 */
export async function isKokoroRunning(): Promise<boolean> {
  if (!existsSync(SOCKET_PATH)) return false;
  try {
    const res = await sendKokoroRequest({ action: "ping" });
    return res.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Ensure Kokoro server is running, starting it as a detached background worker if needed.
 */
export async function ensureKokoroServer(): Promise<void> {
  if (await isKokoroRunning()) return;

  const pythonBin = join(
    process.env.HOME || "",
    ".venv-vllm-metal/bin/python3"
  );
  const serverScript = join(
    import.meta.dir,
    "kokoro_server.py"
  );

  if (!existsSync(pythonBin) || !existsSync(serverScript)) {
    throw new Error(
      `Kokoro server dependencies missing: python=${existsSync(pythonBin)}, script=${existsSync(serverScript)}`
    );
  }

  const proc = spawn(pythonBin, [serverScript], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  proc.unref();

  // Poll for up to 3 seconds for socket to appear
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isKokoroRunning()) return;
  }

  throw new Error("Timed out waiting for Kokoro server to initialize");
}

/**
 * Send an IPC request to the Kokoro Unix socket.
 */
export async function sendKokoroRequest(
  payload: Record<string, unknown>
): Promise<KokoroResponse> {
  return new Promise(async (resolve, reject) => {
    try {
      const socket = await Bun.connect({
        unix: SOCKET_PATH,
        socket: {
          data(_socket, raw) {
            try {
              const res = JSON.parse(raw.toString().trim()) as KokoroResponse;
              resolve(res);
            } catch (err) {
              reject(err);
            }
          },
          error(_socket, err) {
            reject(err);
          },
        },
      });

      socket.write(JSON.stringify(payload) + "\n");
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Synthesize speech via Kokoro af_heart.
 * If server is not running, attempts to start it.
 * Falls back to macOS 'say' if Kokoro fails.
 */
export async function speakText(
  text: string,
  options: { voice?: string; speed?: number; fallbackToSystem?: boolean } = {}
): Promise<{ success: boolean; audioPath?: string; fallback?: boolean }> {
  const cleanText = text
    // Strip markdown formatting
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/#+\s+/g, "")
    .trim();

  if (!cleanText) return { success: true };

  try {
    await ensureKokoroServer();
    const outPath = `/tmp/kokoro_voice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.wav`;
    const res = await sendKokoroRequest({
      action: "synthesize",
      text: cleanText,
      output_path: outPath,
      voice: options.voice || "af_heart",
      speed: options.speed || 1.0,
    });

    if (res.status === "ok" && res.output_path && existsSync(res.output_path)) {
      // Play audio using afplay
      const playProc = Bun.spawn(["afplay", res.output_path]);
      await playProc.exited;
      return { success: true, audioPath: res.output_path };
    }
    throw new Error(res.message || "Unknown synthesis error");
  } catch (err) {
    console.warn(`[voice] Kokoro synthesis failed (${err}), falling back to macOS say...`);
    if (options.fallbackToSystem !== false) {
      const sayProc = Bun.spawn(["say", "-v", "Samantha", cleanText]);
      await sayProc.exited;
      return { success: true, fallback: true };
    }
    return { success: false };
  }
}
