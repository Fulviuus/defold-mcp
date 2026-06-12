import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ToolFailure } from "./errors.js";

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ToolFailure(`Request to ${url} timed out after ${timeoutMs} ms`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolFailure(
      `Network request to ${url} failed (${msg}). Check your internet connection.`
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 15000): Promise<T> {
  const res = await fetchWithTimeout(url, timeoutMs, {
    headers: { Accept: "application/json", "User-Agent": "defold-mcp-server" },
  });
  if (!res.ok) {
    throw new ToolFailure(`GET ${url} returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchBuffer(url: string, timeoutMs = 60000): Promise<Buffer> {
  const res = await fetchWithTimeout(url, timeoutMs, {
    headers: { "User-Agent": "defold-mcp-server" },
  });
  if (!res.ok) {
    throw new ToolFailure(`GET ${url} returned HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Stream a (possibly large) file to disk atomically via a temp file. */
export async function downloadToFile(
  url: string,
  destPath: string,
  timeoutMs: number
): Promise<number> {
  const res = await fetchWithTimeout(url, timeoutMs, {
    headers: { "User-Agent": "defold-mcp-server" },
  });
  if (!res.ok || !res.body) {
    throw new ToolFailure(`Download failed: GET ${url} returned HTTP ${res.status}`);
  }
  await mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.download-${process.pid}`;
  try {
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      createWriteStream(tmpPath)
    );
    await rename(tmpPath, destPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new ToolFailure(`Download of ${url} failed mid-transfer: ${msg}`);
  }
  const { stat } = await import("node:fs/promises");
  return (await stat(destPath)).size;
}
