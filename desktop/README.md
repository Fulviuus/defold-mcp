# Defold MCP — desktop app

Tauri app that manages the defold-mcp-server for AI coding agents:

- **Console** — live stream of everything the server does: every MCP tool call with
  duration and outcome, bob build output, dmengine logs, HTTP listener status.
- **Server control** — start/stop the server in Streamable HTTP mode on a chosen
  host/port (default `127.0.0.1:9810`). `0.0.0.0` is available for LAN setups but
  exposes the endpoint to your network; a Host-header allowlist (DNS-rebinding
  protection) is enforced on every bind, built from this machine's interface
  addresses.
- **Agent auto-configuration** — pick an agent from the dropdown and click Configure.
  The app merges a `defold` entry into that agent's own MCP config file (creating a
  `.defold-mcp.bak` backup first) so the agent connects to the managed server over
  HTTP — or spawns its own copy via stdio if you prefer.

Supported agents: Claude Code, Claude Desktop, OpenAI Codex CLI, Cursor, Gemini CLI,
VS Code (Copilot agent mode), Windsurf, Cline, Zed. Files that fail to parse (e.g.
JSONC settings with comments) are never modified — the app shows a paste-ready
snippet instead.

## Development

Prereqs: Rust toolchain (rustup), Node 18+. Build the server first
(`npm run build` in the repo root) so `dist/index.js` exists.

```bash
npm install
npm run dev     # launch the app in dev mode
npm run build   # produce installers/bundles under src-tauri/target/release/bundle
cd src-tauri && cargo test   # Rust unit tests (config writers, merging, backups)
```

Note: `Cargo.lock` pins the `time` crate to 0.3.47 — `cookie 0.18.1` (a transitive
Tauri dependency via `plist`) fails to compile against `time` 0.3.48. If you
regenerate the lockfile and hit error E0119 in `cookie`, re-pin with
`cargo update -p time --precise 0.3.47`.

## How it talks to the server

The MCP server is **embedded in the app**: `tauri dev`/`tauri build` first run
`npm run bundle:server` in the repo root, which esbuild-bundles the whole Node
server into a single `src-tauri/resources/server.cjs` (~900 KB) that ships inside
the bundle (`Contents/Resources` on macOS). At runtime the app resolves the entry
in this order:

1. a `server_entry` path set manually in the app's settings.json (power-user
   override, not exposed in the UI),
2. the embedded `server.cjs`,
3. the dev checkout's `dist/index.js` (when running from the repo).

The app spawns it with `node <entry> --transport http --host <h> --port <p>` and
`DEFOLD_PROJECT_ROOT`/`JAVA_HOME` from Settings, pipes stdout/stderr into the
console, polls `GET /health` for status, and SIGTERMs the process on stop/quit so
running games are shut down cleanly.

Node.js is the one external requirement (the server drives node tooling anyway);
a fully self-contained build (Node SEA / sidecar binary, no system Node) is a
possible next step if the app should run on machines without Node.
