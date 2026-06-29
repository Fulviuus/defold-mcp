import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { resolveProjectRoot, resourceToAbsolute } from "../context.js";
import { captureScreen } from "../services/screenshot.js";
import { games } from "../state.js";
import { runTool } from "../util/errors.js";
import { projectRootParam } from "./shared.js";

export function registerScreenshotTools(server: McpServer): void {
  server.registerTool(
    "defold_screenshot",
    {
      title: "Screenshot the running game",
      description:
        "Capture a screenshot so you can SEE the running Defold game, returned as an image you can " +
        "look at (plus a saved PNG). Use this to visually verify rendering, layout, animations and " +
        "UI after a build / hot reload — the visual counterpart to defold_game_logs.\n\n" +
        "Mechanism: captures the display the game is on (Defold exposes no in-engine screenshot API). " +
        "For a precise shot of just the game, use the two-step workflow: capture the full display " +
        "first to locate the game window, then call again with a `region` to crop to it.\n\n" +
        "macOS requires Screen Recording permission for the app that launched this server (System " +
        "Settings → Privacy & Security → Screen Recording); the first capture fails with a clear " +
        "message until it is granted. Currently implemented on macOS; Linux/Windows return a clear " +
        "not-yet-implemented message.\n\n" +
        "Returns: the screenshot image, its dimensions, and the path of the saved full-resolution PNG.",
      inputSchema: {
        project_root: projectRootParam,
        display: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based display index to capture (1 = main display). Ignored if `region` is set."),
        region: z
          .object({
            x: z.number().int().min(0).describe("Left pixel coordinate on the screen."),
            y: z.number().int().min(0).describe("Top pixel coordinate on the screen."),
            width: z.number().int().min(1).describe("Crop width in pixels."),
            height: z.number().int().min(1).describe("Crop height in pixels."),
          })
          .optional()
          .describe("Crop to this screen region instead of a whole display (to isolate the game window)."),
        max_width: z
          .number()
          .int()
          .min(64)
          .max(4096)
          .default(1280)
          .describe("Longest-side pixel cap for the returned image (default 1280). The saved PNG is full-resolution."),
        format: z
          .enum(["jpeg", "png"])
          .default("jpeg")
          .describe('Returned image format: "jpeg" (smaller, default) or "png" (lossless).'),
        save_path: z
          .string()
          .optional()
          .describe("Project-relative path to also copy the full-resolution PNG to, e.g. \"/screenshot.png\"."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async (): Promise<CallToolResult> => {
        const root = await resolveProjectRoot(args.project_root);
        const running = games.status(root);

        // Resolve (and traversal/symlink-guard) the optional save path before capture.
        const savePngTo = args.save_path ? resourceToAbsolute(root, args.save_path) : undefined;

        const result = await captureScreen({
          display: args.display,
          region: args.region,
          maxWidth: args.max_width,
          format: args.format,
          savePngTo,
        });

        const savedNote = result.savedPath
          ? `Saved full-resolution PNG: ${result.savedPath}`
          : "Full-resolution PNG not kept (pass save_path to save one); the returned image is above.";

        const scope = args.region
          ? `region ${args.region.width}x${args.region.height} at (${args.region.x},${args.region.y})`
          : args.display !== undefined
            ? `display ${args.display}`
            : "main display";
        const gameNote = running?.running
          ? `A game launched by defold_run is running (pid ${running.pid}).`
          : "No game launched by defold_run for this project — capturing the screen anyway " +
            "(an editor-launched game on this display will still be visible).";

        const summary =
          `Screenshot of ${scope} — captured ${result.fullWidth}x${result.fullHeight}, ` +
          `returned ${args.format} at up to ${args.max_width}px.\n` +
          `${gameNote}\n${savedNote}\n` +
          (args.region
            ? ""
            : "Tip: if the game is only part of this image, call again with a `region` to crop to it.");

        return {
          content: [
            { type: "image", data: result.data.toString("base64"), mimeType: result.mimeType },
            { type: "text", text: summary },
          ],
        };
      })
  );
}
