import type { Tool, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ToolContext } from "../tools.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { resolve, join } from "path";
import JSON5 from "json5";

export type ToolResult = { content: TextContent[]; isError: boolean };

export interface ToolExtension<TParams = any> {
  tool: Tool<any>;
  execute: (args: TParams, context?: ToolContext) => Promise<ToolResult> | ToolResult;
  cliUsage?: string; // Short 1-line CLI example for `minclaw tool list` and agy prompt
}

const registry = new Map<string, ToolExtension>();

export function registerToolExtension(ext: ToolExtension): void {
  registry.set(ext.tool.name, ext);
}

export function getToolExtension(name: string): ToolExtension | undefined {
  return registry.get(name);
}

export function getAllToolExtensions(): ToolExtension[] {
  return Array.from(registry.values());
}

export function getAllRegisteredTools(): Tool[] {
  return Array.from(registry.values()).map((ext) => ext.tool);
}

export function clearToolRegistry(): void {
  registry.clear();
}

/**
 * Discover external tool manifests in extensions/<dir>/tool.json5.
 * Enables drop-in tool extensions that execute standalone scripts or binaries.
 */
export function loadExternalToolExtensions(baseDir?: string): ToolExtension[] {
  const extensionsDir = baseDir || resolve(process.cwd(), "extensions");
  if (!existsSync(extensionsDir)) return [];

  const loaded: ToolExtension[] = [];

  try {
    const entries = readdirSync(extensionsDir);
    for (const entry of entries) {
      const extPath = join(extensionsDir, entry);
      try {
        if (!statSync(extPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const manifestPath = join(extPath, "tool.json5");
      if (!existsSync(manifestPath)) continue;

      try {
        const raw = readFileSync(manifestPath, "utf-8");
        const manifest = JSON5.parse(raw);
        if (!manifest || !manifest.name || !manifest.command) continue;

        const toolExt: ToolExtension = {
          tool: {
            name: manifest.name,
            description: manifest.description || `External tool extension: ${manifest.name}`,
            parameters: manifest.parameters || Type.Object({}),
          },
          cliUsage: manifest.cliUsage || `minclaw tool call ${manifest.name}`,
          execute: async (args: any, context?: ToolContext) => {
            const jsonArgs = JSON.stringify(args ?? {});
            const cmdParts = Array.isArray(manifest.command)
              ? manifest.command
              : manifest.command.split(" ");

            const proc = Bun.spawn(cmdParts, {
              cwd: extPath,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              env: {
                ...process.env,
                MINCLAW_TOOL_ARGS: jsonArgs,
                MINCLAW_TOOL_NAME: manifest.name,
                MINCLAW_CHANNEL: context?.channel || "",
                MINCLAW_SENDER: context?.sender || "",
              },
            });

            if (proc.stdin) {
              proc.stdin.write(jsonArgs);
              proc.stdin.end();
            }

            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
              return {
                content: [{ type: "text", text: stderr.trim() || stdout.trim() || `Command failed with code ${exitCode}` }],
                isError: true,
              };
            }

            return {
              content: [{ type: "text", text: stdout.trim() || "Success" }],
              isError: false,
            };
          },
        };

        registerToolExtension(toolExt);
        loaded.push(toolExt);
      } catch (err) {
        console.warn(`[tools-registry] Failed to load tool manifest at ${manifestPath}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[tools-registry] Failed to read extensions directory at ${extensionsDir}:`, err);
  }

  return loaded;
}
