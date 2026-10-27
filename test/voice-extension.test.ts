import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import JSON5 from "json5";
import { isVoiceRunning } from "../src/cli/voice-ctl.ts";
import { isNaturalResetRequest, isNoiseOnlyInput } from "../src/router.ts";
import { notifySessionCleared } from "../src/daemon/server.ts";

describe("Voice Extension (voice-mac)", () => {
  const root = join(import.meta.dir, "..");
  const extDir = join(root, "extensions", "voice-mac");

  test("extension.json5 exists and contains valid configuration with language pinning", () => {
    const configPath = join(extDir, "extension.json5");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON5.parse(content);

    expect(parsed.name).toBe("voice-mac");
    expect(parsed.platform).toBe("darwin");
    expect(parsed.ui.mode).toBe("notch");
    expect(parsed.tts.voice).toBe("af_heart");
    expect(parsed.tts.idleTimeoutSeconds).toBe(45);
    expect(parsed.stt.language).toBe("en");
    expect(parsed.stt.model).toBe("mlx-community/whisper-small-mlx-4bit");
  });

  test("compiled Swift companion binary exists and is executable", () => {
    const binPath = join(extDir, "bin", "minclaw-voice");
    if (!existsSync(binPath)) {
      Bun.spawnSync(["make"], { cwd: extDir });
    }
    expect(existsSync(binPath)).toBe(true);

    const proc = Bun.spawnSync([binPath, "--help"]);
    expect(proc.exitCode).toBe(0);
    const out = proc.stdout.toString();
    expect(out).toContain("Usage: minclaw-voice");
    expect(out).toContain("--mode <notch|bottom>");
    expect(out).toContain("--hotkey <key>");
    expect(out).toContain("--model <model>");
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

  test("isNaturalResetRequest correctly detects session reset intents", () => {
    // Explicit phrases requested
    expect(
      isNaturalResetRequest("Okay, clear the previous session, start the new session.")
    ).toBe(true);
    expect(isNaturalResetRequest("reset session")).toBe(true);
    expect(isNaturalResetRequest("start a new session")).toBe(true);

    // Additional natural variations
    expect(isNaturalResetRequest("clear session")).toBe(true);
    expect(isNaturalResetRequest("reset the previous session")).toBe(true);
    expect(isNaturalResetRequest("wipe current context")).toBe(true);
    expect(isNaturalResetRequest("restart the conversation")).toBe(true);
    expect(isNaturalResetRequest("can you please reset the session and start a new one")).toBe(true);
    expect(isNaturalResetRequest("hey please clear my chat history")).toBe(true);
    expect(isNaturalResetRequest("start new conversation")).toBe(true);

    // Negative tests: sentences that contain reset/session/start but are NOT session reset commands
    expect(isNaturalResetRequest("how do I reset my password")).toBe(false);
    expect(isNaturalResetRequest("can you reset the database")).toBe(false);
    expect(isNaturalResetRequest("how to start a new business")).toBe(false);
    expect(isNaturalResetRequest("what was the previous session about")).toBe(false);
    expect(isNaturalResetRequest("tell me about the history of computing")).toBe(false);
    expect(isNaturalResetRequest("start the server")).toBe(false);
    expect(isNaturalResetRequest("reset password")).toBe(false);
  });

  test("Transcriber.swift includes language pinning to prevent foreign language hallucinations", () => {
    const transcriberPath = join(extDir, "src", "Transcriber.swift");
    const content = readFileSync(transcriberPath, "utf-8");
    expect(content).toContain("--language");
    expect(content).toContain("language: String = \"en\"");
    expect(content).toContain("private let language: String");
  });

  test("Swift companion sources implement session reset wiring and UI", () => {
    // HistoryModel
    const modelPath = join(extDir, "src", "HistoryModel.swift");
    const modelContent = readFileSync(modelPath, "utf-8");
    expect(modelContent).toContain("onResetSession");
    expect(modelContent).toContain("clearSessionHistory()");

    // HistoryPanel
    const panelPath = join(extDir, "src", "HistoryPanel.swift");
    const panelContent = readFileSync(panelPath, "utf-8");
    expect(panelContent).toContain("ResetSessionButton");
    expect(panelContent).toContain("arrow.counterclockwise");
    expect(panelContent).toContain("viewModel.onResetSession?()");

    // DaemonClient
    const clientPath = join(extDir, "src", "DaemonClient.swift");
    const clientContent = readFileSync(clientPath, "utf-8");
    expect(clientContent).toContain("onSessionCleared");
    expect(clientContent).toContain("sendResetCommand");
    expect(clientContent).toContain("session_cleared");

    // VoiceApp
    const appPath = join(extDir, "src", "VoiceApp.swift");
    const appContent = readFileSync(appPath, "utf-8");
    expect(appContent).toContain("resetVoiceSession()");
    expect(appContent).toContain("viewModel.onResetSession =");
    expect(appContent).toContain("daemonClient.onSessionCleared =");
    expect(appContent).toContain("charactersIgnoringModifiers?.lowercased() == \"k\"");
  });

  test("notifySessionCleared is exported and available in server.ts", () => {
    expect(typeof notifySessionCleared).toBe("function");
  });

  test("isNoiseOnlyInput correctly identifies punctuation and noise-only inputs", () => {
    // Noise/punctuation only inputs that should be ignored
    expect(isNoiseOnlyInput(".")).toBe(true);
    expect(isNoiseOnlyInput("...")).toBe(true);
    expect(isNoiseOnlyInput(" , ! ")).toBe(true);
    expect(isNoiseOnlyInput("")).toBe(true);
    expect(isNoiseOnlyInput("   ")).toBe(true);
    expect(isNoiseOnlyInput("! - ?")).toBe(true);

    // Valid inputs that must NOT be ignored
    expect(isNoiseOnlyInput("hello")).toBe(false);
    expect(isNoiseOnlyInput("/reset")).toBe(false);
    expect(isNoiseOnlyInput("1")).toBe(false);
    expect(isNoiseOnlyInput("ok")).toBe(false);
    expect(isNoiseOnlyInput("What is 2 + 2?")).toBe(false);
  });

  test("main.swift unbuffers stdout and stderr for immediate logging", () => {
    const mainPath = join(extDir, "src", "main.swift");
    const content = readFileSync(mainPath, "utf-8");
    expect(content).toContain("setbuf(stdout, nil)");
    expect(content).toContain("setbuf(stderr, nil)");
  });

  test("Transcriber.swift guards against noise and punctuation-only transcripts", () => {
    const transcriberPath = join(extDir, "src", "Transcriber.swift");
    const content = readFileSync(transcriberPath, "utf-8");
    expect(content).toContain("alphanumerics");
    expect(content).toContain("return \"\"");
  });
});
