import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProjectRoot } from "../context.js";
import { runBob } from "../services/bob.js";
import { engineInfo, enginePing, enginePost } from "../services/engine.js";
import { engineLogs } from "../state.js";
import { readLogPage } from "../services/processes.js";
import {
  encodeEmpty,
  encodeExit,
  encodeReboot,
  encodeReload,
  encodeSetUpdateFrequency,
  encodeSetVsync,
  encodeStartRecord,
} from "../util/protobuf.js";
import { ToolFailure, errorResult, runTool, textResult, toJson } from "../util/errors.js";
import { formatBobResult, preflightGameProject } from "./build.js";
import {
  hostParam,
  limitParam,
  normalizeResourcePath,
  portParam,
  projectRootParam,
  versionParam,
} from "./shared.js";

/** Map a source resource path to the compiled path the engine loads. */
export function compiledResourcePath(resourcePath: string): string {
  const p = normalizeResourcePath(resourcePath);
  const ext = path.posix.extname(p).toLowerCase();
  const special: Record<string, string> = {
    ".atlas": ".texturesetc",
    ".tilesource": ".texturesetc",
    ".png": ".texturec",
    ".jpg": ".texturec",
    ".jpeg": ".texturec",
    ".tga": ".texturec",
    ".wav": ".wavc",
    ".ogg": ".oggc",
    ".opus": ".opusc",
    ".font": ".fontc",
  };
  if (ext === "") return p;
  if (ext.endsWith("c") && /\.(scriptc|luac|goc|collectionc|guic|gui_scriptc|render_scriptc|texturesetc|texturec|materialc|fontc|particlefxc|tilemapc|wavc|oggc|opusc|spritec|labelc|modelc|soundc|collisionobjectc)$/.test(ext)) {
    return p; // already a compiled path
  }
  const replacement = special[ext] ?? ext + "c";
  return p.slice(0, -ext.length) + replacement;
}

const ENGINE_COMMANDS = [
  "reboot",
  "toggle_profile",
  "toggle_physics_debug",
  "start_record",
  "stop_record",
  "set_update_frequency",
  "set_vsync",
  "resume_rendering",
  "hide_app",
  "exit",
] as const;

