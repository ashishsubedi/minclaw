import { expect, test } from "bun:test";
import { getApiKeyForProvider } from "../src/auth/credentials.ts";
import { loadConfig } from "../src/config.ts";

test("resolves Google Gemini API key from MPA_GEMINI_KEY and MPA_GEMINI_KEY_FREE", async () => {
  const originalMpa = process.env.MPA_GEMINI_KEY;
  const originalFree = process.env.MPA_GEMINI_KEY_FREE;
  const originalGemini = process.env.GEMINI_API_KEY;

  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.MPA_GEMINI_KEY_FREE;
    process.env.MPA_GEMINI_KEY = "test-mpa-key";
    await expect(getApiKeyForProvider("google")).resolves.toBe("test-mpa-key");

    process.env.MPA_GEMINI_KEY_FREE = "test-free-key";
    await expect(getApiKeyForProvider("google")).resolves.toBe("test-free-key");

    process.env.GEMINI_API_KEY = "test-gemini-key";
    await expect(getApiKeyForProvider("google")).resolves.toBe("test-gemini-key");
  } finally {
    if (originalMpa === undefined) delete process.env.MPA_GEMINI_KEY;
    else process.env.MPA_GEMINI_KEY = originalMpa;

    if (originalFree === undefined) delete process.env.MPA_GEMINI_KEY_FREE;
    else process.env.MPA_GEMINI_KEY_FREE = originalFree;

    if (originalGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGemini;
  }
});

test("config loads agy with flash:medium as primary default model", () => {
  const config = loadConfig();
  expect(config.model.provider).toBe("agy");
  expect(config.model.name).toBe("flash:medium");
  expect(config.owner?.channel).toBe("telegram");
  expect(config.owner?.recipient).toBe(process.env.TELEGRAM_OWNER_ID || "");
});
