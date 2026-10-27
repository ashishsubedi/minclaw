import { existsSync } from "fs";
import { join } from "path";
import JSON5 from "json5";
import { getStateDir } from "../auth/credentials.ts";
import { SOCKET_FILENAME } from "../daemon/protocol.ts";
import {
  getAllToolExtensions,
  getToolExtension,
  loadExternalToolExtensions,
  type ToolExtension,
} from "../extensions/tools-registry.ts";
import { executeTool, type ToolContext } from "../tools.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export type ParsedToolCliArgs = {
  command?: "list" | "call" | "help";
  toolName?: string;
  args: Record<string, any>;
  sessionKey?: string;
  directInProcess?: boolean;
};

const NUMERIC_KEYS = new Set([
  "limit",
  "timeout",
  "maxresults",
  "maxlines",
  "maxsize",
  "keeprecentturns",
]);

/**
 * Intelligently parse key=value CLI arguments and flags.
 * - Coerces "true"/"false" to boolean
 * - Coerces numeric strings to numbers for limit/timeout/maxResults (and similar numeric params)
 * - Keeps string values otherwise (stripping outer quotes if needed)
 * - Merges with --json if provided
 */
export function parseCliToolArgs(rawArgs: string[]): ParsedToolCliArgs {
  if (rawArgs.length === 0) {
    return { command: "help", args: {} };
  }

  const first = rawArgs[0];
  if (first === "help" || first === "--help" || first === "-h") {
    return { command: "help", args: {} };
  }

  if (first === "list" || first === "ls") {
    return { command: "list", args: {} };
  }

  let toolName: string | undefined;
  let tokens: string[] = [];

  if (first === "call") {
    toolName = rawArgs[1];
    tokens = rawArgs.slice(2);
  } else {
    toolName = first;
    tokens = rawArgs.slice(1);
  }

  if (toolName === "--help" || toolName === "-h") {
    return { command: "help", args: {} };
  }

  if (tokens.some((t) => t === "--help" || t === "-h")) {
    return { command: "help", toolName, args: {} };
  }

  let sessionKey: string | undefined;
  let directInProcess = false;
  let jsonArgs: Record<string, any> = {};
  const keyValueArgs: Record<string, any> = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "--direct" || token === "--in-process" || token === "-d") {
      directInProcess = true;
      continue;
    }

    if (token === "--session" || token === "-s") {
      sessionKey = tokens[++i];
      continue;
    }
    if (token.startsWith("--session=")) {
      sessionKey = token.slice("--session=".length);
      continue;
    }

    if (token === "--json") {
      const rawJson = tokens[++i];
      if (rawJson) {
        try {
          jsonArgs = JSON5.parse(rawJson);
        } catch {
          try {
            jsonArgs = JSON.parse(rawJson);
          } catch (err: any) {
            console.warn(`[tool-ctl] Failed to parse --json argument: ${err.message}`);
          }
        }
      }
      continue;
    }
    if (token.startsWith("--json=")) {
      const rawJson = token.slice("--json=".length);
      try {
        jsonArgs = JSON5.parse(rawJson);
      } catch {
        try {
          jsonArgs = JSON.parse(rawJson);
        } catch (err: any) {
          console.warn(`[tool-ctl] Failed to parse --json argument: ${err.message}`);
        }
      }
      continue;
    }

    // key=value or --key=value
    let cleanToken = token;
    if (cleanToken.startsWith("--")) {
      cleanToken = cleanToken.slice(2);
    }

    const eqIdx = cleanToken.indexOf("=");
    if (eqIdx > 0) {
      const key = cleanToken.slice(0, eqIdx).trim();
      let val = cleanToken.slice(eqIdx + 1).trim();

      // Strip outer double or single quotes if present
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }

      // Boolean coercion
      if (val.toLowerCase() === "true") {
        keyValueArgs[key] = true;
      } else if (val.toLowerCase() === "false") {
        keyValueArgs[key] = false;
      } else if (NUMERIC_KEYS.has(key.toLowerCase()) && /^-?\d+(\.\d+)?$/.test(val)) {
        keyValueArgs[key] = Number(val);
      } else {
        keyValueArgs[key] = val;
      }
    }
  }

  const mergedArgs = { ...jsonArgs, ...keyValueArgs };

  return {
    command: "call",
    toolName,
    args: mergedArgs,
    sessionKey,
    directInProcess,
  };
}

