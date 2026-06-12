import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BOB_TIMEOUT_MS } from "../constants.js";
import { gameProjectPath, resolveProjectRoot } from "../context.js";
import { iniGet, parseIni } from "../util/ini.js";
import { runBob, type BobResult } from "../services/bob.js";
import {
  cacheDir,
  ensureBob,
  ensureDmengine,
  ensureRefdoc,
  hostEnginePlatform,
  javaCheck,
  listCachedArtifacts,
  resolveVersion,
} from "../services/toolchain.js";
import { ToolFailure, errorResult, runTool, textResult, toJson } from "../util/errors.js";
import { projectRootParam, responseFormatParam, versionParam } from "./shared.js";

export const KNOWN_PLATFORMS = [
  "x86_64-macos",
  "arm64-macos",
  "x86_64-win32",
  "x86-win32",
  "x86_64-linux",
  "arm64-linux",
  "arm64-ios",
  "x86_64-ios",
  "armv7-android",
  "arm64-android",
  "js-web",
  "wasm-web",
  "wasm_pthread-web",
] as const;

const timeoutParam = z
  .number()
  .int()
  .min(10)
  .max(3600)
  .optional()
  .describe(
    "Timeout in seconds (default 900). First builds download platform packages and are slow."
  );

/** game.project keys that must hold compiled ("c"-suffixed) resource paths. */
const COMPILED_BOOTSTRAP_KEYS: Array<{ section: string; key: string; sourceExt: string }> = [
  { section: "bootstrap", key: "main_collection", sourceExt: ".collection" },
  { section: "bootstrap", key: "render", sourceExt: ".render" },
  { section: "bootstrap", key: "debug_init_script", sourceExt: ".lua" },
  { section: "input", key: "game_binding", sourceExt: ".input_binding" },
  { section: "input", key: "gamepads", sourceExt: ".gamepads" },
  { section: "display", key: "display_profiles", sourceExt: ".display_profiles" },
];

/**
 * Catch the classic hand-written game.project mistake before bob produces a
 * cryptic error for it: bootstrap resource keys must use compiled paths
 * ("/main/main.collectionc", trailing c). Returns an actionable message, or
 * undefined when the file is fine.
 */
export async function preflightGameProject(root: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(gameProjectPath(root), "utf8");
  } catch {
    return undefined; // missing game.project is reported elsewhere
  }
  const ini = parseIni(text);
  const problems: string[] = [];
  for (const { section, key, sourceExt } of COMPILED_BOOTSTRAP_KEYS) {
    const value = iniGet(ini, section, key);
    if (value && value.toLowerCase().endsWith(sourceExt)) {
      problems.push(`- [${section}] ${key} = ${value}  →  should be ${value}c`);
    }
  }
  if (problems.length === 0) return undefined;
  return (
    "game.project uses SOURCE resource paths where Defold expects COMPILED paths " +
    '(these keys take a trailing "c", e.g. "/main/main.collectionc"):\n' +
    problems.join("\n") +
    "\n\nFix each key with defold_set_setting (it appends the c automatically), then build again."
  );
}

export function formatBobResult(result: BobResult, action: string): string {
  const lines: string[] = [];
  lines.push(
    result.ok
      ? `${action} succeeded in ${(result.durationMs / 1000).toFixed(1)}s (bob ${result.bobVersion}).`
      : `${action} FAILED (exit code ${result.exitCode}, bob ${result.bobVersion}).`
  );
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  if (errors.length > 0) {
    lines.push("", `## Errors (${errors.length})`);
    for (const d of errors.slice(0, 50)) {
      lines.push(`- ${d.resource ?? ""}${d.line !== undefined ? `:${d.line}` : ""} ${d.message}`.trim());
    }
  }
  if (warnings.length > 0) {
    lines.push("", `## Warnings (${warnings.length})`);
    for (const d of warnings.slice(0, 20)) {
      lines.push(`- ${d.resource ?? ""}${d.line !== undefined ? `:${d.line}` : ""} ${d.message}`.trim());
    }
  }
  if (!result.ok && errors.length === 0) {
    // No structured diagnostics; show output tail so the agent can diagnose.
    const tail = result.output.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-40);
    lines.push("", "## Output (tail)", "```", ...tail, "```");
  }
  return lines.join("\n");
}

