import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import JSON5 from "json5";
import { isVoiceRunning } from "../src/cli/voice-ctl.ts";

describe("Voice Extension (voice-mac)", () => {
  const root = join(import.meta.dir, "..");
  const extDir = join(root, "extensions", "voice-mac");

  test("extension.json5 exists and contains valid configuration", () => {
    const configPath = join(extDir, "extension.json5");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON5.parse(content);

    expect(parsed.name).toBe("voice-mac");
    expect(parsed.platform).toBe("darwin");
    expect(parsed.ui.mode).toBe("notch");
    expect(parsed.tts.voice).toBe("af_heart");
    expect(parsed.tts.idleTimeoutSeconds).toBe(45);
  });

  test("compiled Swift companion binary exists and is executable", () => {
    const binPath = join(extDir, "bin", "minclaw-voice");
    expect(existsSync(binPath)).toBe(true);

    const proc = Bun.spawnSync([binPath, "--help"]);
    expect(proc.exitCode).toBe(0);
    const out = proc.stdout.toString();
    expect(out).toContain("Usage: minclaw-voice");
    expect(out).toContain("--mode <notch|bottom>");
    expect(out).toContain("--hotkey <key>");
  });

  test("Kokoro TTS server script is executable and syntactically valid", () => {
    const serverScript = join(extDir, "tts", "kokoro_server.py");
    expect(existsSync(serverScript)).toBe(true);

    const pyBin = join(process.env.HOME || "", ".venv-vllm-metal/bin/python3");
    if (existsSync(pyBin)) {
      const proc = Bun.spawnSync([pyBin, "-m", "py_compile", serverScript]);
      expect(proc.exitCode).toBe(0);
    }
  });

  test("isVoiceRunning returns expected shape", () => {
    const status = isVoiceRunning();
    expect(typeof status.running).toBe("boolean");
  });
});
