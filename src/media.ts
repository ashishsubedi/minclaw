import { existsSync, readFileSync, unlinkSync } from "fs";
import { extname, join } from "path";
import { tmpdir } from "os";
import { loadAllCredentials } from "./auth/credentials.ts";

const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Read an image file and return base64 data + mime type.
 * Returns null if file missing or unsupported format.
 */
export function readImageAsBase64(
  filePath: string
): { data: string; mimeType: string } | null {
  if (!existsSync(filePath)) return null;

  const ext = extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME[ext];
  if (!mimeType) return null;

  try {
    const data = readFileSync(filePath).toString("base64");
    return { data, mimeType };
  } catch (err) {
    console.error(`[media] Failed to read image: ${filePath}`, err);
    return null;
  }
}

/**
 * Resolve an OpenAI-compatible API key for Whisper.
 * Priority: OPENAI_API_KEY env → "whisper" credential → "openai" credential.
 */
function getWhisperApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;

  const store = loadAllCredentials();

  const whisperCred = store["whisper"];
  if (whisperCred?.method === "api_key") return whisperCred.apiKey;

  const openaiCred = store["openai"];
  if (openaiCred?.method === "api_key") return openaiCred.apiKey;

  return null;
}

/**
 * Locate local Whisper executable (e.g. Apple Silicon MLX Whisper or whisper-cli).
 */
export function findLocalWhisper(): string | null {
  const envPath = process.env.WHISPER_PATH?.trim();
  if (envPath && existsSync(envPath)) return envPath;

  const candidatePaths = [
    join(process.env.HOME || "", ".venv-vllm-metal/bin/mlx_whisper"),
    join(process.env.HOME || "", ".local/bin/mlx_whisper"),
    "/opt/homebrew/bin/mlx_whisper",
    "/usr/local/bin/mlx_whisper",
  ];

  for (const p of candidatePaths) {
    if (existsSync(p)) return p;
  }

  try {
    const res = Bun.spawnSync(["which", "mlx_whisper"]);
    if (res.exitCode === 0) {
      const found = res.stdout.toString().trim();
      if (found && existsSync(found)) return found;
    }
  } catch {}

  return null;
}

/**
 * Transcribe locally using Apple Silicon MLX Whisper.
 */
async function transcribeLocalWhisper(
  binaryPath: string,
  filePath: string
): Promise<string | null> {
  const model = process.env.WHISPER_MODEL?.trim() || "mlx-community/whisper-tiny";
  const tmpOutDir = tmpdir();
  const filePrefix = `minclaw_whisper_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  console.log(`[whisper] 🎙️ Transcribing locally with ${binaryPath} (model: ${model})...`);

  try {
    const proc = Bun.spawn(
      [
        binaryPath,
        filePath,
        "--model",
        model,
        "--output-dir",
        tmpOutDir,
        "--output-name",
        filePrefix,
        "--output-format",
        "txt",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    const txtPath = join(tmpOutDir, `${filePrefix}.txt`);

    if (exitCode !== 0) {
      console.error(`[whisper] Local whisper error (code ${exitCode}): ${stderr || stdout}`);
      if (existsSync(txtPath)) try { unlinkSync(txtPath); } catch {}
      return null;
    }

    if (!existsSync(txtPath)) {
      console.error("[whisper] Local transcription output file not found");
      return null;
    }

    const text = readFileSync(txtPath, "utf-8").trim();
    try {
      unlinkSync(txtPath);
    } catch {}

    console.log(`[whisper] ✅ Done local transcription (${text.length} chars)`);
    return text || null;
  } catch (err) {
    console.error("[whisper] Local transcription failed:", err);
    return null;
  }
}

async function transcribeOpenAIWhisper(
  filePath: string,
  apiKey: string
): Promise<string | null> {
  console.log("[whisper] ☁️ Transcribing via OpenAI Whisper API...");

  try {
    const file = Bun.file(filePath);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("model", "whisper-1");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[whisper] API error (${res.status}): ${errText}`);
      return null;
    }

    const data = (await res.json()) as { text: string };
    console.log(`[whisper] ✅ Done API transcription (${data.text.length} chars)`);
    return data.text;
  } catch (err) {
    console.error("[whisper] API transcription failed:", err);
    return null;
  }
}

/**
 * Transcribe an audio file using Local Whisper (MLX) or OpenAI API.
 * Returns transcription text, or null if neither is available or on failure.
 */
export async function transcribeAudio(
  filePath: string
): Promise<string | null> {
  if (!existsSync(filePath)) {
    console.error(`[whisper] File not found: ${filePath}`);
    return null;
  }

  // 1. Prioritize local Whisper (Apple Silicon MLX)
  const localWhisper = findLocalWhisper();
  if (localWhisper) {
    const text = await transcribeLocalWhisper(localWhisper, filePath);
    if (text) return text;
    console.log("[whisper] Local transcription failed or returned empty; trying API fallback...");
  }

  // 2. Fallback to OpenAI Whisper API if configured
  const apiKey = getWhisperApiKey();
  if (apiKey) {
    return transcribeOpenAIWhisper(filePath, apiKey);
  }

  if (!localWhisper) {
    console.log(
      "[whisper] No local Whisper found and no OpenAI API key configured. Run: minclaw setup or set WHISPER_PATH."
    );
  }

  return null;
}
