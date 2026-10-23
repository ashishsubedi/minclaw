import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { getStateDir } from "../auth/credentials.ts";

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

export function showVoiceStatus(): void {
  const status = isVoiceRunning();
  const binaryExists = existsSync(getVoiceBinaryPath());
  const kokoroSock = join(getStateDir(), "kokoro.sock");
  const kokoroActive = existsSync(kokoroSock);

  console.log(`${BOLD}MinClaw Voice Extension Status:${RESET}`);
  console.log(
    `  Running:   ${status.running ? `${GREEN}active${RESET} (PID ${status.pid})` : `${RED}stopped${RESET}`}`
  );
  console.log(
    `  Binary:    ${binaryExists ? `${GREEN}built${RESET} (${getVoiceBinaryPath()})` : `${YELLOW}not built${RESET}`}`
  );
  console.log(
    `  Kokoro:    ${kokoroActive ? `${GREEN}socket active${RESET}` : `${DIM}idle (lazy start)${RESET}`}`
  );
}

// Subcommand dispatcher when executed directly or via CLI
if (import.meta.main || process.argv[2] === "voice") {
  const [sub, ...rest] = process.argv.slice(3);

  const modeFlag = rest.find((a) => a.startsWith("--mode="))?.split("=")[1] ||
                   (rest.indexOf("--mode") !== -1 ? rest[rest.indexOf("--mode") + 1] : undefined);

  const hotkeyFlag = rest.find((a) => a.startsWith("--hotkey="))?.split("=")[1] ||
                     (rest.indexOf("--hotkey") !== -1 ? rest[rest.indexOf("--hotkey") + 1] : undefined);

  const foreground = rest.includes("--foreground") || rest.includes("-f");

  switch (sub || "start") {
    case "start":
      await startVoice({ mode: modeFlag, hotkey: hotkeyFlag, foreground });
      break;
    case "stop":
      stopVoice();
      break;
    case "restart":
      stopVoice();
      await new Promise((r) => setTimeout(r, 400));
      await startVoice({ mode: modeFlag, hotkey: hotkeyFlag, foreground });
      break;
    case "status":
      showVoiceStatus();
      break;
    case "build":
      await buildVoice();
      break;
    default:
      console.log(`Unknown voice command: ${sub}. Use: start, stop, restart, status, build`);
      break;
  }
}
