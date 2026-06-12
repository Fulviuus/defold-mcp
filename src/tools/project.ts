import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gameProjectPath, resolveProjectRoot } from "../context.js";
import {
  iniGet,
  iniGetSection,
  iniRemove,
  iniSections,
  iniSet,
  parseIni,
  readDependencies,
  serializeIni,
  writeDependencies,
  type IniFile,
} from "../util/ini.js";
import { ToolFailure, errorResult, runTool, textResult, toJson } from "../util/errors.js";
import { resourceTypeOf, walkFiles } from "../util/fswalk.js";
import { projectRootParam, responseFormatParam } from "./shared.js";

/**
 * game.project keys that hold resource paths in COMPILED form (trailing "c"),
 * matching bob's GameProjectBuilder ROOT_NODES. The editor writes e.g.
 * "/main/main.collectionc" for bootstrap.main_collection.
 */
const COMPILED_RESOURCE_SETTINGS: Record<string, { source: string }> = {
  "bootstrap.main_collection": { source: ".collection" },
  "bootstrap.render": { source: ".render" },
  "bootstrap.debug_init_script": { source: ".lua" },
  "input.game_binding": { source: ".input_binding" },
  "input.gamepads": { source: ".gamepads" },
  "display.display_profiles": { source: ".display_profiles" },
};

async function loadGameProject(root: string): Promise<IniFile> {
  const file = gameProjectPath(root);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ToolFailure(`Could not read ${file}. Is this a Defold project root?`);
  }
  return parseIni(text);
}

