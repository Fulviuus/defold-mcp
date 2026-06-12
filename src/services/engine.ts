import net from "node:net";
import { ENGINE_HTTP_TIMEOUT_MS, ENGINE_POST_MAX_BYTES, LOG_RING_CAPACITY } from "../constants.js";
import { ToolFailure } from "../util/errors.js";
import { fetchWithTimeout } from "../util/http.js";
import { RingBuffer, makeLineSplitter } from "./processes.js";

export interface EngineInfo {
  version?: string;
  platform?: string;
  sha1?: string;
  log_port?: number;
  [key: string]: unknown;
}

function baseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function connectionHint(host: string, port: number): string {
  return (
    `Could not reach the Defold engine service at ${baseUrl(host, port)}. ` +
    "Make sure a DEBUG build of the game is running (defold_run, or Build & Run from the editor). " +
    "The engine service listens on port 8001 by default; on devices use the device IP."
  );
}

export async function enginePing(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${baseUrl(host, port)}/ping`, ENGINE_HTTP_TIMEOUT_MS);
    return res.ok && (await res.text()).trim().toUpperCase().includes("PONG");
  } catch {
    return false;
  }
}

export async function engineInfo(host: string, port: number): Promise<EngineInfo> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${baseUrl(host, port)}/info`, ENGINE_HTTP_TIMEOUT_MS);
  } catch {
    throw new ToolFailure(connectionHint(host, port));
  }
  if (!res.ok) {
    throw new ToolFailure(`Engine service at ${baseUrl(host, port)} returned HTTP ${res.status} for /info.`);
  }
  try {
    const info = (await res.json()) as EngineInfo;
    if (typeof info.log_port === "string") info.log_port = parseInt(info.log_port, 10);
    return info;
  } catch {
    throw new ToolFailure(`Engine service at ${baseUrl(host, port)} returned a non-JSON /info response.`);
  }
}

/**
 * Post a DDF message to a named engine socket:
 * POST http://host:port/post/<socket>/<message_name> with a binary proto payload.
 */
export async function enginePost(
  host: string,
  port: number,
  socket: string,
  messageName: string,
  payload: Uint8Array
): Promise<void> {
  if (payload.byteLength > ENGINE_POST_MAX_BYTES) {
    throw new ToolFailure(
      `Engine message payload is ${payload.byteLength} bytes but the engine service accepts at most ` +
        `${ENGINE_POST_MAX_BYTES} bytes per request. Split the request (e.g. reload fewer resources at a time).`
    );
  }
  const url = `${baseUrl(host, port)}/post/${socket}/${messageName}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, ENGINE_HTTP_TIMEOUT_MS, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from(payload),
    });
  } catch {
    throw new ToolFailure(connectionHint(host, port));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ToolFailure(
      `Engine rejected POST ${url} with HTTP ${res.status}${text ? `: ${text.trim()}` : ""}. ` +
        "Check that the message name and target socket are valid for this engine version."
    );
  }
}

// ---------------------------------------------------------------------------
// Engine log streaming (TCP log service advertised as log_port in /info)
// ---------------------------------------------------------------------------

export interface LogConnection {
  host: string;
  port: number;
  status: "connecting" | "connected" | "closed" | "error";
  error?: string;
  connectedAt?: number;
  socket: net.Socket;
  logs: RingBuffer;
}

export class EngineLogManager {
  private connections = new Map<string, LogConnection>();

  private key(host: string, port: number): string {
    return `${host}:${port}`;
  }

  get(host: string, port: number): LogConnection | undefined {
    return this.connections.get(this.key(host, port));
  }

  list(): Array<{ target: string; status: string; lines: number }> {
    return [...this.connections.entries()].map(([target, c]) => ({
      target,
      status: c.status,
      lines: c.logs.total,
    }));
  }

  /**
   * Connect to the engine's TCP log service. The server replies "0 OK" on
   * accept and then streams raw log lines.
   */
  connect(host: string, port: number): LogConnection {
    const key = this.key(host, port);
    const existing = this.connections.get(key);
    if (existing && (existing.status === "connected" || existing.status === "connecting")) {
      return existing;
    }
    const logs = existing?.logs ?? new RingBuffer(LOG_RING_CAPACITY);
    const socket = net.connect({ host, port });
    const conn: LogConnection = { host, port, status: "connecting", socket, logs };
    this.connections.set(key, conn);

    let sawHandshake = false;
    const splitter = makeLineSplitter((line) => {
      if (!sawHandshake) {
        sawHandshake = true;
        if (/^\d+\s/.test(line)) {
          if (!line.startsWith("0")) {
            conn.status = "error";
            conn.error = `Log service refused connection: ${line}`;
            socket.destroy();
          }
          return; // handshake line is not a log line
        }
      }
      logs.push(line);
    });

    socket.setNoDelay(true);
    socket.on("connect", () => {
      conn.status = "connected";
      conn.connectedAt = Date.now();
    });
    socket.on("data", (d) => splitter.push(d));
    socket.on("error", (err) => {
      conn.status = "error";
      conn.error = err.message;
    });
    socket.on("close", () => {
      splitter.flush();
      if (conn.status !== "error") conn.status = "closed";
    });
    return conn;
  }

  disconnect(host: string, port: number): boolean {
    const conn = this.connections.get(this.key(host, port));
    if (!conn) return false;
    conn.socket.destroy();
    conn.status = "closed";
    return true;
  }

  disconnectAll(): void {
    for (const conn of this.connections.values()) conn.socket.destroy();
    this.connections.clear();
  }
}
