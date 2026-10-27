import { loadCachedCatalog, syncCatalog } from "./catalog.ts";
import { checkEligibility, getSkillStatuses } from "./eligibility.ts";
import type { SkillEntry, SkillStatus } from "./types.ts";

/**
 * Load skills and build the prompt section for system prompt injection.
 * Shows ALL skills — ready ones with instructions, unavailable ones with what's needed.
 * Auto-syncs from GitHub if catalog is empty.
 */
export async function loadSkillsPrompt(): Promise<string> {
  let entries = loadCachedCatalog();

  // Auto-sync on first use if catalog is empty
  if (entries.length === 0) {
    try {
      entries = await syncCatalog();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[skills] Auto-sync failed: ${errMsg}`);
      return "";
    }
  }

  if (entries.length === 0) return "";

  const statuses = entries.map((e) => ({ entry: e, status: checkEligibility(e) }));
  return formatFullSkillsPrompt(statuses);
}

/**
 * Format ALL skills into the prompt — ready and not-ready.
 */
function formatFullSkillsPrompt(
  skills: { entry: SkillEntry; status: SkillStatus }[]
): string {
  const ready = skills.filter((s) => s.status.eligible);
  const notReady = skills.filter((s) => !s.status.eligible);

  let out = "## Skills Catalog\n\n";
  out += `${ready.length} ready, ${notReady.length} available to install.\n\n`;

  // Ready skills formatted compactly
  if (ready.length > 0) {
    const readyLines = ready
      .map(
        (s) =>
          `- **${s.entry.name}**: ${s.entry.description?.trim() || "No description"} (instructions: \`${s.entry.filePath}\`)`
      )
      .join("\n");

    out += `<ready_skills>\n${readyLines}\n</ready_skills>\n\n`;
  }

  // Not-ready skills — on-demand discovery directive instead of 32 verbose XML blocks
  if (notReady.length > 0) {
    const sampleSkills = notReady.slice(0, 8).map((s) => s.entry.name).join(", ");
    out += `### Additional Registry Skills\n`;
    out += `There are ${notReady.length} additional skills in the registry available to install on-demand (e.g. ${sampleSkills}, etc.).\n`;
    out += `If a user request matches an unlisted capability, run \`/skills\` to inspect or \`/skills install <name>\` to install it.\n\n`;
  }

  out += `When a user request matches a ready skill, read its SKILL.md for detailed instructions.`;

  return out;
}

/**
 * Get all skill statuses (for /skills command and CLI).
 * Auto-syncs if catalog is empty.
 */
export async function getAllSkillStatuses(): Promise<SkillStatus[]> {
  let cached = loadCachedCatalog();
  if (cached.length === 0) {
    try {
      cached = await syncCatalog();
    } catch {
      return [];
    }
  }
  return getSkillStatuses(cached);
}
