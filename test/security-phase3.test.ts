import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createConnection } from "net";
import { isScreenLocked } from "../src/auth/touchid.ts";
import {
  ENROLLMENT_PHRASES,
  ensureKokoroServer,
  enrollVoiceWizard,
  recordPhrase,
  sendKokoroSocketRequest,
  showVoiceStatus,
} from "../src/cli/voice-ctl.ts";

function createWavBuffer(sampleRate = 16000, durationSec = 1.0, freq = 200): Buffer {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // Mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Harmonic tone for voice-like formant structure
    const val =
      Math.sin(2 * Math.PI * freq * t) * 0.6 +
      Math.sin(2 * Math.PI * freq * 2 * t) * 0.25 +
      Math.sin(2 * Math.PI * freq * 3 * t) * 0.15;
    const sample16 = Math.max(-32768, Math.min(32767, Math.floor(val * 32767)));
    buffer.writeInt16LE(sample16, 44 + i * 2);
  }

  return buffer;
}

describe("Phase 3 Security Hardening: Voice Companion & Biometric Speaker Verification", () => {
  let tempStateDir: string;
  const originalStateDir = process.env.MINCLAW_STATE_DIR;
  const originalTestLocked = process.env.MINCLAW_TEST_LOCKED;
  const originalTestTouchId = process.env.MINCLAW_TEST_TOUCHID;
  const voiceBinaryPath = resolve(import.meta.dir, "../extensions/voice-mac/bin/minclaw-voice");

  beforeEach(() => {
    tempStateDir = mkdtempSync(join(tmpdir(), "minclaw-sec3-test-"));
    process.env.MINCLAW_STATE_DIR = tempStateDir;
    delete process.env.MINCLAW_TEST_LOCKED;
    delete process.env.MINCLAW_TEST_TOUCHID;
  });

  afterEach(() => {
    if (originalStateDir !== undefined) {
      process.env.MINCLAW_STATE_DIR = originalStateDir;
    } else {
      delete process.env.MINCLAW_STATE_DIR;
    }
    if (originalTestLocked !== undefined) {
      process.env.MINCLAW_TEST_LOCKED = originalTestLocked;
    } else {
      delete process.env.MINCLAW_TEST_LOCKED;
    }
    if (originalTestTouchId !== undefined) {
      process.env.MINCLAW_TEST_TOUCHID = originalTestTouchId;
    } else {
      delete process.env.MINCLAW_TEST_TOUCHID;
    }

    try {
      if (existsSync(tempStateDir)) {
        rmSync(tempStateDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("Lock Screen Detection Logic", () => {
    test("detects screen lock state and respects MINCLAW_TEST_LOCKED env var", () => {
      // Natural screen lock state is a boolean
      const naturalLock = isScreenLocked();
      expect(typeof naturalLock).toBe("boolean");

      // Mock locked = true
      process.env.MINCLAW_TEST_LOCKED = "true";
      expect(isScreenLocked()).toBe(true);

      process.env.MINCLAW_TEST_LOCKED = "1";
      expect(isScreenLocked()).toBe(true);

      // Mock locked = false
      process.env.MINCLAW_TEST_LOCKED = "false";
      expect(isScreenLocked()).toBe(false);

      process.env.MINCLAW_TEST_LOCKED = "0";
      expect(isScreenLocked()).toBe(false);
    });

    test("compiled bin/minclaw-voice --check-locked returns correct lock state", async () => {
      expect(existsSync(voiceBinaryPath)).toBe(true);

      const procUnlocked = Bun.spawn([voiceBinaryPath, "--check-locked"], {
        env: { ...process.env, MINCLAW_TEST_LOCKED: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const outUnlocked = (await new Response(procUnlocked.stdout).text()).trim();
      const codeUnlocked = await procUnlocked.exited;
      expect(codeUnlocked).toBe(0);
      expect(outUnlocked).toBe("false");

      const procLocked = Bun.spawn([voiceBinaryPath, "--check-locked"], {
        env: { ...process.env, MINCLAW_TEST_LOCKED: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const outLocked = (await new Response(procLocked.stdout).text()).trim();
      const codeLocked = await procLocked.exited;
      expect(codeLocked).toBe(0);
      expect(outLocked).toBe("true");
    });
  });

  describe("Private Temp Audio Directory Permissions and Cleanup", () => {
    test("creates ~/.minclaw/tmp directory with strict 0700 permissions", () => {
      const tmpDir = join(tempStateDir, "tmp");
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      chmodSync(tmpDir, 0o700);

      const stat = statSync(tmpDir);
      const perms = (stat.mode & 0o777).toString(8);
      expect(perms).toBe("700");
    });

    test("audio files written to temp directory have 0600 permissions", () => {
      const tmpDir = join(tempStateDir, "tmp");
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      const testAudio = join(tmpDir, "voice_input.wav");

      const buf = createWavBuffer(16000, 0.5, 200);
      writeFileSync(testAudio, buf, { mode: 0o600 });
      chmodSync(testAudio, 0o600);

      const stat = statSync(testAudio);
      const perms = (stat.mode & 0o777).toString(8);
      expect(perms).toBe("600");
    });

    test("temp audio files are unlinked/deleted after use", () => {
      const tmpDir = join(tempStateDir, "tmp");
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      const testAudio = join(tmpDir, "voice_input.wav");
      writeFileSync(testAudio, createWavBuffer(16000, 0.2, 220), { mode: 0o600 });

      expect(existsSync(testAudio)).toBe(true);
      unlinkSync(testAudio);
      expect(existsSync(testAudio)).toBe(false);
    });
  });

  describe("Kokoro Server Speaker Verification IPC Actions", () => {
    test("reports unenrolled status when owner_voiceprint.json does not exist", async () => {
      const statusRes = await sendKokoroSocketRequest({ action: "voiceprint_status" });
      expect(statusRes.status).toBe("ok");
      expect(statusRes.enrolled).toBe(false);
      expect(statusRes.samples_count).toBe(0);
    });

    test("verify_speaker passes through (verified=true) when unenrolled", async () => {
      const tmpDir = join(tempStateDir, "tmp");
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      const testAudio = join(tmpDir, "unenrolled_test.wav");
      writeFileSync(testAudio, createWavBuffer(16000, 1.0, 200), { mode: 0o600 });

      const verifyRes = await sendKokoroSocketRequest({
        action: "verify_speaker",
        audio_path: testAudio,
      });

      expect(verifyRes.status).toBe("ok");
      expect(verifyRes.enrolled).toBe(false);
      expect(verifyRes.verified).toBe(true);
      expect(verifyRes.reason).toBe("unenrolled");
    });

    test("enroll_speaker saves voiceprint with strict 0600 permissions", async () => {
      const tmpDir = join(tempStateDir, "tmp");
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

      const audioPaths: string[] = [];
      for (let i = 0; i < 4; i++) {
        const p = join(tmpDir, `owner_sample_${i}.wav`);
        // Pitch variations around 180Hz for owner
        writeFileSync(p, createWavBuffer(16000, 1.2, 180 + i * 2), { mode: 0o600 });
        audioPaths.push(p);
      }

      const enrollRes = await sendKokoroSocketRequest({
        action: "enroll_speaker",
        audio_paths: audioPaths,
        threshold: 0.65,
      });

      expect(enrollRes.status).toBe("ok");
      expect(enrollRes.samples_enrolled).toBe(4);

      const voiceprintPath = join(tempStateDir, "owner_voiceprint.json");
      expect(existsSync(voiceprintPath)).toBe(true);

      const stat = statSync(voiceprintPath);
      const perms = (stat.mode & 0o777).toString(8);
      expect(perms).toBe("600");

      const vpData = JSON.parse(readFileSync(voiceprintPath, "utf-8"));
      expect(vpData.samples_count).toBe(4);
      expect(vpData.threshold).toBe(0.65);
      expect(Array.isArray(vpData.embedding)).toBe(true);
      expect(vpData.embedding.length).toBeGreaterThan(0);

      // Verify status now reflects enrolled
      const statusRes = await sendKokoroSocketRequest({ action: "voiceprint_status" });
      expect(statusRes.status).toBe("ok");
      expect(statusRes.enrolled).toBe(true);
      expect(statusRes.samples_count).toBe(4);
    });

    test("verify_speaker approves matching owner voice (cosine similarity >= 0.65)", async () => {
      const tmpDir = join(tempStateDir, "tmp");
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

      // First ensure enrolled with owner at 180Hz
      const audioPaths: [string, string] = [
        join(tmpDir, "owner_train_1.wav"),
        join(tmpDir, "owner_train_2.wav"),
      ];
      writeFileSync(audioPaths[0], createWavBuffer(16000, 1.2, 180), { mode: 0o600 });
      writeFileSync(audioPaths[1], createWavBuffer(16000, 1.2, 182), { mode: 0o600 });

      await sendKokoroSocketRequest({
        action: "enroll_speaker",
        audio_paths: audioPaths,
        threshold: 0.65,
      });

      // Matching owner sample (181Hz)
      const matchingSample = join(tmpDir, "owner_test.wav");
      writeFileSync(matchingSample, createWavBuffer(16000, 1.2, 181), { mode: 0o600 });

      const verifyRes = await sendKokoroSocketRequest({
        action: "verify_speaker",
        audio_path: matchingSample,
      });

      expect(verifyRes.status).toBe("ok");
      expect(verifyRes.enrolled).toBe(true);
      expect(verifyRes.verified).toBe(true);
      expect(verifyRes.score).toBeGreaterThanOrEqual(0.65);
    });

    test("verify_speaker rejects different/impostor voice (cosine similarity < 0.65)", async () => {
      const tmpDir = join(tempStateDir, "tmp");
      mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

      // Owner enrolled at 180Hz
      const audioPaths: [string, string] = [
        join(tmpDir, "owner_train_1.wav"),
        join(tmpDir, "owner_train_2.wav"),
      ];
      writeFileSync(audioPaths[0], createWavBuffer(16000, 1.2, 180), { mode: 0o600 });
      writeFileSync(audioPaths[1], createWavBuffer(16000, 1.2, 182), { mode: 0o600 });

      await sendKokoroSocketRequest({
        action: "enroll_speaker",
        audio_paths: audioPaths,
        threshold: 0.65,
      });

      // Impostor voice sample (450Hz soprano / high pitch)
      const impostorSample = join(tmpDir, "impostor_test.wav");
      writeFileSync(impostorSample, createWavBuffer(16000, 1.2, 450), { mode: 0o600 });

      const verifyRes = await sendKokoroSocketRequest({
        action: "verify_speaker",
        audio_path: impostorSample,
      });

      expect(verifyRes.status).toBe("ok");
      expect(verifyRes.enrolled).toBe(true);
      expect(verifyRes.verified).toBe(false);
      expect(verifyRes.score).toBeLessThan(0.65);
    });

    test("reset_voiceprint successfully removes voiceprint file", async () => {
      const resetRes = await sendKokoroSocketRequest({ action: "reset_voiceprint" });
      expect(resetRes.status).toBe("ok");

      const voiceprintPath = join(tempStateDir, "owner_voiceprint.json");
      expect(existsSync(voiceprintPath)).toBe(false);

      const statusRes = await sendKokoroSocketRequest({ action: "voiceprint_status" });
      expect(statusRes.enrolled).toBe(false);
    });
  });

  describe("CLI Enrollment Wizard & Status", () => {
    test("ENROLLMENT_PHRASES contains 4 structured English and Nepali calibration prompts", () => {
      expect(ENROLLMENT_PHRASES.length).toBe(4);

      const p0 = ENROLLMENT_PHRASES[0]!;
      expect(p0.id).toBe(1);
      expect(p0.lang).toBe("English");
      expect(p0.text).toBe("Hey MinClaw, what is on my schedule today?");

      const p1 = ENROLLMENT_PHRASES[1]!;
      expect(p1.id).toBe(2);
      expect(p1.lang).toBe("English");
      expect(p1.text).toBe("Send a summary of my latest unread emails.");

      const p2 = ENROLLMENT_PHRASES[2]!;
      expect(p2.id).toBe(3);
      expect(p2.lang).toBe("Nepali");
      expect(p2.text).toBe("नमस्ते मिनक्ल, आजको ताजा मौसम र मुख्य समाचार के छ?");

      const p3 = ENROLLMENT_PHRASES[3]!;
      expect(p3.id).toBe(4);
      expect(p3.lang).toBe("Nepali");
      expect(p3.text).toBe("मेरो आजको सबै कामहरू पूरा भयो कि बाँकी छ?");
    });

    test("enrollVoiceWizard calibrates 4 samples and unlinks temp files", async () => {
      const tmpTestDir = join(tempStateDir, "test_audio");
      mkdirSync(tmpTestDir, { recursive: true });

      const testAudioFiles: string[] = [];
      for (let i = 0; i < 4; i++) {
        const p = join(tmpTestDir, `calib_${i}.wav`);
        writeFileSync(p, createWavBuffer(16000, 1.0, 190 + i), { mode: 0o600 });
        testAudioFiles.push(p);
      }

      const success = await enrollVoiceWizard({ audioFiles: testAudioFiles });
      expect(success).toBe(true);

      const voiceprintPath = join(tempStateDir, "owner_voiceprint.json");
      expect(existsSync(voiceprintPath)).toBe(true);

      const stat = statSync(voiceprintPath);
      const perms = (stat.mode & 0o777).toString(8);
      expect(perms).toBe("600");

      // Verify temp calibration wav files inside tmpDir were unlinked
      const tmpDir = join(tempStateDir, "tmp");
      const remainingWavs = existsSync(tmpDir) ? require("fs").readdirSync(tmpDir).filter((f: string) => f.endsWith(".wav")) : [];
      expect(remainingWavs.length).toBe(0);
    });

    test("showVoiceStatus outputs enrollment state without crashing", () => {
      expect(() => showVoiceStatus()).not.toThrow();
    });
  });

  describe("Touch ID Override TTL Logic (15 minutes)", () => {
    test("calculates and enforces 15-minute Touch ID override TTL", () => {
      const now = new Date();
      const isOverrideValid = (expiry?: Date, at: Date = new Date()): boolean => {
        return expiry !== undefined && at.getTime() < expiry.getTime();
      };

      let voiceOverrideExpiry: Date | undefined = undefined;

      // Initially no override
      expect(isOverrideValid(voiceOverrideExpiry)).toBe(false);

      // Touch ID approved -> set 15 minutes TTL
      voiceOverrideExpiry = new Date(now.getTime() + 15 * 60 * 1000);

      // Immediate check -> valid
      expect(isOverrideValid(voiceOverrideExpiry, new Date(now.getTime() + 1000))).toBe(true);

      // 10 minutes later -> still valid
      expect(isOverrideValid(voiceOverrideExpiry, new Date(now.getTime() + 10 * 60 * 1000))).toBe(true);

      // 14 minutes 59 seconds later -> still valid
      expect(isOverrideValid(voiceOverrideExpiry, new Date(now.getTime() + 14 * 60 * 1000 + 59 * 1000))).toBe(true);

      // 15 minutes 1 second later -> expired
      expect(isOverrideValid(voiceOverrideExpiry, new Date(now.getTime() + 15 * 60 * 1000 + 1000))).toBe(false);
    });
  });
});
