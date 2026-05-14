import { expect, test } from "bun:test";
import { getApiKeyForProvider } from "../src/auth/credentials.ts";
import { getModels } from "@mariozechner/pi-ai";

test("uses the live GitHub Copilot model catalog", () => {
  const githubModels = getModels("github-copilot").map((model) => model.id);
  expect(githubModels.length).toBeGreaterThan(0);
  expect(githubModels).toContain("gpt-4o");
  expect(githubModels).toContain("claude-sonnet-4.5");
});

test("resolves GitHub Copilot token from env vars", async () => {
  const originalCopilotToken = process.env.COPILOT_GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;
  const originalGithubToken = process.env.GITHUB_TOKEN;

  try {
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;

    process.env.GH_TOKEN = "gh-token-value";

    await expect(getApiKeyForProvider("github-copilot")).resolves.toBe("gh-token-value");
  } finally {
    if (originalCopilotToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = originalCopilotToken;

    if (originalGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalGhToken;

    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGithubToken;
  }
});