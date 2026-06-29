import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProjectRoot } from "../context.js";
import { readEditorPort } from "../services/editor.js";
import { readLogPage } from "../services/processes.js";
import { editorLogs } from "../state.js";
import { ToolFailure, runTool, textResult } from "../util/errors.js";
import { limitParam, projectRootParam } from "./shared.js";

export function registerEditorTools(server: McpServer): void {
  server.registerTool(
    "defold_editor_logs",
    {
      title: "Stream the Defold editor console",
      description:
        "Capture the console of a running Defold editor (1.13.0+) via its local HTTP server's " +
        "streaming endpoint (GET /console/stream). The editor's console aggregates BUILD output " +
        "and the running game's ENGINE logs, so this is the way to observe an editor-driven " +
        "Build & Run session — complementary to defold_game_logs/defold_engine_logs, which cover " +
        "games this server launches itself.\n\n" +
        "The editor's port is discovered automatically from `.internal/editor.port` (written by the " +
        "editor while a project is open); pass `port` to override.\n\n" +
        "Actions:\n" +
        '- "connect": discover the port and start capturing the console stream\n' +
        '- "read": return captured lines (offset/limit; negative offset = from the end; optional filter)\n' +
        '- "status": list active editor log connections\n' +
        '- "disconnect": stop capturing\n\n' +
        "Lines are captured continuously while connected, so connect once and poll with read.",
      inputSchema: {
        project_root: projectRootParam,
        action: z.enum(["connect", "read", "status", "disconnect"]).describe("What to do."),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe("Editor HTTP port; default is read from .internal/editor.port."),
        offset: z.number().int().default(-100).describe("read: start line, negative = from end (default -100)."),
        limit: limitParam(100, 1000),
        filter: z.string().optional().describe("read: case-insensitive substring filter, e.g. \"ERROR\"."),
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

        if (args.action === "status") {
          const list = editorLogs.list();
          return textResult(
            list.length === 0
              ? "No editor log connections."
              : list
                  .map((c) => `- ${c.project} (editor port ${c.port}): ${c.status} (${c.lines} lines captured)`)
                  .join("\n")
          );
        }

        if (args.action === "connect") {
          const port = args.port ?? (await readEditorPort(root));
          const conn = editorLogs.connect(root, port);
          await new Promise((r) => setTimeout(r, 500));
          if (conn.status === "error") {
            throw new ToolFailure(
              `Could not stream the editor console on port ${port}: ${conn.error ?? "unknown error"}. ` +
                "Confirm the Defold editor (1.13.0+) is running with this project open."
            );
          }
          return textResult(
            `Editor console stream for ${root} (port ${port}): ${conn.status}. ` +
              `${conn.logs.total} lines captured so far. Use action="read" to fetch lines.`
          );
        }

        const conn = editorLogs.get(root);
        if (!conn) {
          throw new ToolFailure(
            `No editor console stream for ${root}. Use action="connect" first.`
          );
        }

        if (args.action === "disconnect") {
          editorLogs.disconnect(root);
          return textResult(
            `Disconnected editor console stream for ${root} (${conn.logs.total} lines captured).`
          );
        }

        // read
        const { lines, start, total } = readLogPage(conn.logs, args.offset, args.limit, args.filter);
        return textResult(
          [
            `editor port ${conn.port} (${conn.status}) — lines ${start}..${start + lines.length} of ${total}` +
              (args.filter ? ` (filtered by "${args.filter}")` : ""),
            "```",
            ...lines,
            "```",
          ].join("\n")
        );
      })
  );
}
