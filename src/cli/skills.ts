import { loadCachedCatalog, loadSkillByName, syncCatalog } from "../skills/catalog.ts";
import { checkEligibility, getSkillStatuses } from "../skills/eligibility.ts";
import { installSkillByName, installSkillFromClawhub } from "../skills/installer.ts";

/**
 * CLI handler for: minclaw skills [list|sync|install <name>|info <name>]
 */
export async function handleSkillsCli(args: string[]): Promise<void> {
  const [action, ...rest] = args;

  switch (action) {
    case "sync": {
      try {
        const entries = await syncCatalog();
        console.log(`Synced ${entries.length} skills from openclaw catalog.`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`Sync failed: ${errMsg}`);
        process.exit(1);
      }
      break;
    }

    case "install": {
      const parsed = parseInstallArgs(rest);
      if (!parsed.name) {
        console.error(
          "Usage: minclaw skills install <name> [spec-id] [--clawhub | --source clawhub] [--version <ver>]"
        );
        process.exit(1);
      }

      const result =
        parsed.source === "clawhub"
          ? await installSkillFromClawhub(parsed.name, parsed.version)
          : await installSkillByName(parsed.name, parsed.specId);

      if (result.ok) {
        console.log(result.message);
      } else {
        console.error(result.message);
        if (parsed.source !== "clawhub" && /not found/i.test(result.message)) {
          console.error("Tip: try --clawhub to install from ClawHub.");
        }
        process.exit(1);
      }
      break;
    }

    case "info": {
      const name = rest[0];
      if (!name) {
        console.error("Usage: minclaw skills info <name>");
        process.exit(1);
      }
      const entry = loadSkillByName(name);
      if (!entry) {
        console.error(`Skill "${name}" not found. Run "minclaw skills sync" first.`);
        process.exit(1);
      }
      const status = checkEligibility(entry);
      console.log(`${status.emoji || ""} ${status.name}`);
      console.log(`  ${status.description}`);
      console.log(`  Eligible: ${status.eligible ? "yes" : "no"}`);
      if (status.missing.bins.length) {
        console.log(`  Missing bins: ${status.missing.bins.join(", ")}`);
      }
      if (status.missing.env.length) {
        console.log(`  Missing env: ${status.missing.env.join(", ")}`);
      }
      if (status.install?.length) {
        console.log(`  Install options:`);
        for (const inst of status.install) {
          console.log(`    - ${inst.label} (${inst.kind})`);
        }
      }
      break;
    }

    default: {
      let cached = loadCachedCatalog();
      if (cached.length === 0) {
        console.log("No skills cached. Syncing from openclaw...\n");
        try {
          cached = await syncCatalog();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`Sync failed: ${errMsg}`);
          process.exit(1);
        }
      }
      const statuses = getSkillStatuses(cached);
      const ready = statuses.filter((s) => s.eligible);
      const notReady = statuses.filter((s) => !s.eligible);

      console.log(`Skills (${ready.length} ready, ${notReady.length} available to install)\n`);

      console.log("READY:");
      for (const s of ready) {
        console.log(`  ${s.emoji || "\u2713"} ${s.name} \u2014 ${s.description}`);
      }

      console.log(`\nNOT INSTALLED (${notReady.length}):`);
      for (const s of notReady) {
        console.log(`  ${s.emoji || "\u2717"} ${s.name} \u2014 ${s.description}`);
        const missing: string[] = [];
        if (s.missing.bins.length) missing.push(`bins: ${s.missing.bins.join(", ")}`);
        if (s.missing.env.length) missing.push(`env: ${s.missing.env.join(", ")}`);
        if (missing.length) console.log(`    needs: ${missing.join("; ")}`);
        if (s.install?.length) {
          console.log(`    install: minclaw skills install ${s.name}`);
        }
      }
      break;
    }
  }
}

type InstallArgs = {
  name?: string;
  specId?: string;
  source: "openclaw" | "clawhub";
  version?: string;
};

function parseInstallArgs(args: string[]): InstallArgs {
  let source: InstallArgs["source"] = "openclaw";
  let version: string | undefined;
  const remaining: string[] = [];
  
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] || "";
    if (token === "--source" && args[i + 1]) {
      const next = args[i + 1];
      if (next === "clawhub") {
        source = "clawhub";
      }
      i += 1;
      continue;
    }
    if (token === "--clawhub") {
      source = "clawhub";
      continue;
    }
    if (token === "--version" && args[i + 1]) {
      version = args[i + 1];
      i += 1;
      continue;
    }

    remaining.push(token);
  }

  return {
    name: remaining[0],
    specId: remaining[1],
    source,
    version,
  };
}
