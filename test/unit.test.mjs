import assert from "node:assert/strict";
import { test } from "node:test";

const ini = await import("../dist/util/ini.js");
const textproto = await import("../dist/util/textproto.js");
const protobuf = await import("../dist/util/protobuf.js");
const processes = await import("../dist/services/processes.js");
const engineTools = await import("../dist/tools/engine.js");
const context = await import("../dist/context.js");

// ---------------------------------------------------------------------------
// INI / game.project
// ---------------------------------------------------------------------------

const SAMPLE = `[bootstrap]
main_collection = /main/main.collection

[project]
title = Fixture Game
dependencies#0 = https://example.com/a.zip
dependencies#1 = https://example.com/b.zip
`;

test("ini: parse + get", () => {
  const f = ini.parseIni(SAMPLE);
  assert.equal(ini.iniGet(f, "project", "title"), "Fixture Game");
  assert.equal(ini.iniGet(f, "bootstrap", "main_collection"), "/main/main.collection");
  assert.deepEqual(ini.iniSections(f), ["bootstrap", "project"]);
});

test("ini: round-trip preserves text", () => {
  const f = ini.parseIni(SAMPLE);
  assert.equal(ini.serializeIni(f), SAMPLE);
});

test("ini: set existing, new key, new section", () => {
  const f = ini.parseIni(SAMPLE);
  ini.iniSet(f, "project", "title", "Renamed");
  ini.iniSet(f, "project", "version", "2.0");
  ini.iniSet(f, "display", "width", "1280");
  const out = ini.serializeIni(f);
  assert.match(out, /title = Renamed/);
  assert.match(out, /version = 2\.0/);
  assert.match(out, /\[display\]\nwidth = 1280/);
  // new key lands inside [project], not after [display]
  assert.ok(out.indexOf("version = 2.0") < out.indexOf("[display]"));
});

test("ini: remove key", () => {
  const f = ini.parseIni(SAMPLE);
  assert.equal(ini.iniRemove(f, "project", "title"), true);
  assert.equal(ini.iniGet(f, "project", "title"), undefined);
  assert.equal(ini.iniRemove(f, "project", "missing"), false);
});

test("ini: dependencies read/write", () => {
  const f = ini.parseIni(SAMPLE);
  assert.deepEqual(ini.readDependencies(f), [
    "https://example.com/a.zip",
    "https://example.com/b.zip",
  ]);
  ini.writeDependencies(f, ["https://example.com/c.zip"]);
  const f2 = ini.parseIni(ini.serializeIni(f));
  assert.deepEqual(ini.readDependencies(f2), ["https://example.com/c.zip"]);
});

test("ini: legacy comma-separated dependencies", () => {
  const f = ini.parseIni("[project]\ndependencies = https://x.zip, https://y.zip\n");
  assert.deepEqual(ini.readDependencies(f), ["https://x.zip", "https://y.zip"]);
});

// ---------------------------------------------------------------------------
// Text-format protobuf parsing
// ---------------------------------------------------------------------------

test("textproto: parses collection with embedded data and string concatenation", () => {
  const text = `name: "main"
instances {
  id: "player"
  prototype: "/main/player.go"
  position { x: 10.0 y: 20.0 z: 0.0 }
}
embedded_instances {
  id: "controller"
  data: "components {\\n"
  "  id: \\"main\\"\\n"
  "  component: \\"/main/main.script\\"\\n"
  "}\\n"
  ""
}
scale_along_z: 0
`;
  const node = textproto.parseTextProto(text);
  assert.equal(node.name, "main");
  assert.equal(node.scale_along_z, 0);
  assert.equal(node.instances.id, "player");
  assert.equal(node.instances.position.x, 10);
  const parsed = textproto.parseEmbeddedData(node, 2);
  assert.equal(parsed.embedded_instances.data.components.id, "main");
  assert.equal(parsed.embedded_instances.data.components.component, "/main/main.script");
});

test("textproto: repeated fields become arrays", () => {
  const node = textproto.parseTextProto(`images { image: "/a.png" }\nimages { image: "/b.png" }\nimages { image: "/c.png" }`);
  assert.equal(node.images.length, 3);
  assert.equal(node.images[2].image, "/c.png");
});

test("textproto: enums, bools, negative and exponent numbers, octal escapes", () => {
  const node = textproto.parseTextProto(
    `mode: MODE_LOOP enabled: true factor: -1.5e2 label: "\\303\\245"`
  );
  assert.equal(node.mode, "MODE_LOOP");
  assert.equal(node.enabled, true);
  assert.equal(node.factor, -150);
  assert.equal(node.label, "å");
});