export function registerEngineTools(server: McpServer): void {
  server.registerTool(
    "defold_engine_info",
    {
      title: "Query a running engine",
      description:
        "Ping the engine service of a running Defold game (debug builds expose an HTTP service, " +
        "default port 8001) and return its /info data: engine version, platform, sha1 and the TCP " +
        "log port. Works for games started with defold_run, from the Defold editor, or dev builds " +
        "on devices (pass the device IP as host).",
      inputSchema: {
        host: hostParam,
        port: portParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        const reachable = await enginePing(args.host, args.port);
        const info = await engineInfo(args.host, args.port);
        return textResult(
          toJson({ target: `${args.host}:${args.port}`, ping: reachable ? "PONG" : "no response", info })
        );
      })
  );

  server.registerTool(
    "defold_hot_reload",
    {
      title: "Hot reload resources into the running game",
      description:
        "Hot reload changed resources into a running game without restarting it: compiles the " +
        "project with bob (unless build_first=false) and tells the engine to reload the compiled " +
        "resources via its HTTP service.\n\n" +
        'Pass SOURCE paths (e.g. ["/main/player.script"]); they are mapped to compiled paths ' +
        '("/main/player.scriptc") automatically. Works for scripts, gui scenes, collections (already ' +
        "loaded instances are not re-instantiated), atlases, textures, etc. Reloaded Lua scripts " +
        "re-run their code and then on_reload(self) is called for affected components.\n\n" +
        "The game must be a DEBUG build running with its build output in sync with this project " +
        "(defold_run or editor Build & Run).",
      inputSchema: {
        project_root: projectRootParam,
        resources: z
          .array(z.string().min(1))
          .min(1)
          .max(50)
          .describe('Source resource paths to reload, e.g. ["/main/player.script"].'),
        build_first: z.boolean().default(true).describe("Compile the project before reloading (default true)."),
        version: versionParam,
        host: hostParam,
        port: portParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        if (args.build_first) {
          const preflight = await preflightGameProject(root);
          if (preflight) return errorResult(preflight);
          const build = await runBob(root, args.version, ["--variant", "debug", "build"]);
          if (!build.ok) {
            return errorResult(
              formatBobResult(build, "Build") + "\n\nHot reload skipped because the build failed."
            );
          }
        }
        const results: Array<{ resource: string; compiled: string; ok: boolean; error?: string }> = [];
        for (const r of args.resources) {
          const compiled = compiledResourcePath(r);
          try {
            await enginePost(args.host, args.port, "@resource", "reload", encodeReload([compiled]));
            results.push({ resource: normalizeResourcePath(r), compiled, ok: true });
          } catch (err) {
            results.push({
              resource: normalizeResourcePath(r),
              compiled,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const okCount = results.filter((r) => r.ok).length;
        const lines = [
          `Hot reload: ${okCount}/${results.length} resources posted to ${args.host}:${args.port}.`,
          "",
          ...results.map((r) => `- ${r.ok ? "✓" : "✗"} ${r.resource} -> ${r.compiled}${r.error ? ` — ${r.error}` : ""}`),
          "",
          "The engine logs a RESOURCE line for each successful reload (see defold_game_logs / defold_engine_logs). " +
            "If a script was reloaded, its on_reload(self) ran.",
        ];
        const text = lines.join("\n");
        return okCount === results.length ? textResult(text) : errorResult(text);
      })
  );

  server.registerTool(
    "defold_engine_command",
    {
      title: "Send a command to the running engine",
      description:
        "Send a @system command to a running debug build via the engine HTTP service.\n\n" +
        "Commands:\n" +
        "- toggle_profile: show/hide the on-screen profiler\n" +
        "- toggle_physics_debug: show/hide physics debug rendering\n" +
        "- set_update_frequency: set the frame cap (requires `frequency`)\n" +
        "- set_vsync: set swap interval (requires `swap_interval`)\n" +
        "- start_record / stop_record: record gameplay video to an .ivf file (start requires `file_name`)\n" +
        "- reboot: restart the engine with optional command-line args (`reboot_args`)\n" +
        "- resume_rendering / hide_app: window controls\n" +
        "- exit: terminate the game (uses `exit_code`, default 0)",
      inputSchema: {
        command: z.enum(ENGINE_COMMANDS).describe("Engine command to send."),
        host: hostParam,
        port: portParam,
        frequency: z.number().int().min(0).max(1000).optional().describe("Frame cap for set_update_frequency, e.g. 60. 0 = uncapped."),
        swap_interval: z.number().int().min(0).max(4).optional().describe("Swap interval for set_vsync (0 disables vsync wait)."),
        file_name: z.string().optional().describe("Output file for start_record, e.g. \"recording.ivf\"."),
        frame_period: z.number().int().min(1).default(2).describe("start_record: write every Nth frame (default 2)."),
        fps: z.number().int().min(1).default(30).describe("start_record: playback fps metadata (default 30)."),
        exit_code: z.number().int().min(0).max(255).default(0).describe("Exit code for the exit command."),
        reboot_args: z
          .array(z.string())
          .max(6)
          .default([])
          .describe('Up to 6 engine args for reboot, e.g. ["--config=bootstrap.main_collection=/x.collectionc", "build/default/game.projectc"].'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        let payload: Uint8Array;
        switch (args.command) {
          case "set_update_frequency":
            if (args.frequency === undefined) {
              throw new ToolFailure("set_update_frequency requires `frequency` (e.g. 60).");
            }
            payload = encodeSetUpdateFrequency(args.frequency);
            break;
          case "set_vsync":
            if (args.swap_interval === undefined) {
              throw new ToolFailure("set_vsync requires `swap_interval` (e.g. 1).");
            }
            payload = encodeSetVsync(args.swap_interval);
            break;
          case "start_record":
            if (!args.file_name) {
              throw new ToolFailure('start_record requires `file_name` (e.g. "recording.ivf").');
            }
            payload = encodeStartRecord(args.file_name, args.frame_period, args.fps);
            break;
          case "reboot":
            payload = encodeReboot(args.reboot_args);
            break;
          case "exit":
            payload = encodeExit(args.exit_code);
            break;
          default:
            payload = encodeEmpty();
        }
        await enginePost(args.host, args.port, "@system", args.command, payload);
        return textResult(
          `Sent ${args.command} to engine at ${args.host}:${args.port}.` +
            (args.command === "start_record"
              ? ` Recording to ${args.file_name} (relative to the game's working directory).`
              : "")
        );
      })
  );

  server.registerTool(
    "defold_engine_logs",
    {
      title: "Stream logs from a running engine",
      description:
        "Connect to the TCP log service of a running Defold debug build and read its log lines. " +
        "Unlike defold_game_logs (which only covers games launched by defold_run), this works for " +
        "ANY debug build: editor-launched games and games on devices.\n\n" +
        "Actions:\n" +
        '- "connect": discover the log port via the engine service /info and start capturing\n' +
        '- "read": return captured lines (offset/limit; negative offset = from the end)\n' +
        '- "status": list active log connections\n' +
        '- "disconnect": stop capturing\n\n' +
        "Lines are captured continuously while connected, so connect once and poll with read.",
      inputSchema: {
        action: z.enum(["connect", "read", "status", "disconnect"]).describe("What to do."),
        host: hostParam,
        port: portParam,
        log_port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe("Explicit TCP log port; default is discovered from the engine service /info."),
        offset: z.number().int().default(-100).describe("read: start line, negative = from end (default -100)."),
        limit: limitParam(100, 1000),
        filter: z.string().optional().describe("read: case-insensitive substring filter."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        if (args.action === "status") {
          const list = engineLogs.list();
          return textResult(
            list.length === 0
              ? "No engine log connections."
              : list.map((c) => `- ${c.target}: ${c.status} (${c.lines} lines captured)`).join("\n")
          );
        }

        const resolveLogPort = async (): Promise<number> => {
          if (args.log_port !== undefined) return args.log_port;
          const info = await engineInfo(args.host, args.port);
          const lp = typeof info.log_port === "number" ? info.log_port : NaN;
          if (!Number.isFinite(lp)) {
            throw new ToolFailure(
              "The engine /info response did not include a log_port. Pass log_port explicitly."
            );
          }
          return lp;
        };

        if (args.action === "connect") {
          const logPort = await resolveLogPort();
          const conn = engineLogs.connect(args.host, logPort);
          await new Promise((r) => setTimeout(r, 400));
          return textResult(
            `Log connection to ${args.host}:${logPort}: ${conn.status}` +
              (conn.error ? ` (${conn.error})` : "") +
              `. ${conn.logs.total} lines captured so far. Use action="read" to fetch lines.`
          );
        }

        // read / disconnect need an existing connection (or a discoverable port)
        let conn = args.log_port !== undefined ? engineLogs.get(args.host, args.log_port) : undefined;
        if (!conn) {
          const all = engineLogs.list().filter((c) => c.target.startsWith(`${args.host}:`));
          if (all.length === 1) {
            const port = parseInt(all[0].target.split(":").pop() ?? "", 10);
            conn = engineLogs.get(args.host, port);
          } else if (all.length > 1) {
            throw new ToolFailure(
              `Multiple log connections for ${args.host}; pass log_port. Active: ${all.map((c) => c.target).join(", ")}`
            );
          }
        }
        if (!conn) {
          throw new ToolFailure(
            `No log connection for ${args.host}. Use action="connect" first.`
          );
        }

        if (args.action === "disconnect") {
          engineLogs.disconnect(conn.host, conn.port);
          return textResult(`Disconnected log stream ${conn.host}:${conn.port} (${conn.logs.total} lines captured).`);
        }

        // read
        const { lines, start, total } = readLogPage(conn.logs, args.offset, args.limit, args.filter);
        return textResult(
          [
            `${conn.host}:${conn.port} (${conn.status}) — lines ${start}..${start + lines.length} of ${total}` +
              (args.filter ? ` (filtered by "${args.filter}")` : ""),
            "```",
            ...lines,
            "```",
          ].join("\n")
        );
      })
  );
}