async function saveGameProject(root: string, ini: IniFile): Promise<void> {
  await writeFile(gameProjectPath(root), serializeIni(ini), "utf8");
}

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "defold_project_info",
    {
      title: "Defold project overview",
      description:
        "Get an overview of a Defold project: title, version, bootstrap collection, display " +
        "settings, dependencies, and a breakdown of source resources by type (collections, game " +
        "objects, scripts, atlases, ...).\n\n" +
        "Use this first to orient yourself in an unfamiliar project. " +
        "Returns the absolute project root so subsequent file edits can use real paths.",
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
        const root = await resolveProjectRoot(args.project_root);
        const ini = await loadGameProject(root);
        const project = iniGetSection(ini, "project");
        const bootstrap = iniGetSection(ini, "bootstrap");
        const display = iniGetSection(ini, "display");
        const script = iniGetSection(ini, "script");
        const deps = readDependencies(ini);

        const typeCounts = new Map<string, number>();
        let fileCount = 0;
        for await (const rel of walkFiles(root)) {
          fileCount++;
          const t = resourceTypeOf(rel);
          typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
          if (fileCount >= 50000) break; // sanity cap for giant trees
        }
        const sortedCounts = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);

        const info = {
          project_root: root,
          title: project.title ?? "(untitled)",
          version: project.version ?? "",
          main_collection: bootstrap.main_collection ?? "/logic/main.collectionc (engine default)",
          render: bootstrap.render ?? "",
          display: {
            width: display.width ?? "960",
            height: display.height ?? "640",
          },
          shared_state: script.shared_state ?? "",
          dependencies: deps,
          total_files: fileCount,
          resources_by_type: Object.fromEntries(sortedCounts),
        };

        if (args.response_format === "json") return textResult(toJson(info));

        const lines = [
          `# ${info.title}${info.version ? ` (v${info.version})` : ""}`,
          "",
          `- **Project root**: ${root}`,
          `- **Main collection**: ${info.main_collection}`,
          ...(info.render ? [`- **Render**: ${info.render}`] : []),
          `- **Display**: ${info.display.width}x${info.display.height}`,
          `- **Dependencies**: ${deps.length === 0 ? "none" : ""}`,
          ...deps.map((d) => `  - ${d}`),
          "",
          `## Resources (${fileCount} files)`,
          ...sortedCounts.map(([t, c]) => `- ${t}: ${c}`),
        ];
        return textResult(lines.join("\n"));
      })
  );

  server.registerTool(
    "defold_get_settings",
    {
      title: "Read game.project settings",
      description:
        "Read settings from the project's game.project file. With no arguments returns all " +
        "sections and keys. Pass `section` to get one section (e.g. \"project\", \"display\", " +
        '"bootstrap", "input", "physics", "android", "ios"), and optionally `key` for a single value.',
      inputSchema: {
        project_root: projectRootParam,
        section: z.string().optional().describe('Section name without brackets, e.g. "display".'),
        key: z
          .string()
          .optional()
          .describe('Key within the section, e.g. "width". Requires `section`.'),
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
        const root = await resolveProjectRoot(args.project_root);
        const ini = await loadGameProject(root);
        if (args.key !== undefined && args.section === undefined) {
          throw new ToolFailure("`key` requires `section` to also be provided.");
        }
        if (args.section !== undefined) {
          const sectionValues = iniGetSection(ini, args.section);
          if (Object.keys(sectionValues).length === 0) {
            const available = iniSections(ini).join(", ") || "(none)";
            throw new ToolFailure(
              `Section [${args.section}] not found or empty in game.project. Available sections: ${available}. ` +
                "Note: Defold applies engine defaults for missing sections; absence here means the project uses defaults."
            );
          }
          if (args.key !== undefined) {
            const value = iniGet(ini, args.section, args.key);
            if (value === undefined) {
              throw new ToolFailure(
                `Key '${args.key}' not found in [${args.section}]. Existing keys: ${Object.keys(sectionValues).join(", ")}. ` +
                  "A missing key means the engine default applies."
              );
            }
            return textResult(
              args.response_format === "json"
                ? toJson({ section: args.section, key: args.key, value })
                : `[${args.section}] ${args.key} = ${value}`
            );
          }
          if (args.response_format === "json") {
            return textResult(toJson({ section: args.section, values: sectionValues }));
          }
          return textResult(
            [`## [${args.section}]`, ...Object.entries(sectionValues).map(([k, v]) => `${k} = ${v}`)].join("\n")
          );
        }
        const all: Record<string, Record<string, string>> = {};
        for (const s of iniSections(ini)) all[s] = iniGetSection(ini, s);
        if (args.response_format === "json") return textResult(toJson(all));
        const lines: string[] = [];
        for (const [s, values] of Object.entries(all)) {
          lines.push(`## [${s}]`);
          for (const [k, v] of Object.entries(values)) lines.push(`${k} = ${v}`);
          lines.push("");
        }
        return textResult(lines.join("\n") || "game.project is empty.");
      })
  );

  server.registerTool(
    "defold_set_setting",
    {
      title: "Write a game.project setting",
      description:
        "Set or remove a single key in game.project, preserving file ordering and comments. " +
        "Creates the section if it does not exist.\n\n" +
        'Examples: section="display", key="width", value="1280"; ' +
        'section="project", key="title", value="My Game"; ' +
        'remove=true to delete a key so the engine default applies again.\n\n' +
        "Note: the engine bootstrap keys (bootstrap.main_collection, bootstrap.render, " +
        "input.game_binding, input.gamepads, display.display_profiles, bootstrap.debug_init_script) " +
        'store COMPILED resource paths with a trailing "c" (e.g. "/main/main.collectionc"). ' +
        "If you pass the source path for one of these keys, the trailing c is appended automatically.",
      inputSchema: {
        project_root: projectRootParam,
        section: z.string().min(1).describe('Section name without brackets, e.g. "display".'),
        key: z.string().min(1).describe('Key to set, e.g. "width".'),
        value: z.string().optional().describe("New value (required unless remove=true)."),
        remove: z.boolean().default(false).describe("Remove the key instead of setting it."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        const ini = await loadGameProject(root);
        const oldValue = iniGet(ini, args.section, args.key);
        if (args.remove) {
          if (!iniRemove(ini, args.section, args.key)) {
            throw new ToolFailure(`Key '${args.key}' does not exist in [${args.section}]; nothing to remove.`);
          }
          await saveGameProject(root, ini);
          return textResult(`Removed [${args.section}] ${args.key} (was: ${oldValue ?? "unset"}).`);
        }
        if (args.value === undefined) {
          throw new ToolFailure("Provide `value`, or set remove=true to delete the key.");
        }
        let value = args.value;
        let note = "";
        const compiledExt = COMPILED_RESOURCE_SETTINGS[`${args.section}.${args.key}`];
        if (compiledExt && value.endsWith(compiledExt.source)) {
          value += "c";
          note = `\nNote: ${args.section}.${args.key} stores the compiled resource path, so a trailing "c" was appended.`;
        }
        iniSet(ini, args.section, args.key, value);
        await saveGameProject(root, ini);
        return textResult(
          `Set [${args.section}] ${args.key} = ${value}` +
            (oldValue !== undefined ? ` (was: ${oldValue})` : " (new key)") +
            note
        );
      })
  );

  server.registerTool(
    "defold_list_dependencies",
    {
      title: "List project dependencies",
      description:
        "List the library dependencies declared in game.project ([project] dependencies#N entries), " +
        "plus which library archives are currently present in the local .internal/lib cache " +
        "(populated by defold_resolve_dependencies or the editor's Fetch Libraries).",
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
        const root = await resolveProjectRoot(args.project_root);
        const ini = await loadGameProject(root);
        const deps = readDependencies(ini);
        let cached: string[] = [];
        try {
          cached = (await readdir(path.join(root, ".internal", "lib"))).filter(
            (f) => !f.startsWith(".")
          );
        } catch {
          // no local cache yet
        }
        const result = { dependencies: deps, resolved_archives: cached };
        if (args.response_format === "json") return textResult(toJson(result));
        const lines = [
          `# Dependencies (${deps.length})`,
          ...(deps.length === 0 ? ["(none declared in game.project)"] : deps.map((d, i) => `${i}. ${d}`)),
          "",
          cached.length > 0
            ? `Resolved archives in .internal/lib: ${cached.join(", ")}`
            : "No resolved archives found locally. Run defold_resolve_dependencies before building if dependencies are declared.",
        ];
        return textResult(lines.join("\n"));
      })
  );

  server.registerTool(
    "defold_add_dependency",
    {
      title: "Add a project dependency",
      description:
        "Add a library dependency URL to game.project. Defold dependencies are zip archive URLs, " +
        "typically GitHub release archives, e.g. " +
        '"https://github.com/defold/extension-websocket/archive/refs/tags/3.1.0.zip". ' +
        "After adding, run defold_resolve_dependencies to fetch the library.",
      inputSchema: {
        project_root: projectRootParam,
        url: z.string().url().describe("Dependency archive URL (https zip archive)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        const ini = await loadGameProject(root);
        const deps = readDependencies(ini);
        if (deps.includes(args.url)) {
          return textResult(`Dependency already present (index ${deps.indexOf(args.url)}): ${args.url}`);
        }
        deps.push(args.url);
        writeDependencies(ini, deps);
        await saveGameProject(root, ini);
        const warning = args.url.endsWith(".zip")
          ? ""
          : "\nNote: the URL does not end in .zip — Defold dependencies are usually zip archive URLs (GitHub: /archive/refs/tags/<tag>.zip).";
        return textResult(
          `Added dependency #${deps.length - 1}: ${args.url}${warning}\n` +
            "Run defold_resolve_dependencies to fetch it before building."
        );
      })
  );

  server.registerTool(
    "defold_remove_dependency",
    {
      title: "Remove a project dependency",
      description:
        "Remove a library dependency from game.project, identified by its exact URL or by its " +
        "index as reported by defold_list_dependencies. Remaining dependencies are re-indexed.",
      inputSchema: {
        project_root: projectRootParam,
        url: z.string().optional().describe("Exact dependency URL to remove."),
        index: z.number().int().min(0).optional().describe("Zero-based dependency index to remove."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        const ini = await loadGameProject(root);
        const deps = readDependencies(ini);
        let idx = -1;
        if (args.url !== undefined) idx = deps.indexOf(args.url);
        else if (args.index !== undefined) idx = args.index < deps.length ? args.index : -1;
        else throw new ToolFailure("Provide either `url` or `index`.");
        if (idx < 0) {
          return errorResult(
            `Dependency not found. Current dependencies:\n${deps.map((d, i) => `${i}. ${d}`).join("\n") || "(none)"}`
          );
        }
        const [removed] = deps.splice(idx, 1);
        writeDependencies(ini, deps);
        await saveGameProject(root, ini);
        return textResult(`Removed dependency: ${removed}\n${deps.length} dependencies remain.`);
      })
  );
}
