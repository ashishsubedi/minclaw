import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";
import JSON5 from "json5";
import { getModels } from "@mariozechner/pi-ai";
import { loadConfig } from "../config.ts";
import { loadAllCredentials } from "../auth/credentials.ts";

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const CONFIG_PATH = resolve(import.meta.dir, "..", "..", "nakedclaw.json5");
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

/** Curated model lists per provider */
export const MODELS: Record<string, string[]> = {
  anthropic: [
    "claude-opus-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-0",
    "claude-sonnet-4-0",
  ],
  openai: [
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5",
    "gpt-5-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "o4-mini",
    "o3",
  ],
  "openai-codex": [
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
  ],
  "github-copilot": [],
  ollama: [],
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  "github-copilot": "GitHub Copilot",
  ollama: "Ollama",
};

const PROVIDERS_REQUIRING_CREDENTIALS = new Set(["anthropic", "openai", "openai-codex", "github-copilot"]);

function getSelectableModels(provider: string): string[] {
  if (provider === "github-copilot") {
    return getModels("github-copilot").map((model) => model.id);
  }
  return MODELS[provider] || [];
}

function normalizeOllamaBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_OLLAMA_BASE_URL;
  if (trimmed.endsWith("/v1")) return trimmed;
  return trimmed.endsWith("/") ? `${trimmed}v1` : `${trimmed}/v1`;
}

function toOllamaApiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "http://localhost:11434";
  if (trimmed.endsWith("/v1")) return trimmed.slice(0, -3);
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

type OllamaTagResponse = {
  models?: Array<{ name?: string }>;
};

async function fetchOllamaModels(baseUrl: string): Promise<string[] | null> {
  const apiBase = toOllamaApiBase(baseUrl);
  const url = `${apiBase}/api/tags`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as OllamaTagResponse;
    const names = (data.models || [])
      .map((m) => (m.name || "").trim())
      .filter((name) => name.length > 0);
    return names.length > 0 ? names : [];
  } catch {
    return null;
  }
}

function warnIfNoCredential(provider: string): void {
  if (!PROVIDERS_REQUIRING_CREDENTIALS.has(provider)) return;
  const store = loadAllCredentials();
  if (!store[provider]) {
    const label = PROVIDER_LABELS[provider] || provider;
    console.log(`${YELLOW}No credentials for ${label}. Run: ${CYAN}nakedclaw setup${RESET}`);
  }
}

export function updateConfigModel(provider: string, name: string, baseUrl?: string): void {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON5.parse(raw);
  config.model = { ...config.model, provider, name };
  if (baseUrl) {
    config.model.baseUrl = baseUrl;
  }

  // Write back as JSON5-ish (use JSON with 2-space indent — JSON is valid JSON5)
  writeFileSync(CONFIG_PATH, JSON5.stringify(config, null, 2) + "\n", "utf-8");
}

function showCurrentModel(): void {
  const config = loadConfig();
  const provider = config.model.provider || "anthropic";
  const label = PROVIDER_LABELS[provider] || provider;
  console.log(`\n${DIM}Current model:${RESET} ${BOLD}${label}/${config.model.name}${RESET}\n`);
}

async function setModel(spec: string): Promise<void> {
  const slash = spec.indexOf("/");
  if (slash === -1) {
    console.error(`Invalid format. Use: ${CYAN}nakedclaw models set <provider>/<model>${RESET}`);
    console.error(`Example: ${CYAN}nakedclaw models set openai/gpt-5${RESET}`);
    process.exit(1);
  }

  const provider = spec.slice(0, slash);
  const name = spec.slice(slash + 1);

  if (!MODELS[provider]) {
    console.error(`Unknown provider: ${provider}`);
    console.error(`Available: ${Object.keys(MODELS).join(", ")}`);
    process.exit(1);
  }

  const availableModels = getSelectableModels(provider);
  if (provider !== "ollama" && availableModels.length > 0 && !availableModels.includes(name)) {
    console.error(`Unknown model for ${provider}: ${name}`);
    console.error(`Available: ${availableModels.join(", ")}`);
    process.exit(1);
  }

  if (provider === "ollama") {
    const config = loadConfig();
    const baseUrl = normalizeOllamaBaseUrl(config.model.baseUrl || DEFAULT_OLLAMA_BASE_URL);
    updateConfigModel(provider, name, baseUrl);
  } else {
    updateConfigModel(provider, name);
  }
  const label = PROVIDER_LABELS[provider] || provider;
  console.log(`${GREEN}Model set to ${BOLD}${label}/${name}${RESET}`);
  warnIfNoCredential(provider);
}