test("textproto: comments and angle-bracket messages", () => {
  const node = textproto.parseTextProto(`# comment line\nitem < id: "x" >\n`);
  assert.equal(node.item.id, "x");
});

// ---------------------------------------------------------------------------
// Binary protobuf encoding
// ---------------------------------------------------------------------------

test("protobuf: encodeReload produces tagged length-delimited strings", () => {
  const payload = protobuf.encodeReload(["/main/a.scriptc"]);
  const expected = Uint8Array.from([
    0x0a, 15, ...Buffer.from("/main/a.scriptc", "utf8"),
  ]);
  assert.deepEqual(payload, expected);
});

test("protobuf: encodeSetUpdateFrequency / encodeSetVsync varints", () => {
  assert.deepEqual(protobuf.encodeSetUpdateFrequency(60), Uint8Array.from([0x08, 60]));
  assert.deepEqual(protobuf.encodeSetUpdateFrequency(300), Uint8Array.from([0x08, 0xac, 0x02]));
  assert.deepEqual(protobuf.encodeSetVsync(1), Uint8Array.from([0x08, 1]));
});

test("protobuf: encodeReboot assigns sequential fields", () => {
  const payload = protobuf.encodeReboot(["a", "bc"]);
  assert.deepEqual(
    payload,
    Uint8Array.from([0x0a, 1, 97, 0x12, 2, 98, 99])
  );
});

test("protobuf: encodeStartRecord", () => {
  const payload = protobuf.encodeStartRecord("r.ivf", 2, 30);
  assert.deepEqual(
    payload,
    Uint8Array.from([0x0a, 5, ...Buffer.from("r.ivf"), 0x10, 2, 0x18, 30])
  );
});

// ---------------------------------------------------------------------------
// Compiled resource path mapping (hot reload)
// ---------------------------------------------------------------------------

test("compiledResourcePath maps source to built extensions", () => {
  const f = engineTools.compiledResourcePath;
  assert.equal(f("/main/player.script"), "/main/player.scriptc");
  assert.equal(f("main/player.script"), "/main/player.scriptc");
  assert.equal(f("/m/x.gui_script"), "/m/x.gui_scriptc");
  assert.equal(f("/m/x.lua"), "/m/x.luac");
  assert.equal(f("/m/x.collection"), "/m/x.collectionc");
  assert.equal(f("/m/x.atlas"), "/m/x.texturesetc");
  assert.equal(f("/img/bg.png"), "/img/bg.texturec");
  assert.equal(f("/m/x.scriptc"), "/m/x.scriptc"); // already compiled
});

// ---------------------------------------------------------------------------
// RingBuffer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resourceToAbsolute path guard (traversal + symlink-aware)
// ---------------------------------------------------------------------------

test("resourceToAbsolute resolves in-project paths and blocks traversal + symlink escapes", async () => {
  const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(os.tmpdir(), "defold-guard-"));
  try {
    // in-project resolves
    assert.equal(context.resourceToAbsolute(root, "/main/x.script"), path.join(root, "main/x.script"));
    assert.equal(context.resourceToAbsolute(root, "main/x.script"), path.join(root, "main/x.script"));

    // lexical traversal blocked
    assert.throws(() => context.resourceToAbsolute(root, "../escape.png"), /escapes the project root/);
    assert.throws(() => context.resourceToAbsolute(root, "/sub/../../escape"), /escapes the project root/);

    // symlink escape blocked: root/link -> os.tmpdir() (outside root)
    await mkdir(path.join(root, "sub"), { recursive: true });
    await symlink(os.tmpdir(), path.join(root, "link"));
    assert.throws(
      () => context.resourceToAbsolute(root, "/link/evil.png"),
      /symlink.*outside the project root/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RingBuffer keeps absolute offsets after wrap", () => {
  const rb = new processes.RingBuffer(3);
  for (let i = 0; i < 10; i++) rb.push(`line${i}`);
  assert.equal(rb.total, 10);
  assert.equal(rb.firstRetained, 7);
  assert.deepEqual(rb.slice(-2, 10).lines, ["line8", "line9"]);
  assert.deepEqual(rb.slice(0, 10).lines, ["line7", "line8", "line9"]);
  const page = rb.slice(8, 1);
  assert.deepEqual(page.lines, ["line8"]);
  assert.equal(page.start, 8);
});
