#!/usr/bin/env bun

/**
 * NakedClaw CLI entry point.
 *
 * Usage:
 *   nakedclaw              — chat with the agent (default)
 *   nakedclaw setup        — configure credentials
 *   nakedclaw connect <ch> — connect a channel (whatsapp, telegram, slack)
 *   nakedclaw start        — start daemon in background
 *   nakedclaw stop         — stop daemon
 *   nakedclaw restart      — restart daemon
 *   nakedclaw status       — show daemon status
 *   nakedclaw logs         — show daemon logs
 */

const [subcommand, ...restArgs] = process.argv.slice(2);

switch (subcommand || "chat") {
  case "chat": {
    await import("./cli/chat.ts");
    break;
  }

  case "setup": {
    await import("./cli/setup.ts");
    break;
  }

  case "connect": {
    await import("./cli/connect.ts");
    break;
  }

  case "start": {
    const { startDaemon } = await import("./cli/daemon-ctl.ts");
    await startDaemon({ verbose: restArgs.includes("--verbose") || restArgs.includes("-v") });
    break;
  }

  case "stop": {
    const { stopDaemon } = await import("./cli/daemon-ctl.ts");
    await stopDaemon();
    break;
  }

  case "restart": {
    const { restartDaemon } = await import("./cli/daemon-ctl.ts");
    await restartDaemon({ verbose: restArgs.includes("--verbose") || restArgs.includes("-v") });
    break;
  }

  case "status": {
    const { showStatus } = await import("./cli/daemon-ctl.ts");
    await showStatus();
    break;
  }

  case "logs": {
    const { showLogs } = await import("./cli/daemon-ctl.ts");
    const follow = restArgs.includes("--follow") || restArgs.includes("-f");
    const linesFlag = restArgs.find((arg) => arg.startsWith("--lines="));
    const lines = linesFlag ? parseInt(linesFlag.split("=")[1] || "", 10) : undefined;
    await showLogs({ follow, lines: isNaN(lines as number) ? undefined : lines });
    break;
  }

  case "sessions": {
    await import("./cli/sessions.ts");
    break;
  }

  case "models": {
    const { handleModelsCli } = await import("./cli/models.ts");
    await handleModelsCli(process.argv.slice(3));
    break;
  }

  case "skills": {
    const { handleSkillsCli } = await import("./cli/skills.ts");
    await handleSkillsCli(process.argv.slice(3));
    break;
  }

  case "help":
  case "--help":
  case "-h": {
    console.log(`
Usage: nakedclaw [command]

Commands:
  (none)        Chat with the agent (connects to daemon)
  setup         Configure credentials (Anthropic or OpenAI)
  connect <ch>  Connect a channel (whatsapp/wa, telegram/tg, slack)
  models        Interactive model/provider picker
  start         Start the daemon in background (use --verbose for extra logs)
  stop          Stop the daemon
  restart       Restart the daemon (use --verbose for extra logs)
  status        Show daemon status
  logs          Show daemon logs (use -f/--follow, --lines=N)
  sessions      Interactive session browser (TUI)
  skills        List, sync, or install skills
  help          Show this help
`);
    break;
  }

  default: {
    console.error(`Unknown command: ${subcommand}`);
    console.error("Run 'nakedclaw help' for usage.");
    process.exit(1);
  }
}
