import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from "fs";
import { join, resolve } from "path";
import { createConnection } from "net";
import { getStateDir } from "../auth/credentials.ts";

export const ENROLLMENT_PHRASES = [
  { id: 1, lang: "English", text: "Hey MinClaw, what is on my schedule today?" },
  { id: 2, lang: "English", text: "Send a summary of my latest unread emails." },
  { id: 3, lang: "Nepali", text: "नमस्ते मिनक्ल, आजको ताजा मौसम र मुख्य समाचार के छ?" },
  { id: 4, lang: "Nepali", text: "मेरो आजको सबै कामहरू पूरा भयो कि बाँकी छ?" },
];

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const VOICE_PID_FILENAME = "voice.pid";

function getVoicePidPath(): string {
  return join(getStateDir(), VOICE_PID_FILENAME);
}

function getVoiceBinaryPath(): string {
  return resolve(import.meta.dir, "../../extensions/voice-mac/bin/minclaw-voice");
}

function getVoiceDir(): string {
  return resolve(import.meta.dir, "../../extensions/voice-mac");
}

export function isVoiceRunning(): { running: boolean; pid?: number } {
  const pidPath = getVoicePidPath();
  if (!existsSync(pidPath)) return { running: false };

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  if (isNaN(pid)) return { running: false };

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    try {
      unlinkSync(pidPath);
    } catch {}
    return { running: false };
  }
}

export async function buildVoice(): Promise<boolean> {
  console.log(`${CYAN}Building native macOS voice companion...${RESET}`);
  const dir = getVoiceDir();

  const proc = Bun.spawn(["make"], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    console.log(`${GREEN}Build successful!${RESET}`);
    return true;
  } else {
    console.log(`${RED}Build failed with code ${exitCode}${RESET}`);
    return false;
  }
}

export async function startVoice(options?: {
  mode?: string;
  hotkey?: string;
  foreground?: boolean;
  model?: string;
}): Promise<void> {
  if (process.platform !== "darwin") {
    console.log(`${RED}Error:${RESET} The voice extension is only supported on macOS.`);
    return;
  }

  const status = isVoiceRunning();
  if (status.running) {
    console.log(`${GREEN}Voice companion is already running${RESET} (PID ${status.pid})`);
    return;
  }

  const binaryPath = getVoiceBinaryPath();
  if (!existsSync(binaryPath)) {
    console.log(`${YELLOW}Binary not found. Compiling minclaw-voice...${RESET}`);
    const built = await buildVoice();
    if (!built) return;
  }

  const args: string[] = [];
  if (options?.mode) {
    args.push("--mode", options.mode);
  }
  if (options?.hotkey) {
    args.push("--hotkey", options.hotkey);
  }
  if (options?.model) {
    args.push("--model", options.model);
  }

  if (options?.foreground) {
    console.log(`${CYAN}Starting MinClaw voice companion in foreground...${RESET}`);
    console.log(`${DIM}Press Ctrl+C to stop.${RESET}`);
    const proc = Bun.spawn([binaryPath, ...args], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await proc.exited;
  } else {
    const logPath = join(getStateDir(), "logs", "voice.log");
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        `nohup "${binaryPath}" ${args.join(" ")} >> "${logPath}" 2>&1 & echo $!`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    const out = await new Response(proc.stdout).text();
    const pid = parseInt(out.trim(), 10);

    if (!isNaN(pid)) {
      writeFileSync(getVoicePidPath(), String(pid), "utf-8");
      console.log(
        `${GREEN}Voice companion started in background${RESET} (PID ${pid})`
      );
      console.log(
        `${DIM}Hold ${BOLD}Right-Option${RESET}${DIM} (or configured hotkey) anywhere to speak.${RESET}`
      );
    } else {
      console.log(`${RED}Failed to start voice companion process.${RESET}`);
    }
  }
}

export function stopVoice(): void {
  const status = isVoiceRunning();
  if (!status.running || !status.pid) {
    console.log(`${DIM}Voice companion is not running.${RESET}`);
    return;
  }

  try {
    process.kill(status.pid, "SIGTERM");
    console.log(`${GREEN}Voice companion stopped${RESET} (PID ${status.pid})`);
  } catch (err) {
    console.log(`${RED}Failed to stop voice companion: ${err}${RESET}`);
  }

  try {
    unlinkSync(getVoicePidPath());
  } catch {}
}

export async function ensureKokoroServer(): Promise<void> {
  const socketPath = join(getStateDir(), "kokoro.sock");
  if (existsSync(socketPath)) {
    try {
      await new Promise<void>((res, rej) => {
        const client = createConnection(socketPath, () => {
          client.end();
          res();
        });
        client.on("error", rej);
      });
      return;
    } catch {
      try { unlinkSync(socketPath); } catch {}
    }
  }

  const pythonCandidates = [
    join(process.env.HOME || "", ".venv-vllm-metal/bin/python3"),
    process.env.MINCLAW_PYTHON || "",
    Bun.which("python3") || "",
  ].filter(Boolean);

  const pyPath = pythonCandidates.find((p) => existsSync(p)) || "python3";
  const scriptPath = resolve(import.meta.dir, "../../extensions/voice-mac/tts/kokoro_server.py");

  if (!existsSync(scriptPath)) {
    throw new Error(`kokoro_server.py not found at ${scriptPath}`);
  }

  Bun.spawn([pyPath, scriptPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, MINCLAW_STATE_DIR: getStateDir() },
  });

  // Wait up to 5s for socket creation
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(socketPath)) {
      try {
        await new Promise<void>((res, rej) => {
          const client = createConnection(socketPath, () => {
            client.end();
            res();
          });
          client.on("error", rej);
        });
        return;
      } catch {}
    }
  }
}

