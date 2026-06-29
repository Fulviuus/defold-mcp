import { readFile } from "node:fs/promises";
import path from "node:path";
import { LOG_RING_CAPACITY } from "../constants.js";
import { ToolFailure } from "../util/errors.js";
import { RingBuffer, makeLineSplitter } from "./processes.js";

/**
 * Integration with the running Defold editor's local HTTP server (added in
 * Defold 1.13.0). The editor writes its port to `.internal/editor.port` in the
 * project root and exposes a streaming console endpoint at
 * `GET /console/stream` that emits editor + engine log lines as they happen —
 * explicitly intended for coding agents that run background processes.
 *
 * This complements defold_engine_logs: that taps the engine's TCP log socket
 * for games this server launches, while this observes the console of an
 * editor-driven build/run session.
 */

/** Read and validate the editor port from `.internal/editor.port`. */
export async function readEditorPort(root: string): Promise<number> {
  const portFile = path.join(root, ".internal", "editor.port");
  let text: string;
  try {
    text = await readFile(portFile, "utf8");
  } catch {
    throw new ToolFailure(
      `No running editor found for this project (${portFile} is missing). ` +
        "Open the project in the Defold editor (1.13.0+), which writes its HTTP port there. " +
        "For games launched by this server instead, use defold_engine_logs."
    );
  }
  const port = parseInt(text.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ToolFailure(`${portFile} did not contain a valid port (read: "${text.trim()}").`);
  }
  return port;
}

export interface EditorLogConnection {
  port: number;
  status: "connecting" | "connected" | "closed" | "error";
  error?: string;
  connectedAt?: number;
  logs: RingBuffer;
  abort: AbortController;
}

export class EditorLogManager {
  private connections = new Map<string, EditorLogConnection>();

  get(root: string): EditorLogConnection | undefined {
    return this.connections.get(root);
  }

  list(): Array<{ project: string; port: number; status: string; lines: number }> {
    return [...this.connections.entries()].map(([project, c]) => ({
      project,
      port: c.port,
      status: c.status,
      lines: c.logs.total,
    }));
  }

  /**
   * Open (or reuse) a streaming connection to the editor console for a
   * project. The HTTP stream is consumed in the background; lines accumulate
   * in a ring buffer for incremental reads.
   */
  connect(root: string, port: number): EditorLogConnection {
    const existing = this.connections.get(root);
    if (existing && (existing.status === "connected" || existing.status === "connecting")) {
      return existing;
    }
    const logs = existing?.logs ?? new RingBuffer(LOG_RING_CAPACITY);
    const abort = new AbortController();
    const conn: EditorLogConnection = { port, status: "connecting", logs, abort };
    this.connections.set(root, conn);

    const splitter = makeLineSplitter((line) => logs.push(line));
    void (async () => {
      try {
        const res = await fetch(`http://localhost:${port}/console/stream`, {
          signal: abort.signal,
          headers: { Accept: "text/plain", "User-Agent": "defold-mcp-server" },
        });
        if (!res.ok || !res.body) {
          conn.status = "error";
          conn.error = `editor /console/stream returned HTTP ${res.status}`;
          return;
        }
        conn.status = "connected";
        conn.connectedAt = Date.now();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) splitter.push(Buffer.from(value));
        }
        // Reached only on a clean end of stream (errors/aborts go to catch).
        splitter.flush();
        conn.status = "closed";
      } catch (err) {
        splitter.flush();
        if (abort.signal.aborted) {
          conn.status = "closed";
        } else {
          conn.status = "error";
          conn.error = err instanceof Error ? err.message : String(err);
        }
      }
    })();
    return conn;
  }

  disconnect(root: string): boolean {
    const conn = this.connections.get(root);
    if (!conn) return false;
    conn.abort.abort();
    conn.status = "closed";
    return true;
  }

  disconnectAll(): void {
    for (const conn of this.connections.values()) conn.abort.abort();
    this.connections.clear();
  }
}
