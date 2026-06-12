/**
 * End-to-end test of the Streamable HTTP transport mode: spawn the server
 * with --transport http, hit /health, and run real MCP calls through the
 * SDK's HTTP client transport.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { cp, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, "..", "dist", "index.js");

let proc;
let port;
let client;
let projectRoot;

before(async () => {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), "defold-mcp-http-"));
  await cp(path.join(here, "fixture"), projectRoot, { recursive: true });

  proc = spawn(process.execPath, [distEntry, "--transport", "http", "--port", "0"], {
    env: { ...process.env, DEFOLD_PROJECT_ROOT: projectRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 10000);
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      const m = /listening on http:\/\/[^:]+:(\d+)\/mcp/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(parseInt(m[1], 10));
      }
    });
    proc.on("exit", () => reject(new Error(`server exited early: ${buf}`)));
  });

  client = new Client({ name: "http-tests", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

after(async () => {
  await client?.close();
  proc?.kill("SIGTERM");
});

test("GET /health returns status JSON with CORS header and no sensitive fields", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const health = await res.json();
  assert.equal(health.name, "defold-mcp-server");
  assert.equal(health.transport, "http");
  assert.equal(health.tools, 25);
  // CORS-readable body must not leak paths or pids
  assert.equal(health.project_root_env, undefined);
  assert.equal(health.pid, undefined);
});

test("requests with a non-allowlisted Host header are rejected (DNS rebinding)", async () => {
  const { request } = await import("node:http");
  const status = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          Host: "evil.example.com",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }));
  });
  assert.equal(status, 403);
});

test("tools/list works over HTTP", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 25);
});

test("tool calls work over HTTP (defold_project_info)", async () => {
  const res = await client.callTool({
    name: "defold_project_info",
    arguments: { response_format: "json" },
  });
  const info = JSON.parse(res.content.map((c) => c.text ?? "").join("\n"));
  assert.equal(info.title, "Fixture Game");
});

test("concurrent requests are served (stateless mode)", async () => {
  const calls = Array.from({ length: 5 }, () =>
    client.callTool({ name: "defold_get_settings", arguments: { section: "display" } })
  );
  const results = await Promise.all(calls);
  for (const r of results) {
    assert.match(r.content.map((c) => c.text ?? "").join("\n"), /width = 1024/);
  }
});

test("GET /mcp is rejected with 405 in stateless mode", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(res.status, 405);
});

test("unknown paths return 404", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(res.status, 404);
});