export async function sendKokoroSocketRequest(payload: Record<string, any>): Promise<any> {
  await ensureKokoroServer();
  const socketPath = join(getStateDir(), "kokoro.sock");

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      client.destroy();
      reject(new Error("Timeout communicating with kokoro.sock"));
    }, 10000);

    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(payload) + "\n");
    });

    let buffer = "";
    client.on("data", (data) => {
      buffer += data.toString("utf-8");
    });

    client.on("end", () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(buffer.trim());
        resolve(json);
      } catch (e) {
        reject(e);
      }
    });

    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function recordPhrase(outputPath: string, durationSec: number = 4): Promise<boolean> {
  const binaryPath = getVoiceBinaryPath();
  if (existsSync(binaryPath)) {
    const proc = Bun.spawn([binaryPath, "--record-phrase", outputPath, String(durationSec)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0 && existsSync(outputPath);
  }

  const hasRec = Bun.which("rec");
  if (hasRec) {
    const proc = Bun.spawn(["rec", "-r", "16000", "-c", "1", outputPath, "trim", "0", String(durationSec)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0 && existsSync(outputPath);
  }

  const hasFfmpeg = Bun.which("ffmpeg");
  if (hasFfmpeg) {
    const proc = Bun.spawn(["ffmpeg", "-y", "-f", "avfoundation", "-i", ":default", "-t", String(durationSec), "-ar", "16000", "-ac", "1", outputPath], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0 && existsSync(outputPath);
  }

  return false;
}

export async function enrollVoiceWizard(options?: { threshold?: number; audioFiles?: string[] }): Promise<boolean> {
  console.log(`\n${BOLD}🎙️ MinClaw Biometric Voiceprint Enrollment Wizard${RESET}`);
  console.log(`${DIM}Enrolling your owner voiceprint protects MinClaw from unauthorized voices.${RESET}`);
  console.log(`${DIM}You will be guided through 4 calibration phrases (2 English, 2 Nepali).${RESET}\n`);

  const tmpDir = join(getStateDir(), "tmp");
  if (!existsSync(tmpDir)) {
    mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(tmpDir, 0o700); } catch {}
  }

  const threshold = options?.threshold ?? 0.65;
  const recordedFiles: string[] = [];
  const testFiles = options?.audioFiles || (process.env.MINCLAW_TEST_ENROLL_FILES ? process.env.MINCLAW_TEST_ENROLL_FILES.split(",") : undefined);

  try {
    for (let i = 0; i < ENROLLMENT_PHRASES.length; i++) {
      const phrase = ENROLLMENT_PHRASES[i];
      if (!phrase) continue;
      const wavPath = join(tmpDir, `enroll_${phrase.id}_${Date.now()}.wav`);

      console.log(`${BOLD}[Phrase ${phrase.id}/4] (${phrase.lang}):${RESET}`);
      console.log(`  ${CYAN}"${phrase.text}"${RESET}`);

      const testFile = testFiles?.[i];
      if (testFile && existsSync(testFile)) {
        // Use provided test audio file
        const data = readFileSync(testFile);
        writeFileSync(wavPath, data, { mode: 0o600 });
        recordedFiles.push(wavPath);
        console.log(`  ${GREEN}✓ Calibrated sample ${phrase.id}${RESET}\n`);
        continue;
      }

      // Check if running in automated/non-interactive test environment without microphone
      if (process.env.NODE_ENV === "test" || !process.stdin.isTTY) {
        console.log(`  ${YELLOW}Non-interactive terminal detected. Skipping audio capture.${RESET}`);
        return false;
      }

      process.stdout.write(`  Press ${BOLD}[Enter]${RESET} to record (approx. 4 seconds)... `);
      await new Promise<void>((res) => {
        const stdin = process.stdin;
        stdin.resume();
        stdin.once("data", () => {
          res();
        });
      });

      console.log(`  ${YELLOW}🎙️ Listening... Please speak phrase now.${RESET}`);
      const success = await recordPhrase(wavPath, 4);
      if (!success) {
        console.log(`  ${RED}Failed to capture audio for phrase ${phrase.id}.${RESET}`);
        return false;
      }
      try { chmodSync(wavPath, 0o600); } catch {}
      recordedFiles.push(wavPath);
      console.log(`  ${GREEN}✓ Recorded sample ${phrase.id}${RESET}\n`);
    }

    console.log(`${CYAN}Processing speaker embeddings and computing voice centroid...${RESET}`);
    const res = await sendKokoroSocketRequest({
      action: "enroll_speaker",
      audio_paths: recordedFiles,
      threshold,
    });

    if (res?.status === "ok") {
      const voiceprintPath = join(getStateDir(), "owner_voiceprint.json");
      if (existsSync(voiceprintPath)) {
        try { chmodSync(voiceprintPath, 0o600); } catch {}
      }
      console.log(`\n${GREEN}${BOLD}✅ Voice enrollment complete!${RESET}`);
      console.log(`  Samples Enrolled: ${res.samples_enrolled ?? recordedFiles.length}`);
      console.log(`  Voiceprint File:  ${voiceprintPath} (${DIM}0600 permissions${RESET})`);
      console.log(`  Threshold:        ${threshold}`);
      console.log(`\n${DIM}Unrecognized voices will now be gated with Touch ID.${RESET}\n`);
      return true;
    } else {
      console.log(`\n${RED}Enrollment failed: ${res?.message || "Unknown error"}${RESET}\n`);
      return false;
    }
  } finally {
    // Crucial: Clean up temporary audio files
    for (const f of recordedFiles) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {}
    }
  }
}

export function showVoiceStatus(): void {
  const status = isVoiceRunning();
  const binaryExists = existsSync(getVoiceBinaryPath());
  const kokoroSock = join(getStateDir(), "kokoro.sock");
  const kokoroActive = existsSync(kokoroSock);
  const voiceprintPath = join(getStateDir(), "owner_voiceprint.json");
  const voiceprintExists = existsSync(voiceprintPath);

  console.log(`${BOLD}MinClaw Voice Extension Status:${RESET}`);
  console.log(
    `  Running:    ${status.running ? `${GREEN}active${RESET} (PID ${status.pid})` : `${RED}stopped${RESET}`}`
  );
  console.log(
    `  Binary:     ${binaryExists ? `${GREEN}built${RESET} (${getVoiceBinaryPath()})` : `${YELLOW}not built${RESET}`}`
  );
  console.log(
    `  Kokoro:     ${kokoroActive ? `${GREEN}socket active${RESET}` : `${DIM}idle (lazy start)${RESET}`}`
  );
  console.log(
    `  Voiceprint: ${voiceprintExists ? `${GREEN}enrolled (0600)${RESET}` : `${DIM}unenrolled${RESET}`}`
  );
}

// Subcommand dispatcher when executed directly or via CLI
if (import.meta.main || process.argv[2] === "voice") {
  const [sub, ...rest] = process.argv.slice(3);

  const modeFlag = rest.find((a) => a.startsWith("--mode="))?.split("=")[1] ||
                   (rest.indexOf("--mode") !== -1 ? rest[rest.indexOf("--mode") + 1] : undefined);

  const hotkeyFlag = rest.find((a) => a.startsWith("--hotkey="))?.split("=")[1] ||
                     (rest.indexOf("--hotkey") !== -1 ? rest[rest.indexOf("--hotkey") + 1] : undefined);

  const modelFlag = rest.find((a) => a.startsWith("--model="))?.split("=")[1] ||
                    (rest.indexOf("--model") !== -1 ? rest[rest.indexOf("--model") + 1] : undefined);

  const foreground = rest.includes("--foreground") || rest.includes("-f");

  switch (sub || "start") {
    case "start":
      await startVoice({ mode: modeFlag, hotkey: hotkeyFlag, foreground, model: modelFlag });
      break;
    case "stop":
      stopVoice();
      break;
    case "restart":
      stopVoice();
      await new Promise((r) => setTimeout(r, 400));
      await startVoice({ mode: modeFlag, hotkey: hotkeyFlag, foreground, model: modelFlag });
      break;
    case "status":
      showVoiceStatus();
      break;
    case "enroll":
      await enrollVoiceWizard();
      break;
    case "build":
      await buildVoice();
      break;
    default:
      console.log(`Unknown voice command: ${sub}. Use: start, stop, restart, status, build, enroll`);
      break;
  }
}