/**
 * Format and list all registered tool extensions.
 */
export function formatToolList(): string {
  loadExternalToolExtensions();
  const extensions = getAllToolExtensions();

  const lines: string[] = [
    `${BOLD}${CYAN}Registered MinClaw Tools (${extensions.length}):${RESET}\n`,
  ];

  for (const ext of extensions) {
    const name = ext.tool.name;
    const desc = ext.tool.description || "(No description)";
    const usage = ext.cliUsage || `minclaw tool call ${name}`;

    lines.push(`  ${BOLD}${GREEN}${name}${RESET}`);
    lines.push(`    ${DIM}${desc}${RESET}`);
    lines.push(`    ${YELLOW}Usage:${RESET} ${usage}\n`);
  }

  return lines.join("\n");
}

function showHelp(): string {
  return `
${BOLD}${CYAN}MinClaw Tool Extension Controller${RESET}

${BOLD}Usage:${RESET}
  minclaw tool list                             List all registered tools and CLI usage
  minclaw tool call <name> [key=value ...]      Call a tool extension with arguments
  minclaw tool <name> [key=value ...]           Shorthand syntax to call a tool

${BOLD}Options:${RESET}
  --session, -s <sessionKey>                    Target session key (default: 'terminal:cli')
  --direct, -d                                  Execute directly in-process (bypasses daemon socket)
  --json '<json>'                               JSON-encoded arguments object to merge
  --help, -h                                    Show this help

${BOLD}Examples:${RESET}
  minclaw tool list
  minclaw tool call youtube action=play query="never gonna give you up" browser="Firefox"
  minclaw tool youtube action=search query="ambient space music" limit=5
  minclaw tool session_reset --session terminal:voice_macbook
  minclaw tool shell command="uptime"
`;
}

/**
 * Attempt to execute tool call over the MinClaw daemon Unix socket.
 * Returns handled=true if daemon processed the request.
 */
async function callToolViaDaemon(
  toolName: string,
  toolArgs: Record<string, any>,
  sessionKey?: string,
  timeoutMs = 15000
): Promise<{ handled: boolean; output: string; isError: boolean }> {
  const sockPath = join(getStateDir(), SOCKET_FILENAME);
  if (!existsSync(sockPath)) {
    return { handled: false, output: "", isError: false };
  }

  return new Promise((resolve) => {
    let resolved = false;
    let buffer = "";

    const finish = (result: { handled: boolean; output: string; isError: boolean }) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        try {
          socket?.end();
        } catch {}
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      finish({ handled: false, output: "Daemon socket request timed out", isError: true });
    }, timeoutMs);

    let socket: any;
    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          socket = s;
          const msg =
            JSON.stringify({
              type: "tool_call",
              tool: toolName,
              args: toolArgs,
              sessionKey,
            }) + "\n";
          s.write(msg);
        },
        data(_s, raw) {
          buffer += Buffer.from(raw).toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const res = JSON.parse(line.trim());
              if (res.type === "tool_response") {
                finish({
                  handled: true,
                  output: res.output ?? "",
                  isError: Boolean(res.isError),
                });
                return;
              } else if (res.type === "error") {
                // If daemon reports unsupported/unknown message type, fall back to in-process
                if (/unsupported|unknown|parse/i.test(res.message || "")) {
                  finish({ handled: false, output: res.message, isError: true });
                } else {
                  finish({ handled: true, output: res.message, isError: true });
                }
                return;
              }
            } catch {}
          }
        },
        close() {
          finish({ handled: false, output: "Socket closed without response", isError: false });
        },
        error(_socket, err) {
          finish({ handled: false, output: err.message, isError: false });
        },
      },
    }).catch(() => {
      finish({ handled: false, output: "Could not connect to daemon socket", isError: false });
    });
  });
}

