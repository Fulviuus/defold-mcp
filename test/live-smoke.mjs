/**
 * Live smoke test (requires network; not part of `npm test`).
 * Exercises defold_setup, defold_api_search and defold_api_doc against the
 * real d.defold.com endpoints, and — when Java is available — the full
 * build/run/hot-reload loop with the real engine.
 *
 * Usage: node test/live-smoke.mjs [--full]
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const full = process.argv.includes("--full");

const projectRoot = await mkdtemp(path.join(os.tmpdir(), "defold-live-"));
await cp(path.join(here, "fixture"), projectRoot, { recursive: true });
// Drop the dependency so the live build needs no resolve step / native extension.
const gp = await readFile(path.join(projectRoot, "game.project"), "utf8");
await writeFile(
  path.join(projectRoot, "game.project"),
  gp.replace(/^dependencies#0.*\n/m, "")
);

const client = new Client({ name: "live-smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "..", "dist", "index.js")],
    env: { ...process.env, DEFOLD_PROJECT_ROOT: projectRoot },
    stderr: "inherit",
  })
);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c) => c.text ?? "").join("\n") ?? "";
  return { res, text };
};
const step = (name, ok, extra = "") =>
  console.log(`${ok ? "✔" : "✖"} ${name}${extra ? ` — ${extra}` : ""}`);

// 1. Toolchain setup (bob + engine + refdoc download/cache)
{
  const { res, text } = await call("defold_setup", {});
  step("defold_setup", !res.isError, text.split("\n").find((l) => l.includes("Defold version")));
  assert.ok(!res.isError, text);
  assert.match(text, /bob\.jar/);
  assert.match(text, /API docs.*indexed/);
}

// 2. API search
{
  const { res, text } = await call("defold_api_search", { query: "animate", namespace: "go" });
  step("defold_api_search", !res.isError && text.includes("go.animate"));
  assert.match(text, /go\.animate/);
  assert.match(text, /go\.cancel_animations/);
}

// 3. API doc for an element and a namespace
{
  const { text } = await call("defold_api_doc", { name: "go.animate" });
  step("defold_api_doc go.animate", /go\.animate\(/.test(text));
  assert.match(text, /easing/);
  assert.match(text, /Parameters/);

  const ns = await call("defold_api_doc", { name: "timer" });
  step("defold_api_doc timer namespace", /timer\.delay/.test(ns.text));

  const typo = await call("defold_api_doc", { name: "go.animte" });
  step("defold_api_doc suggests on typo", /Did you mean/.test(typo.text) && /go\.animate/.test(typo.text));
}

if (!full) {
  console.log("\n(docs-only smoke passed; run with --full for build/run/hot-reload once Java is installed)");
  await client.close();
  process.exit(0);
}

// 4. Full pipeline: build, run, engine info, hot reload, logs, stop.
{
  const { res, text } = await call("defold_build", {});
  step("defold_build", !res.isError, text.split("\n")[0]);
  assert.ok(!res.isError, text);
}
{
  const { res, text } = await call("defold_run", { build_first: false, wait_seconds: 4 });
  step("defold_run", !res.isError, text.split("\n")[0]);
  assert.ok(!res.isError, text);
}
{
  const { res, text } = await call("defold_engine_info", {});
  step("defold_engine_info", !res.isError);
  assert.ok(!res.isError, text);
}
{
  // mutate the script, then hot reload it
  const scriptPath = path.join(projectRoot, "main", "main.script");
  const original = await readFile(scriptPath, "utf8");
  await writeFile(scriptPath, original.replace("fixture game started", "fixture game HOT-RELOADED"));
  const { res, text } = await call("defold_hot_reload", { resources: ["/main/main.script"] });
  step("defold_hot_reload", !res.isError, text.split("\n")[0]);
  assert.ok(!res.isError, text);
}
{
  await new Promise((r) => setTimeout(r, 1000));
  const { text } = await call("defold_game_logs", { offset: -50 });
  step("defold_game_logs", /RESOURCE|reload|main\.scriptc/i.test(text), "(reload visible in engine log)");
  console.log(text.split("\n").slice(-14).join("\n"));
}
{
  const { res, text } = await call("defold_stop", {});
  step("defold_stop", !res.isError, text.split("\n")[0]);
  assert.ok(!res.isError, text);
}

console.log("\nFull live smoke passed.");
await client.close();
