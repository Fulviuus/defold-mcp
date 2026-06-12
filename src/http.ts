/**
 * Streamable HTTP transport mode: lets the server run as a long-lived local
 * service that multiple MCP clients connect to at http://host:port/mcp.
 * Used by the Defold MCP desktop app; also usable standalone:
 *
 *   defold-mcp-server --transport http --host 127.0.0.1 --port 9810
 *
 * Stateless: each POST gets a fresh McpServer + transport pair (process-wide
 * state like running games and log connections lives in module singletons).
 * GET /health is a plain JSON status endpoint (CORS-enabled so GUIs can poll).
 */

import http from "node:http";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { logLine } from "./util/log.js";

const startedAt = Date.now();

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Health body is cross-origin readable (CORS *) so GUIs can poll it; keep it
// free of anything sensitive (no pid, no filesystem paths).
function healthBody(toolCount: number): string {
  return JSON.stringify({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transport: "http",
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    tools: toolCount,
  });
}

/**
 * Host-header allowlist for DNS-rebinding protection. Always enforced:
 * loopback binds allow the loopback forms; wider binds additionally allow
 * every local interface address (clients on the LAN connect via those).
 */
function buildAllowedHosts(host: string, port: number): string[] {
  const hosts = new Set<string>();
  const add = (h: string) => {
    const bracketed = h.includes(":") && !h.startsWith("[") ? `[${h}]` : h;
    hosts.add(bracketed);
    hosts.add(`${bracketed}:${port}`);
  };
  add("127.0.0.1");
  add("localhost");
  add("::1");
  if (!isLoopback(host)) {
    add(host);
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        add(addr.address);
      }
    }
  }
  return [...hosts];
}

export interface HttpServerOptions {
  host: string;
  port: number;
  createServer: () => McpServer;
  toolCount: number;
}

export function runHttpServer(opts: HttpServerOptions): Promise<http.Server> {
  const { host, port, createServer, toolCount } = opts;
  const loopback = isLoopback(host);
  // Updated to the real port once listening (port 0 = OS-assigned).
  let actualPort = port;

  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (url === "/health" || url.startsWith("/health?")) {
      res.writeHead(req.method === "OPTIONS" ? 204 : 200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      });
      res.end(req.method === "OPTIONS" ? undefined : healthBody(toolCount));
      return;
    }

    if (url === "/mcp" || url.startsWith("/mcp?")) {
      if (req.method !== "POST") {
        // Stateless mode: no SSE notification stream, no sessions to delete.
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed. POST JSON-RPC messages to /mcp." },
            id: null,
          })
        );
        return;
      }
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: true,
        allowedHosts: buildAllowedHosts(host, actualPort),
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        logLine(`http request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            })
          );
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: `Not found. Endpoints: POST /mcp (MCP), GET /health.` })
    );
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", (err) => {
      reject(
        new Error(
          `Could not listen on ${host}:${port}: ${err.message}. ` +
            "Is another instance already running on that port?"
        )
      );
    });
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      actualPort = typeof addr === "object" && addr ? addr.port : port;
      logLine(`listening on http://${host}:${actualPort}/mcp (health: /health)`);
      if (!loopback) {
        logLine(
          `WARNING: bound to non-loopback host '${host}' — the MCP endpoint is reachable from your network. ` +
            "Clients must connect via one of this machine's IP addresses (Host-header allowlist is enforced)."
        );
      }
      resolve(httpServer);
    });
  });
}
