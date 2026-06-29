/**
 * End-to-end tests: spawn the MCP server over stdio and exercise tools through
 * a real MCP client. Engine-facing tools are tested against a fake engine
 * HTTP service + TCP log service so no Defold installation is required.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, "..", "dist", "index.js");
const fixture = path.join(here, "fixture");

let client;
let projectRoot;
let cacheDir;

// --- fake engine service -----------------------------------------------------
const enginePosts = [];
let engineServer;
let enginePort;
let logServer;
let logPort;

function startFakeEngine() {
  return new Promise((resolve) => {
    logServer = net.createServer((socket) => {
      socket.write("0 OK\n");
      socket.write("INFO:DLIB: Log server started\n");
      socket.write("INFO:GAME: hello from fake engine\n");
      socket.write("WARNING:GAME: low health\n");
    });
    logServer.listen(0, "127.0.0.1", () => {
      logPort = logServer.address().port;
      engineServer = http.createServer((req, res) => {
        if (req.method === "GET" && req.url === "/ping") {
          res.end("PONG\n");
          return;
        }
        if (req.method === "GET" && req.url === "/info") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              version: "1.12.4",
              platform: "x86_64-macos",
              sha1: "402218d5544666871f07ecdfa21032a7fb59413f",
              log_port: logPort,
            })
          );
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/post/")) {
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => {
            enginePosts.push({ url: req.url, body: Buffer.concat(chunks) });
            res.end("");
          });
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      });
      engineServer.listen(0, "127.0.0.1", () => {
        enginePort = engineServer.address().port;
        resolve();
      });
    });
  });
}

// Fake Defold editor HTTP server exposing the 1.13.0 streaming console.
let editorServer;
let editorPort;
function startFakeEditor() {
  return new Promise((resolve) => {
    editorServer = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/console/stream") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("INFO:DLIB: Log server started on port 51990\n");
        res.write("INFO:ENGINE: Engine service started on port 51991\n");
        res.write("WARNING:BUILD: shader recompiled\n");
        // keep the connection open (a real stream stays connected)
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    // Editors bind localhost; bind the same so the tool's localhost URL resolves.
    editorServer.listen(0, "localhost", () => {
      editorPort = editorServer.address().port;
      resolve();
    });
  });
}

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function text(result) {
  return result.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

before(async () => {
  projectRoot = await mkdtemp(path.join(os.tmpdir(), "defold-mcp-proj-"));
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "defold-mcp-cache-"));
  await cp(fixture, projectRoot, { recursive: true });
  await startFakeEngine();
  await startFakeEditor();
  // Emulate the editor having written its discovery port file.
  await mkdir(path.join(projectRoot, ".internal"), { recursive: true });
  await writeFile(path.join(projectRoot, ".internal", "editor.port"), String(editorPort));

  client = new Client({ name: "defold-mcp-tests", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    env: {
      ...process.env,
      DEFOLD_PROJECT_ROOT: projectRoot,
      DEFOLD_MCP_CACHE_DIR: cacheDir,
    },
    stderr: "ignore",
  });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  engineServer?.close();
  logServer?.close();
  editorServer?.close();
});

// ---------------------------------------------------------------------------

test("lists all 27 tools with annotations", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.equal(tools.length, 27, `unexpected tool list: ${names.join(", ")}`);
  for (const expected of [
    "defold_project_info", "defold_get_settings", "defold_set_setting",
    "defold_list_dependencies", "defold_add_dependency", "defold_remove_dependency",
    "defold_list_resources", "defold_parse_resource", "defold_create_resource",
    "defold_find_references", "defold_setup", "defold_resolve_dependencies",
    "defold_build", "defold_bundle", "defold_clean", "defold_doctor",
    "defold_run", "defold_stop", "defold_game_logs", "defold_engine_info",
    "defold_hot_reload", "defold_engine_command", "defold_engine_logs",
    "defold_editor_logs", "defold_api_search", "defold_api_doc",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  for (const tool of tools) {
    assert.ok(tool.description?.length > 40, `${tool.name} has a weak description`);
    assert.ok(tool.annotations, `${tool.name} missing annotations`);
  }
});

test("defold_project_info returns project facts (json)", async () => {
  const res = await call("defold_project_info", { response_format: "json" });
  assert.ok(!res.isError, text(res));
  const info = JSON.parse(text(res));
  assert.equal(info.title, "Fixture Game");
  assert.equal(info.version, "1.2.3");
  assert.equal(info.main_collection, "/main/main.collectionc");
  assert.equal(info.display.width, "1024");
  assert.equal(info.dependencies.length, 1);
  assert.equal(info.resources_by_type.script, 2);
});

test("defold_get_settings: section and single key", async () => {
  const res = await call("defold_get_settings", { section: "display", key: "width" });
  assert.ok(!res.isError);
  assert.match(text(res), /width = 1024/);

  const missing = await call("defold_get_settings", { section: "physics" });
  assert.ok(missing.isError);
  assert.match(text(missing), /Available sections/);
});

test("defold_set_setting writes and preserves file structure", async () => {
  const res = await call("defold_set_setting", { section: "display", key: "width", value: "1920" });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /was: 1024/);
  const content = await readFile(path.join(projectRoot, "game.project"), "utf8");
  assert.match(content, /width = 1920/);
  assert.match(content, /^\[bootstrap\]/m);
  // restore
  await call("defold_set_setting", { section: "display", key: "width", value: "1024" });
});

test("defold_set_setting appends trailing c for compiled-resource keys", async () => {
  const res = await call("defold_set_setting", {
    section: "bootstrap",
    key: "main_collection",
    value: "/main/main.collection",
  });
  assert.ok(!res.isError, text(res));
  assert.match(text(res), /main_collection = \/main\/main\.collectionc/);
  assert.match(text(res), /trailing "c" was appended/);
  const content = await readFile(path.join(projectRoot, "game.project"), "utf8");
  assert.match(content, /main_collection = \/main\/main\.collectionc/);
});

test("dependency add / list / remove cycle", async () => {
  const url = "https://github.com/defold/extension-firebase/archive/refs/tags/1.0.0.zip";
  const add = await call("defold_add_dependency", { url });
  assert.ok(!add.isError, text(add));
  const list = await call("defold_list_dependencies", { response_format: "json" });
  const parsed = JSON.parse(text(list));
  assert.equal(parsed.dependencies.length, 2);
  assert.ok(parsed.dependencies.includes(url));
  const rm = await call("defold_remove_dependency", { url });
  assert.ok(!rm.isError, text(rm));
  const list2 = JSON.parse(text(await call("defold_list_dependencies", { response_format: "json" })));
  assert.equal(list2.dependencies.length, 1);
});

test("defold_list_resources filters by type", async () => {
  const res = await call("defold_list_resources", { type: "script", response_format: "json" });
  assert.ok(!res.isError, text(res));
  const page = JSON.parse(text(res));
  assert.equal(page.total, 2);
  const paths = page.items.map((i) => i.path).sort();
  assert.deepEqual(paths, ["/main/main.script", "/main/player.script"]);

  const bad = await call("defold_list_resources", { type: "spine_scene" });
  assert.ok(bad.isError);
  assert.match(text(bad), /Types present in this project/);
});

test("defold_parse_resource: collection with embedded instances", async () => {
  const res = await call("defold_parse_resource", { path: "/main/main.collection" });
  assert.ok(!res.isError, text(res));
  const parsed = JSON.parse(text(res));
  assert.equal(parsed.kind, "resource");
  assert.equal(parsed.data.name, "main");
  assert.equal(parsed.data.instances.prototype, "/main/player.go");
  assert.equal(parsed.data.embedded_instances.data.components.component, "/main/main.script");
});

test("defold_parse_resource: lua outline", async () => {
  const res = await call("defold_parse_resource", { path: "/main/player.script" });
  assert.ok(!res.isError, text(res));
  const outline = JSON.parse(text(res));
  assert.equal(outline.kind, "lua_outline");
  const fnNames = outline.functions.map((f) => f.name);
  assert.ok(fnNames.includes("init") && fnNames.includes("update") && fnNames.includes("on_message"));
  assert.ok(fnNames.includes("helper"));
  assert.deepEqual(outline.go_properties.map((p) => p.name), ["speed", "health"]);
  assert.deepEqual(outline.requires, ["main.utils"]);
  assert.ok(outline.messages_handled.includes("damage"));
  assert.ok(outline.messages_handled.includes("heal"));
});

test("defold_parse_resource: game.project", async () => {
  const res = await call("defold_parse_resource", { path: "/game.project" });
  const parsed = JSON.parse(text(res));
  assert.equal(parsed.kind, "game_project");
  assert.equal(parsed.sections.project.title, "Fixture Game");
});

test("defold_create_resource creates from template and refuses overwrite", async () => {
  const res = await call("defold_create_resource", { path: "/gen/enemy.script" });
  assert.ok(!res.isError, text(res));
  const created = await readFile(path.join(projectRoot, "gen", "enemy.script"), "utf8");
  assert.match(created, /function init\(self\)/);
  assert.match(created, /function on_message\(self, message_id, message, sender\)/);

  const again = await call("defold_create_resource", { path: "/gen/enemy.script" });
  assert.ok(again.isError);
  assert.match(text(again), /already exists/);

  const mismatch = await call("defold_create_resource", { path: "/gen/foo.script", template: "gui" });
  assert.ok(mismatch.isError);
});

test("defold_find_references finds component and require references", async () => {
  const res = await call("defold_find_references", { resource_path: "/main/player.script", response_format: "json" });
  const refs = JSON.parse(text(res));
  assert.ok(refs.references.some((r) => r.file === "/main/player.go"));

  const luaRefs = JSON.parse(
    text(await call("defold_find_references", { resource_path: "/main/utils.lua", response_format: "json" }))
  );
  assert.ok(luaRefs.references.some((r) => r.file === "/main/player.script" && r.matched === "main.utils"));
});

test("defold_clean reports when there is nothing to clean", async () => {
  const res = await call("defold_clean", {});
  assert.ok(!res.isError);
  assert.match(text(res), /Nothing to clean|Deleted/);
});

test("defold_doctor reports environment", async () => {
  const res = await call("defold_doctor", { response_format: "json" });
  assert.ok(!res.isError, text(res));
  const report = JSON.parse(text(res));
  assert.equal(report.project_root, projectRoot);
  assert.equal(report.cache_dir, cacheDir);
  assert.ok(report.node.startsWith("v"));
});

test("defold_game_logs errors helpfully when no game was launched", async () => {
  const res = await call("defold_game_logs", {});
  assert.ok(res.isError);
  assert.match(text(res), /defold_run/);
});

test("defold_stop errors helpfully when no game was launched", async () => {
  const res = await call("defold_stop", {});
  assert.ok(res.isError);
  assert.match(text(res), /No game was launched/);
});

// --- engine service tools against the fake engine ---------------------------

test("defold_engine_info queries /info", async () => {
  const res = await call("defold_engine_info", { host: "127.0.0.1", port: enginePort });
  assert.ok(!res.isError, text(res));
  const parsed = JSON.parse(text(res));
  assert.equal(parsed.ping, "PONG");
  assert.equal(parsed.info.version, "1.12.4");
  assert.equal(parsed.info.log_port, logPort);
});

test("defold_engine_info gives actionable error when engine is down", async () => {
  const res = await call("defold_engine_info", { host: "127.0.0.1", port: 1 });
  assert.ok(res.isError);
  assert.match(text(res), /DEBUG build|engine service/i);
});

test("defold_hot_reload posts protobuf reload messages (build_first=false)", async () => {
  enginePosts.length = 0;
  const res = await call("defold_hot_reload", {
    resources: ["/main/player.script", "/main/utils.lua"],
    build_first: false,
    host: "127.0.0.1",
    port: enginePort,
  });
  assert.ok(!res.isError, text(res));
  assert.equal(enginePosts.length, 2);
  assert.equal(enginePosts[0].url, "/post/@resource/reload");
  const expected = Buffer.from("/main/player.scriptc", "utf8");
  assert.deepEqual(enginePosts[0].body, Buffer.concat([Buffer.from([0x0a, expected.length]), expected]));
  assert.match(text(res), /2\/2 resources/);
});

test("defold_engine_command encodes and posts @system messages", async () => {
  enginePosts.length = 0;
  const res = await call("defold_engine_command", {
    command: "set_update_frequency",
    frequency: 60,
    host: "127.0.0.1",
    port: enginePort,
  });
  assert.ok(!res.isError, text(res));
  assert.equal(enginePosts[0].url, "/post/@system/set_update_frequency");
  assert.deepEqual(enginePosts[0].body, Buffer.from([0x08, 60]));

  const missing = await call("defold_engine_command", {
    command: "start_record",
    host: "127.0.0.1",
    port: enginePort,
  });
  assert.ok(missing.isError);
  assert.match(text(missing), /file_name/);

  const toggle = await call("defold_engine_command", {
    command: "toggle_profile",
    host: "127.0.0.1",
    port: enginePort,
  });
  assert.ok(!toggle.isError);
  assert.equal(enginePosts.at(-1).url, "/post/@system/toggle_profile");
  assert.equal(enginePosts.at(-1).body.length, 0);
});

test("defold_engine_logs connect/read/disconnect via discovered log_port", async () => {
  const conn = await call("defold_engine_logs", {
    action: "connect",
    host: "127.0.0.1",
    port: enginePort,
  });
  assert.ok(!conn.isError, text(conn));
  assert.match(text(conn), /connected/);

  const read = await call("defold_engine_logs", { action: "read", host: "127.0.0.1" });
  assert.ok(!read.isError, text(read));
  const body = text(read);
  assert.match(body, /hello from fake engine/);
  assert.match(body, /low health/);
  assert.ok(!body.includes("0 OK"), "handshake line should be stripped");

  const filtered = await call("defold_engine_logs", {
    action: "read", host: "127.0.0.1", filter: "warning",
  });
  assert.match(text(filtered), /low health/);
  assert.ok(!text(filtered).includes("hello from fake engine"));

  const disc = await call("defold_engine_logs", { action: "disconnect", host: "127.0.0.1" });
  assert.ok(!disc.isError);
});

test("defold_editor_logs streams the editor console via .internal/editor.port", async () => {
  const conn = await call("defold_editor_logs", { action: "connect" });
  assert.ok(!conn.isError, text(conn));
  assert.match(text(conn), /connected/);

  const read = await call("defold_editor_logs", { action: "read" });
  assert.ok(!read.isError, text(read));
  const body = text(read);
  assert.match(body, /Engine service started on port 51991/);
  assert.match(body, /shader recompiled/);
  assert.match(body, new RegExp(`editor port ${editorPort}`));

  const filtered = await call("defold_editor_logs", { action: "read", filter: "warning" });
  assert.match(text(filtered), /shader recompiled/);
  assert.ok(!text(filtered).includes("Engine service started"));

  const status = await call("defold_editor_logs", { action: "status" });
  assert.match(text(status), /editor port/);

  const disc = await call("defold_editor_logs", { action: "disconnect" });
  assert.ok(!disc.isError);
});

test("defold_editor_logs errors helpfully when no editor is running", async () => {
  const noEditor = await mkdtemp(path.join(os.tmpdir(), "defold-noeditor-"));
  await cp(fixture, noEditor, { recursive: true });
  const res = await call("defold_editor_logs", { action: "connect", project_root: noEditor });
  assert.ok(res.isError);
  assert.match(text(res), /editor\.port|Defold editor/i);
});

test("defold_screenshot returns an image (with a display) or a clear capture error (headless)", async () => {
  // Tolerant: a real display yields an image; headless CI / no permission /
  // unsupported platform must yield an actionable error rather than a crash.
  const res = await call("defold_screenshot", { max_width: 320, format: "jpeg" });
  if (res.isError) {
    assert.match(
      text(res),
      /Screen Recording|not yet implemented|capture failed|empty image|not supported/i
    );
  } else {
    const img = res.content.find((c) => c.type === "image");
    assert.ok(img, `expected an image content block, got: ${text(res)}`);
    assert.ok((img.data?.length ?? 0) > 100, "image data should be non-trivial");
    assert.match(img.mimeType, /image\/(jpeg|png)/);
    assert.match(text(res), /Screenshot of/);
  }
});

// --- toolchain-dependent tools degrade gracefully ----------------------------

test("defold_build pre-flights source-form bootstrap paths before invoking bob", async () => {
  const gp = path.join(projectRoot, "game.project");
  const original = await readFile(gp, "utf8");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(gp, original.replace("/main/main.collectionc", "/main/main.collection"));
  try {
    const res = await call("defold_build", {});
    assert.ok(res.isError);
    assert.match(text(res), /trailing "c"/);
    assert.match(text(res), /main_collection = \/main\/main\.collection\s+→\s+should be \/main\/main\.collectionc/);
    assert.match(text(res), /defold_set_setting/);
  } finally {
    await writeFile(gp, original);
  }
});

test("defold_build fails with actionable message when Java is missing (or runs bob when present)", async () => {
  const res = await call("defold_build", { timeout_seconds: 600 });
  // On machines without Java this must explain how to install it; with Java
  // the fixture should build or fail with structured diagnostics.
  if (res.isError) {
    assert.match(text(res), /Java|JDK|bob|Build FAILED/i);
  } else {
    assert.match(text(res), /Build succeeded/);
    const projectc = await stat(path.join(projectRoot, "build", "default", "game.projectc"));
    assert.ok(projectc.isFile());
  }
});
