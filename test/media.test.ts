import { describe, expect, it } from "bun:test";
import { findLocalWhisper, transcribeAudio } from "../src/media.ts";
import { existsSync, unlinkSync } from "fs";

describe("Media & Transcription", () => {
  it("finds local whisper binary if installed", () => {
    const whisperPath = findLocalWhisper();
    expect(whisperPath).not.toBeNull();
    expect(existsSync(whisperPath!)).toBe(true);
  });

  it("handles missing audio file gracefully", async () => {
    const res = await transcribeAudio("/tmp/non_existent_audio_file_123.ogg");
    expect(res).toBeNull();
  });
});
