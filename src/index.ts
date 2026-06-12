#!/usr/bin/env node
/**
 * defold-mcp-server — MCP server for the Defold game engine.
 *
 * Tools cover the full local development loop:
 *  - project inspection & game.project editing
 *  - resource listing/parsing/creation and reference finding
 *  - bob builds, bundles and dependency resolution
 *  - running games with the dmengine dev binary and reading their logs
 *  - live engine control: hot reload, @system commands, log streaming
 *  - Defold API reference search
 *
 * Transports: stdio (default) or Streamable HTTP (--transport http).
 * All logging goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { runHttpServer } from "./http.js";
import { shutdown } from "./state.js";
import { registerBuildTools } from "./tools/build.js";
import { registerDocTools } from "./tools/docs.js";
import { registerEngineTools } from "./tools/engine.js";
import { registerProjectTools } from "./tools/project.js";
import { registerResourceTools } from "./tools/resources.js";
import { registerRunTools } from "./tools/run.js";
import { logLine } from "./util/log.js";

function printHelp(): void {
  process.stdout.write(
    `${SERVER_NAME} ${SERVER_VERSION}\n` +
      "MCP server for the Defold game engine.\n\n" +
      "Usage: defold-mcp-server [options]\n\n" +
      "Options:\n" +
      "  --transport stdio|http   Transport to use (default stdio)\n" +
      "  --host <host>            HTTP mode: host to bind (default 127.0.0.1)\n" +
      "  --port <port>            HTTP mode: port to bind (default 9810; 0 = random)\n" +
      "  --exit-with-parent       Shut down if the parent process dies (for GUI launchers)\n" +
      "  --version, -v            Print version and exit\n" +
      "  --help, -h               Print this help and exit\n\n" +
      "Environment variables:\n" +
      "  DEFOLD_PROJECT_ROOT   Default project root (directory containing game.project)\n" +
      "  DEFOLD_MCP_CACHE_DIR  Toolchain cache directory (default ~/.defold-mcp)\n" +
      "  DEFOLD_EMAIL          Default --email for bob resolve (private dependencies)\n" +
      "  DEFOLD_AUTH           Default --auth for bob resolve (private dependencies)\n" +
      "  JAVA_HOME             JDK used to run bob.jar\n\n" +
      "Example client configuration (Claude Code .mcp.json):\n" +
      '  { "mcpServers": { "defold": { "command": "node",\n' +
      '      "args": ["/path/to/defold-mcp/dist/index.js"],\n' +
      '      "env": { "DEFOLD_PROJECT_ROOT": "/path/to/your/game" } } } }\n'
  );
}

/**
 * Wrap registerTool so every call is logged to stderr with duration and
 * outcome — this feeds the desktop app's console and ops debugging.
 */
function instrumentToolLogging(server: McpServer): void {
  const original = server.registerTool.bind(server);
  type RegisterArgs = Parameters<typeof original>;
  (server as { registerTool: unknown }).registerTool = (...regArgs: RegisterArgs) => {
    const [name, config, cb] = regArgs as [string, RegisterArgs[1], (...a: unknown[]) => unknown];
    const wrapped = async (...cbArgs: unknown[]): Promise<unknown> => {
      const started = Date.now();
      try {
        const result = (await cb(...cbArgs)) as CallToolResult;
        const status = result?.isError ? "error" : "ok";
        let detail = "";
        if (result?.isError) {
          const firstText = result.content?.find((c) => c.type === "text") as
            | { type: "text"; text: string }
            | undefined;
          const firstLine = (firstText?.text ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
          if (firstLine) detail = ` — ${firstLine.slice(0, 200)}`;
        }
        logLine(`tool ${name} -> ${status} (${Date.now() - started} ms)${detail}`);
        return result;
      } catch (err) {
        logLine(`tool ${name} -> threw after ${Date.now() - started} ms: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    };
    return original(name, config, wrapped as Parameters<typeof original>[2]);
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  instrumentToolLogging(server);
  registerProjectTools(server);
  registerResourceTools(server);
  registerBuildTools(server);
  registerRunTools(server);
  registerEngineTools(server);
  registerDocTools(server);
  return server;
}

export const TOOL_COUNT = 25;

interface CliOptions {
  transport: "stdio" | "http";
  host: string;
  port: number;
  /** Shut down when the parent process dies (used by the desktop app). */
  exitWithParent: boolean;
}

function parseArgs(argv: string[]): CliOptions | "help" | "version" {
  const opts: CliOptions = {
    transport: (process.env.DEFOLD_MCP_TRANSPORT === "http" ? "http" : "stdio") as CliOptions["transport"],
    host: process.env.DEFOLD_MCP_HOST ?? "127.0.0.1",
    port: parseInt(process.env.DEFOLD_MCP_PORT ?? "9810", 10),
    exitWithParent: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        return "help";
      case "--version":
      case "-v":
        return "version";
      case "--transport": {
        const v = argv[++i];
        if (v !== "stdio" && v !== "http") {
          throw new Error(`Invalid --transport '${v}'. Use "stdio" or "http".`);
        }
        opts.transport = v;
        break;
      }
      case "--host":
        opts.host = argv[++i] ?? opts.host;
        break;
      case "--port": {
        const v = parseInt(argv[++i] ?? "", 10);
        if (!Number.isInteger(v) || v < 0 || v > 65535) {
          throw new Error(`Invalid --port '${argv[i]}'.`);
        }
        opts.port = v;
        break;
      }
      case "--exit-with-parent":
        opts.exitWithParent = true;
        break;
      default:
        throw new Error(`Unknown argument '${arg}'. Run with --help for usage.`);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  let opts: CliOptions | "help" | "version";
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (opts === "help") {
    printHelp();
    return;
  }
  if (opts === "version") {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }

  let closeTransports: () => Promise<void> = async () => {};
  let shuttingDown = false;
  const stop = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logLine("shutting down");
    try {
      await closeTransports();
      await shutdown();
    } finally {
      process.exit(code);
    }
  };
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));

  // Orphan protection: when the spawning app dies (crash, force-kill), this
  // process is reparented to init/launchd (ppid 1) — shut down instead of
  // squatting on the port. (Unix semantics; harmless elsewhere.)
  if (opts.exitWithParent) {
    setInterval(() => {
      if (process.ppid === 1) {
        logLine("parent process exited; shutting down");
        void stop(0);
      }
    }, 2000).unref();
  }

  if (opts.transport === "http") {
    const httpServer = await runHttpServer({
      host: opts.host,
      port: opts.port,
      createServer,
      toolCount: TOOL_COUNT,
    });
    closeTransports = () =>
      new Promise((resolve) => {
        httpServer.close(() => resolve());
        setTimeout(resolve, 2000);
      });
  } else {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logLine(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`);
    closeTransports = async () => {
      await server.close();
    };
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
