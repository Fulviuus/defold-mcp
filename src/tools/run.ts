import { stat } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_ENGINE_PORT } from "../constants.js";
import { resolveProjectRoot } from "../context.js";
import { runBob } from "../services/bob.js";
import { engineInfo } from "../services/engine.js";
import { ensureDmengine } from "../services/toolchain.js";
import { games } from "../state.js";
import { ToolFailure, errorResult, runTool, textResult, toJson } from "../util/errors.js";
import { formatBobResult, preflightGameProject } from "./build.js";
import { limitParam, projectRootParam, responseFormatParam, versionParam } from "./shared.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerRunTools(server: McpServer): void {
  server.registerTool(
    "defold_run",
    {
      title: "Run the game locally",
      description:
        "Build (optionally) and launch the game locally with the dmengine dev binary. The process " +
        "runs in the background; stdout/stderr are captured and readable with defold_game_logs. " +
        "A debug build exposes the engine service (default port 8001) used by defold_hot_reload, " +
        "defold_engine_command and defold_engine_info.\n\n" +
        "One game per project root can run at a time; use defold_stop to stop it. " +
        "Returns pid, whether the process is still alive after the startup wait, the engine " +
        "service port parsed from the logs, and the first log lines.",
      inputSchema: {
        project_root: projectRootParam,
        version: versionParam,
        build_first: z.boolean().default(true).describe("Run a debug build before launching (default true)."),
        extra_engine_args: z
          .array(z.string())
          .default([])
          .describe('Extra dmengine arguments, e.g. ["--config=bootstrap.main_collection=/test/test.collectionc"].'),
        wait_seconds: z
          .number()
          .min(0)
          .max(15)
          .default(2.5)
          .describe("How long to wait before reporting startup status (default 2.5s)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        if (games.isRunning(root)) {
          const status = games.status(root);
          throw new ToolFailure(
            `A game for this project is already running (pid ${status?.pid}). ` +
              "Use defold_stop first, or defold_game_logs to inspect it."
          );
        }
        const engine = await ensureDmengine(args.version);
        if (args.build_first) {
          const preflight = await preflightGameProject(root);
          if (preflight) return errorResult(preflight);
          const build = await runBob(root, args.version, ["--variant", "debug", "build"]);
          if (!build.ok) {
            return errorResult(formatBobResult(build, "Pre-run build") + "\n\nGame was not launched.");
          }
        }
        const projectC = path.join(root, "build", "default", "game.projectc");
        try {
          await stat(projectC);
        } catch {
          throw new ToolFailure(
            `${projectC} not found. Build the project first (defold_build or build_first=true).`
          );
        }
        const proc = games.launch(
          root,
          engine.enginePath,
          [...args.extra_engine_args, path.join("build", "default", "game.projectc")],
          root
        );
        await sleep(args.wait_seconds * 1000);
        const status = games.status(root);
        const tail = proc.logs.slice(0, 40);

        // The engine prints e.g. "Engine service started on port 8001".
        let servicePort: number | undefined;
        for (const line of tail.lines) {
          const m = /Engine service started on port (\d+)/.exec(line);
          if (m) servicePort = parseInt(m[1], 10);
        }
        let serviceReachable = false;
        if (status?.running) {
          try {
            await engineInfo("localhost", servicePort ?? DEFAULT_ENGINE_PORT);
            serviceReachable = true;
          } catch {
            serviceReachable = false;
          }
        }

        const lines = [
          status?.running
            ? `Game launched (pid ${status.pid}) from ${root}.`
            : `Game process exited immediately (code ${status?.exitCode}). See logs below.`,
          `Engine binary: ${engine.enginePath} (${engine.platform}, Defold ${engine.resolved.version})`,
          servicePort !== undefined
            ? `Engine service: port ${servicePort}${serviceReachable ? " (reachable — hot reload available)" : ""}`
            : "Engine service port not seen in logs yet; default is 8001.",
          "",
          "## First log lines",
          "```",
          ...tail.lines,
          "```",
          "",
          "Use defold_game_logs to follow output, defold_stop to stop.",
        ];
        return status?.running ? textResult(lines.join("\n")) : errorResult(lines.join("\n"));
      })
  );

  server.registerTool(
    "defold_stop",
    {
      title: "Stop the running game",
      description:
        "Stop the game previously launched with defold_run for a project (SIGTERM, then SIGKILL " +
        "after a grace period). Reports the exit status and the last log lines.",
      inputSchema: {
        project_root: projectRootParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        const existing = games.get(root);
        if (!existing) {
          const others = games.list();
          throw new ToolFailure(
            `No game was launched for ${root} by this server.` +
              (others.length > 0
                ? ` Active/known processes: ${others.map((g) => `${g.key} (${g.running ? "running" : "exited"})`).join("; ")}`
                : "")
          );
        }
        const wasRunning = games.isRunning(root);
        const status = await games.stop(root);
        const tail = existing.logs.slice(-15, 15);
        return textResult(
          [
            wasRunning
              ? `Stopped game (pid ${status?.pid}, exit code ${status?.exitCode ?? "n/a"}, signal ${status?.signal ?? "none"}).`
              : `Game had already exited (code ${status?.exitCode ?? "n/a"}).`,
            "",
            "## Last log lines",
            "```",
            ...tail.lines,
            "```",
          ].join("\n")
        );
      })
  );

  server.registerTool(
    "defold_game_logs",
    {
      title: "Read game output",
      description:
        "Read stdout/stderr captured from a game launched with defold_run. Lines are numbered " +
        "with stable absolute offsets, so you can poll incrementally: read once, then pass " +
        "offset = previous start + count to get only new lines. Negative offset counts from the " +
        "end (offset=-100 returns the last 100 lines).\n\n" +
        "Also reports process status (running / exit code), so this doubles as a status check.",
      inputSchema: {
        project_root: projectRootParam,
        offset: z
          .number()
          .int()
          .default(-100)
          .describe("Absolute start line; negative counts from the end (default -100)."),
        limit: limitParam(100, 1000),
        filter: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter, e.g. "ERROR" or "SCRIPT".'),
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        const proc = games.get(root);
        if (!proc) {
          throw new ToolFailure(
            `No game has been launched for ${root} by this server. Use defold_run first. ` +
              "(For games started by the Defold editor, use defold_engine_logs instead.)"
          );
        }
        const status = games.status(root);
        let lines: string[];
        let start: number;
        let total: number;
        if (args.filter) {
          const needle = args.filter.toLowerCase();
          const everything = proc.logs.slice(proc.logs.firstRetained, proc.logs.total);
          const filtered = everything.lines.filter((l) => l.toLowerCase().includes(needle));
          total = filtered.length;
          start = args.offset < 0 ? Math.max(0, total + args.offset) : Math.min(args.offset, total);
          lines = filtered.slice(start, start + args.limit);
        } else {
          const page = proc.logs.slice(args.offset, args.limit);
          lines = page.lines;
          start = page.start;
          total = page.total;
        }
        const header =
          `Process: pid ${status?.pid}, ` +
          (status?.running
            ? `running for ${status.uptimeSeconds}s`
            : `exited (code ${status?.exitCode ?? "n/a"})`) +
          ` — log lines ${start}..${start + lines.length} of ${total}` +
          (args.filter ? ` (filtered by "${args.filter}")` : "");
        if (args.response_format === "json") {
          return textResult(toJson({ status, start, total, count: lines.length, lines }));
        }
        return textResult([header, "```", ...lines, "```"].join("\n"));
      })
  );
}
