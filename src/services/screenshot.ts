import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolFailure } from "../util/errors.js";

/**
 * Screen capture so AI agents can SEE a running Defold game, not just its
 * logs. Implemented with OS-native tools: capturing the actual display (or a
 * region of it) is the only mechanism that works reliably and headlessly —
 * Defold exposes no screenshot API on the engine service or in core Lua, and
 * per-window capture-by-pid needs permissions/helpers that aren't portable.
 *
 * The agent workflow is two-step when precision matters: capture the whole
 * display to locate the game, then pass a `region` to zoom in on it.
 */

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureOptions {
  /** 1-based display index (macOS screencapture -D). Default: main display. */
  display?: number;
  /** Optional crop region in screen pixels. Overrides `display`. */
  region?: Region;
  /** Longest-side pixel cap for the returned image. */
  maxWidth: number;
  /** Encoding of the returned (downscaled) image. */
  format: "png" | "jpeg";
  /**
   * Absolute path to persist the full-resolution PNG to. When omitted, no
   * full-res file is kept — the working capture is deleted after encoding, so
   * screen contents never accumulate in the system temp directory.
   */
  savePngTo?: string;
}

export interface CaptureResult {
  /** Downscaled, encoded image bytes (per `format`). */
  data: Buffer;
  mimeType: string;
  /** Pixel size of the full-resolution capture. */
  fullWidth: number;
  fullHeight: number;
  /** Where the full-resolution PNG was persisted, if `savePngTo` was given. */
  savedPath?: string;
}

function run(cmd: string, args: string[], timeoutMs = 15000): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ToolFailure(`${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new ToolFailure(`Required tool '${cmd}' was not found on PATH.`));
      } else {
        reject(new ToolFailure(`${cmd} failed to start: ${err.message}`));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

async function pngDimensions(file: string): Promise<{ width: number; height: number }> {
  // PNG IHDR: width/height are big-endian uint32 at byte offsets 16 and 20.
  const fh = await readFile(file);
  if (fh.length < 24 || fh.toString("latin1", 1, 4) !== "PNG") {
    return { width: 0, height: 0 };
  }
  return { width: fh.readUInt32BE(16), height: fh.readUInt32BE(20) };
}

function validateRegion(r: Region): void {
  for (const [k, v] of Object.entries(r)) {
    if (!Number.isInteger(v) || v < 0) {
      throw new ToolFailure(`region.${k} must be a non-negative integer (got ${v}).`);
    }
  }
  if (r.width === 0 || r.height === 0) {
    throw new ToolFailure("region width and height must be greater than 0.");
  }
}

/** Capture on macOS via screencapture, then downscale/encode via sips. */
async function captureMac(opts: CaptureOptions): Promise<CaptureResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "defold-mcp-shot-"));
  const pngPath = path.join(dir, "capture.png");
  try {
    const args = ["-x"]; // no capture sound
    if (opts.region) {
      validateRegion(opts.region);
      const { x, y, width, height } = opts.region;
      args.push("-R", `${x},${y},${width},${height}`);
    } else if (opts.display !== undefined) {
      if (!Number.isInteger(opts.display) || opts.display < 1) {
        throw new ToolFailure("display must be an integer >= 1 (1 = main display).");
      }
      args.push("-D", String(opts.display));
    } else {
      args.push("-m"); // main display only
    }
    args.push("-t", "png", pngPath);

    const cap = await run("screencapture", args);
    let exists = false;
    let size = 0;
    try {
      const st = await stat(pngPath);
      exists = true;
      size = st.size;
    } catch {
      exists = false;
    }
    if (cap.code !== 0 || !exists || size < 1024) {
      throw new ToolFailure(
        "Screen capture failed or produced an empty image. The most common cause on macOS is a " +
          "missing Screen Recording permission: grant it to the application that launched this " +
          "server (System Settings → Privacy & Security → Screen Recording), then retry. " +
          (cap.stderr ? `(screencapture said: ${cap.stderr.trim()})` : "")
      );
    }

    const full = await pngDimensions(pngPath);

    // Downscale + encode the returned image with sips (built into macOS).
    const ext = opts.format === "jpeg" ? "jpg" : "png";
    const outPath = path.join(dir, `out.${ext}`);
    const sipsArgs = ["-s", "format", opts.format === "jpeg" ? "jpeg" : "png"];
    if (full.width > opts.maxWidth || full.height > opts.maxWidth) {
      sipsArgs.push("-Z", String(opts.maxWidth));
    }
    sipsArgs.push(pngPath, "--out", outPath);
    const enc = await run("sips", sipsArgs);
    if (enc.code !== 0) {
      throw new ToolFailure(`Failed to encode the screenshot with sips: ${enc.stderr.trim()}`);
    }
    const data = await readFile(outPath);

    // Persist the full-resolution PNG only if asked; otherwise nothing of the
    // screen contents is left on disk.
    let savedPath: string | undefined;
    if (opts.savePngTo) {
      await mkdir(path.dirname(opts.savePngTo), { recursive: true });
      await copyFile(pngPath, opts.savePngTo);
      savedPath = opts.savePngTo;
    }

    return {
      data,
      mimeType: opts.format === "jpeg" ? "image/jpeg" : "image/png",
      fullWidth: full.width,
      fullHeight: full.height,
      savedPath,
    };
  } finally {
    // Always remove the scratch directory (success or failure).
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function captureScreen(opts: CaptureOptions): Promise<CaptureResult> {
  switch (process.platform) {
    case "darwin":
      return captureMac(opts);
    case "linux":
      throw new ToolFailure(
        "Screenshot capture is not yet implemented on Linux. It is planned via grim (Wayland) / " +
          "maim or ImageMagick import (X11). Contributions welcome; on macOS it works today."
      );
    case "win32":
      throw new ToolFailure(
        "Screenshot capture is not yet implemented on Windows. It is planned via a PowerShell " +
          "System.Drawing capture. On macOS it works today."
      );
    default:
      throw new ToolFailure(`Screenshot capture is not supported on '${process.platform}'.`);
  }
}