export function registerBuildTools(server: McpServer): void {
  server.registerTool(
    "defold_setup",
    {
      title: "Set up / check the Defold toolchain",
      description:
        "Check and install the local Defold toolchain used by this server: verifies Java (needed " +
        "by bob.jar), resolves the requested Defold version, and downloads bob.jar — plus " +
        "optionally the dmengine dev binary (for defold_run) and the API reference docs (for " +
        "defold_api_search). Artifacts are cached in ~/.defold-mcp (override with " +
        "DEFOLD_MCP_CACHE_DIR).\n\n" +
        "Run this once before building, or to diagnose toolchain problems. Safe to re-run; " +
        "downloads are skipped when already cached.",
      inputSchema: {
        version: versionParam,
        install_bob: z.boolean().default(true).describe("Download bob.jar if missing (default true)."),
        install_engine: z
          .boolean()
          .default(true)
          .describe("Download the dmengine dev binary for this machine (default true)."),
        install_refdoc: z
          .boolean()
          .default(true)
          .describe("Download and index the API reference documentation (default true)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        const lines: string[] = ["# Defold toolchain status", ""];
        const java = await javaCheck();
        lines.push(`- **Java**: ${java.ok ? `OK (${java.version})` : `MISSING — ${java.message}`}`);
        const resolved = await resolveVersion(args.version);
        lines.push(`- **Defold version**: ${resolved.version} (sha1 ${resolved.sha1.slice(0, 8)}, spec "${resolved.spec}")`);
        lines.push(`- **Cache dir**: ${cacheDir()}`);

        if (args.install_bob) {
          const bob = await ensureBob(args.version);
          const size = (await stat(bob.jarPath)).size;
          lines.push(
            `- **bob.jar**: ${bob.downloaded ? "downloaded" : "cached"} at ${bob.jarPath} (${(size / 1024 / 1024).toFixed(1)} MB)` +
              (java.ok ? "" : " — NOTE: unusable until Java is installed")
          );
        }
        if (args.install_engine) {
          try {
            const eng = await ensureDmengine(args.version);
            lines.push(
              `- **dmengine** (${eng.platform}): ${eng.downloaded ? "downloaded" : "cached"} at ${eng.enginePath}`
            );
          } catch (err) {
            lines.push(`- **dmengine**: unavailable — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (args.install_refdoc) {
          const refdoc = await ensureRefdoc(args.version);
          lines.push(`- **API docs**: indexed ${refdoc.elements.length} elements for ${refdoc.version}`);
        }
        const cached = await listCachedArtifacts();
        lines.push(
          "",
          `Cached versions — bob: [${cached.bob.join(", ") || "none"}], engine: [${cached.engine.join(", ") || "none"}], refdoc: [${cached.refdoc.join(", ") || "none"}]`
        );
        if (!java.ok) {
          lines.push(
            "",
            "⚠ Java is required for defold_build / defold_bundle / defold_resolve_dependencies. " +
              "Install a JDK (https://adoptium.net, or `brew install --cask temurin` on macOS)."
          );
        }
        return textResult(lines.join("\n"));
      })
  );

  server.registerTool(
    "defold_resolve_dependencies",
    {
      title: "Resolve (fetch) project dependencies",
      description:
        "Run `bob resolve` to download the library dependencies declared in game.project into the " +
        "project's .internal/lib cache. Needed after adding/changing dependencies and before " +
        "building a project that declares them.\n\n" +
        "Optional email/auth are forwarded to bob for private dependency hosts (defaults from " +
        "DEFOLD_EMAIL / DEFOLD_AUTH environment variables).",
      inputSchema: {
        project_root: projectRootParam,
        version: versionParam,
        email: z.string().optional().describe("Value for bob --email (private hosts only)."),
        auth: z.string().optional().describe("Value for bob --auth (private hosts only)."),
        timeout_seconds: timeoutParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        const bobArgs: string[] = [];
        const email = args.email ?? process.env.DEFOLD_EMAIL;
        const auth = args.auth ?? process.env.DEFOLD_AUTH;
        if (email) bobArgs.push("--email", email);
        if (auth) bobArgs.push("--auth", auth);
        bobArgs.push("resolve");
        const result = await runBob(root, args.version, bobArgs, (args.timeout_seconds ?? 900) * 1000);
        const text = formatBobResult(result, "Dependency resolution");
        return result.ok ? textResult(text) : errorResult(text);
      })
  );

  server.registerTool(
    "defold_build",
    {
      title: "Build the project (bob build)",
      description:
        "Compile the Defold project with bob into build/default/. This is the primary way to " +
        "validate a project: compile errors are returned as structured diagnostics " +
        "(resource path, line, message).\n\n" +
        "A successful debug build is also the prerequisite for defold_run and defold_hot_reload. " +
        "If the project declares dependencies, run defold_resolve_dependencies first (bob fails " +
        "with 'Missing dependencies' otherwise).\n\n" +
        "Returns: success flag, duration, errors/warnings list, and the output tail on " +
        "unstructured failures.",
      inputSchema: {
        project_root: projectRootParam,
        version: versionParam,
        variant: z
          .enum(["debug", "release", "headless"])
          .default("debug")
          .describe("Engine variant to build for (default debug; debug enables hot reload & engine service)."),
        platform: z
          .string()
          .optional()
          .describe(
            `Target platform for cross-compilation of native extensions, e.g. ${KNOWN_PLATFORMS.slice(0, 4).join(", ")}. Omit for the host platform.`
          ),
        archive: z.boolean().default(false).describe("Also create the game archive (--archive)."),
        texture_compression: z
          .boolean()
          .default(false)
          .describe("Apply texture compression as specified in texture profiles."),
        extra_args: z
          .array(z.string())
          .default([])
          .describe('Additional raw bob arguments, e.g. ["--strip-executable"].'),
        timeout_seconds: timeoutParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        const preflight = await preflightGameProject(root);
        if (preflight) return errorResult(preflight);
        const bobArgs = ["--variant", args.variant];
        if (args.platform) {
          if (!(KNOWN_PLATFORMS as readonly string[]).includes(args.platform)) {
            // Soft warning only: new platforms appear over time.
          }
          bobArgs.push("--platform", args.platform);
        }
        if (args.archive) bobArgs.push("--archive");
        if (args.texture_compression) bobArgs.push("--texture-compression", "true");
        bobArgs.push(...args.extra_args, "build");
        const result = await runBob(root, args.version, bobArgs, (args.timeout_seconds ?? 900) * 1000);
        let text = formatBobResult(result, "Build");
        if (!result.ok && /Missing dependencies|Unable to find|could not be resolved/i.test(result.output)) {
          text += "\n\nHint: run defold_resolve_dependencies to fetch declared dependencies first.";
        }
        return result.ok ? textResult(text) : errorResult(text);
      })
  );

  server.registerTool(
    "defold_bundle",
    {
      title: "Bundle the game for a platform",
      description:
        "Create a distributable application bundle with bob (resolve + build + bundle with " +
        "--archive). Produces e.g. .app for macOS, .exe folder for Windows, .apk/.aab for Android, " +
        ".ipa for iOS (signing identity required), or a web folder for HTML5.\n\n" +
        `Platforms: ${KNOWN_PLATFORMS.join(", ")}.\n\n` +
        "Signing/advanced flags can be passed via extra_args, e.g. " +
        '["--keystore", "path", "--keystore-pass", "pass"] for Android or ' +
        '["--mobileprovisioning", "x.mobileprovision", "--identity", "iPhone Developer: ..."] for iOS. ' +
        "Returns the bundle output directory and its top-level contents.",
      inputSchema: {
        project_root: projectRootParam,
        platform: z.string().min(1).describe(`Target platform, e.g. "${KNOWN_PLATFORMS[1]}".`),
        version: versionParam,
        variant: z
          .enum(["debug", "release", "headless"])
          .default("release")
          .describe("Engine variant to bundle (default release)."),
        architectures: z
          .string()
          .optional()
          .describe('Comma-separated architectures, e.g. "arm64-android" or "armv7-android,arm64-android".'),
        bundle_output: z
          .string()
          .optional()
          .describe("Output directory (default <project>/bundle/<platform>)."),
        texture_compression: z.boolean().default(true).describe("Apply texture compression (default true)."),
        with_symbols: z.boolean().default(false).describe("Keep debug symbols in the bundle."),
        extra_args: z.array(z.string()).default([]).describe("Additional raw bob arguments (signing etc.)."),
        timeout_seconds: timeoutParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        if (!(KNOWN_PLATFORMS as readonly string[]).includes(args.platform)) {
          throw new ToolFailure(
            `Unknown platform '${args.platform}'. Known platforms: ${KNOWN_PLATFORMS.join(", ")}. ` +
              "(If this is a newly added Defold platform, pass it via extra_args after double-checking.)"
          );
        }
        const preflight = await preflightGameProject(root);
        if (preflight) return errorResult(preflight);
        const outDir = args.bundle_output ?? path.join(root, "bundle", args.platform);
        const bobArgs = [
          "--platform", args.platform,
          "--variant", args.variant,
          "--archive",
          "--bundle-output", outDir,
        ];
        if (args.architectures) bobArgs.push("--architectures", args.architectures);
        if (args.texture_compression) bobArgs.push("--texture-compression", "true");
        if (args.with_symbols) bobArgs.push("--with-symbols");
        bobArgs.push(...args.extra_args, "resolve", "build", "bundle");
        const result = await runBob(root, args.version, bobArgs, (args.timeout_seconds ?? 1800) * 1000);
        let text = formatBobResult(result, `Bundle (${args.platform}, ${args.variant})`);
        if (result.ok) {
          try {
            const contents = await readdir(outDir);
            text += `\n\nBundle output: ${outDir}\nContents: ${contents.join(", ")}`;
          } catch {
            text += `\n\nBundle output directory: ${outDir}`;
          }
        }
        return result.ok ? textResult(text) : errorResult(text);
      })
  );

  server.registerTool(
    "defold_clean",
    {
      title: "Clean build output",
      description:
        "Delete the project's build/ directory (equivalent to bob distclean, but does not require " +
        "Java). Does not touch source files or the .internal dependency cache.",
      inputSchema: {
        project_root: projectRootParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        const buildDir = path.join(root, "build");
        try {
          await stat(buildDir);
        } catch {
          return textResult(`Nothing to clean: ${buildDir} does not exist.`);
        }
        await rm(buildDir, { recursive: true, force: true });
        return textResult(`Deleted ${buildDir}.`);
      })
  );

  server.registerTool(
    "defold_doctor",
    {
      title: "Diagnose the environment",
      description:
        "Report the health of everything this server depends on: Node version, Java availability, " +
        "cache directory and cached artifact versions, configured environment variables, project " +
        "root resolution, and running game processes. Use when builds or runs misbehave.",
      inputSchema: {
        project_root: projectRootParam,
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(async () => {
        const java = await javaCheck();
        let projectRoot = "(not found)";
        let projectError: string | undefined;
        try {
          projectRoot = await resolveProjectRoot(args.project_root);
        } catch (err) {
          projectError = err instanceof Error ? err.message : String(err);
        }
        let enginePlatform = "(unsupported)";
        try {
          enginePlatform = hostEnginePlatform().platform;
        } catch {
          // keep default
        }
        const cached = await listCachedArtifacts();
        const { games } = await import("../state.js");
        const report = {
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          engine_platform: enginePlatform,
          java: { ok: java.ok, version: java.version ?? null, note: java.ok ? null : java.message },
          cache_dir: cacheDir(),
          cached_artifacts: cached,
          project_root: projectRoot,
          project_root_error: projectError ?? null,
          env: {
            DEFOLD_PROJECT_ROOT: process.env.DEFOLD_PROJECT_ROOT ?? null,
            DEFOLD_MCP_CACHE_DIR: process.env.DEFOLD_MCP_CACHE_DIR ?? null,
            DEFOLD_EMAIL: process.env.DEFOLD_EMAIL ? "(set)" : null,
            DEFOLD_AUTH: process.env.DEFOLD_AUTH ? "(set)" : null,
            JAVA_HOME: process.env.JAVA_HOME ?? null,
          },
          running_games: games.list(),
        };
        if (args.response_format === "json") return textResult(toJson(report));
        const lines = [
          "# defold-mcp doctor",
          "",
          `- Node: ${report.node} on ${report.platform} (engine platform: ${report.engine_platform})`,
          `- Java: ${java.ok ? `OK (${java.version})` : `PROBLEM — ${java.message}`}`,
          `- Cache: ${report.cache_dir}`,
          `  - bob: ${cached.bob.join(", ") || "none"}`,
          `  - engine: ${cached.engine.join(", ") || "none"}`,
          `  - refdoc: ${cached.refdoc.join(", ") || "none"}`,
          `- Project root: ${projectRoot}${projectError ? ` — ${projectError}` : ""}`,
          `- Env: DEFOLD_PROJECT_ROOT=${report.env.DEFOLD_PROJECT_ROOT ?? "unset"}, JAVA_HOME=${report.env.JAVA_HOME ?? "unset"}`,
          `- Running games: ${report.running_games.length === 0 ? "none" : report.running_games.map((g) => `${g.key} (pid ${g.pid}, ${g.running ? "running" : "exited"})`).join("; ")}`,
        ];
        return textResult(lines.join("\n"));
      })
  );
}