async function interactivePick(): Promise<void> {
  const config = loadConfig();
  const currentProvider = config.model.provider || "anthropic";
  const currentModel = config.model.name;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (msg: string): Promise<string> =>
    new Promise((resolve) => rl.question(msg, (a) => resolve(a.trim())));

  showCurrentModel();

  // Step 1: Pick provider
  const providers = Object.keys(MODELS);
  console.log("Select a provider:\n");
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i]!;
    const label = PROVIDER_LABELS[p] || p;
    const marker = p === currentProvider ? ` ${GREEN}(current)${RESET}` : "";
    console.log(`  ${BOLD}[${i + 1}]${RESET} ${label}${marker}`);
  }
  console.log();

  const providerChoice = await prompt("Provider (number): ");
  const providerIdx = parseInt(providerChoice, 10) - 1;
  if (isNaN(providerIdx) || providerIdx < 0 || providerIdx >= providers.length) {
    console.log("Invalid choice.");
    rl.close();
    return;
  }

  const selectedProvider = providers[providerIdx]!;
  const models = getSelectableModels(selectedProvider);

  if (selectedProvider === "ollama") {
    const defaultModel = selectedProvider === currentProvider ? currentModel : "";
    const defaultBaseUrl = normalizeOllamaBaseUrl(
      config.model.baseUrl || DEFAULT_OLLAMA_BASE_URL
    );
    const baseUrlInput = await prompt(`Base URL (${defaultBaseUrl}): `);
    const baseUrl = normalizeOllamaBaseUrl(baseUrlInput || defaultBaseUrl);

    const fetchedModels = await fetchOllamaModels(baseUrl);
    let selectedModel = "";

    if (fetchedModels === null) {
      console.log(`${YELLOW}Ollama not reachable at ${toOllamaApiBase(baseUrl)}.${RESET}`);
      console.log(`${DIM}Start Ollama or verify the Base URL, or enter a model name manually.${RESET}`);
    } else if (fetchedModels.length === 0) {
      console.log(`${YELLOW}No models found in Ollama. Pull a model first.${RESET}`);
    } else {
      console.log(`\nOllama models:\n`);
      for (let i = 0; i < fetchedModels.length; i++) {
        const m = fetchedModels[i] || "";
        const marker = m === currentModel && selectedProvider === currentProvider
          ? ` ${GREEN}(current)${RESET}` : "";
        console.log(`  ${BOLD}[${i + 1}]${RESET} ${m}${marker}`);
      }
      console.log(`  ${BOLD}[0]${RESET} Enter a model name manually`);
      console.log();

      const modelChoice = await prompt("Model (number): ");
      const modelIdx = parseInt(modelChoice, 10);
      if (!isNaN(modelIdx) && modelIdx > 0 && modelIdx <= fetchedModels.length) {
        selectedModel = fetchedModels[modelIdx - 1] || "";
      }
    }

    if (!selectedModel) {
      const modelPrompt = defaultModel ? `Model name (${defaultModel}): ` : "Model name: ";
      const modelInput = await prompt(modelPrompt);
      selectedModel = modelInput || defaultModel;
    }

    if (!selectedModel) {
      console.log("Model name is required.");
      rl.close();
      return;
    }

    updateConfigModel(selectedProvider, selectedModel, baseUrl);
    const label = PROVIDER_LABELS[selectedProvider] || selectedProvider;
    console.log(`\n${GREEN}Model set to ${BOLD}${label}/${selectedModel}${RESET}`);
    console.log(`${DIM}Restart the daemon for changes to take effect: ${CYAN}nakedclaw restart${RESET}`);
    rl.close();
    return;
  }

  // Step 2: Pick model
  console.log(`\n${PROVIDER_LABELS[selectedProvider] || selectedProvider} models:\n`);
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const marker = m === currentModel && selectedProvider === currentProvider
      ? ` ${GREEN}(current)${RESET}` : "";
    console.log(`  ${BOLD}[${i + 1}]${RESET} ${m}${marker}`);
  }
  console.log();

  const modelChoice = await prompt("Model (number): ");
  const modelIdx = parseInt(modelChoice, 10) - 1;
  if (isNaN(modelIdx) || modelIdx < 0 || modelIdx >= models.length) {
    console.log("Invalid choice.");
    rl.close();
    return;
  }

  const selectedModel = models[modelIdx]!;

  updateConfigModel(selectedProvider, selectedModel);
  const label = PROVIDER_LABELS[selectedProvider] || selectedProvider;
  console.log(`\n${GREEN}Model set to ${BOLD}${label}/${selectedModel}${RESET}`);
  warnIfNoCredential(selectedProvider);
  console.log(`${DIM}Restart the daemon for changes to take effect: ${CYAN}nakedclaw restart${RESET}`);

  rl.close();
}

export async function handleModelsCli(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (sub === "set") {
    const spec = rest[0];
    if (!spec) {
      console.error(`Usage: ${CYAN}nakedclaw models set <provider>/<model>${RESET}`);
      process.exit(1);
    }
    await setModel(spec);
  } else if (!sub) {
    await interactivePick();
  } else {
    console.error(`Unknown subcommand: ${sub}`);
    console.error(`Usage: ${CYAN}nakedclaw models${RESET} or ${CYAN}nakedclaw models set <provider>/<model>${RESET}`);
    process.exit(1);
  }
}