export type HandleToolCliOptions = {
  noExit?: boolean;
  directInProcess?: boolean;
};

/**
 * Main entry point for `minclaw tool` CLI.
 */
export async function handleToolCli(
  rawArgs: string[],
  options: HandleToolCliOptions = {}
): Promise<{ output: string; isError: boolean }> {
  const parsed = parseCliToolArgs(rawArgs);

  if (parsed.command === "help" || !parsed.command) {
    if (parsed.toolName) {
      loadExternalToolExtensions();
      const ext = getToolExtension(parsed.toolName);
      if (ext) {
        const schema = ext.tool.parameters as any;
        const props = schema?.properties || {};
        const propLines = Object.entries(props).map(([k, v]: [string, any]) => {
          const typeStr = v.type || (v.anyOf ? "union" : "string");
          const descStr = v.description ? ` - ${v.description}` : "";
          return `    ${BOLD}${k}${RESET} (${typeStr})${descStr}`;
        });

        const helpLines = [
          `${BOLD}${CYAN}MinClaw Tool:${RESET} ${BOLD}${GREEN}${ext.tool.name}${RESET}`,
          `  ${ext.tool.description || "(No description)"}\n`,
          `  ${YELLOW}Usage:${RESET} ${ext.cliUsage || `minclaw tool call ${ext.tool.name}`}\n`,
        ];

        if (propLines.length > 0) {
          helpLines.push(`  ${BOLD}Parameters:${RESET}`);
          helpLines.push(propLines.join("\n"));
          helpLines.push("");
        }

        const helpText = helpLines.join("\n");
        console.log(helpText);
        if (!options.noExit) process.exit(0);
        return { output: helpText, isError: false };
      }
    }

    const helpText = showHelp();
    console.log(helpText);
    if (!options.noExit) process.exit(0);
    return { output: helpText, isError: false };
  }

  if (parsed.command === "list") {
    const listText = formatToolList();
    console.log(listText);
    if (!options.noExit) process.exit(0);
    return { output: listText, isError: false };
  }

  // parsed.command === "call"
  const toolName = parsed.toolName;
  if (!toolName) {
    const errText = `${RED}Error: Tool name is required.${RESET}\nRun 'minclaw tool list' to see available tools.`;
    console.error(errText);
    if (!options.noExit) process.exit(1);
    return { output: errText, isError: true };
  }

  // 1. First attempt to call via Daemon socket (if not explicitly forced in-process)
  if (!options.directInProcess && !parsed.directInProcess) {
    try {
      const daemonResult = await callToolViaDaemon(
        toolName,
        parsed.args,
        parsed.sessionKey
      );
      if (daemonResult.handled) {
        if (daemonResult.isError) {
          console.error(daemonResult.output);
        } else {
          console.log(daemonResult.output);
        }
        if (!options.noExit) process.exit(daemonResult.isError ? 1 : 0);
        return { output: daemonResult.output, isError: daemonResult.isError };
      }
    } catch {
      // Fallback to in-process execution below
    }
  }

  // 2. In-process fallback execution
  const sessionKey = parsed.sessionKey || "terminal:cli";
  const [channel, sender] = sessionKey.includes(":")
    ? sessionKey.split(":")
    : ["terminal", sessionKey];

  const toolContext: ToolContext = {
    channel: channel || "terminal",
    sender: sender || "cli",
    reply: async (msg: string) => {
      console.log(msg);
    },
  };

  try {
    const result = await executeTool(toolName, parsed.args, toolContext);
    const output = result.content.map((c) => c.text).join("\n");

    if (result.isError) {
      console.error(output);
    } else {
      console.log(output);
    }

    if (!options.noExit) process.exit(result.isError ? 1 : 0);
    return { output, isError: result.isError };
  } catch (err: any) {
    const errText = `Failed to execute tool '${toolName}': ${err.message || String(err)}`;
    console.error(errText);
    if (!options.noExit) process.exit(1);
    return { output: errText, isError: true };
  }
}
