import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveProjectRoot, resourceToAbsolute } from "../context.js";
import {
  TEMPLATES,
  TEMPLATE_EXTENSIONS,
  TEMPLATE_TYPES,
  templateTypeFromPath,
  type TemplateType,
} from "../services/templates.js";
import { ToolFailure, runTool, textResult, toJson } from "../util/errors.js";
import { RESOURCE_TYPES, TEXT_RESOURCE_EXTS, resourceTypeOf, walkFiles } from "../util/fswalk.js";
import { parseIni, iniSections, iniGetSection } from "../util/ini.js";
import { parseEmbeddedData, parseTextProto } from "../util/textproto.js";
import {
  limitParam,
  normalizeResourcePath,
  offsetParam,
  paginate,
  paginationFooter,
  projectRootParam,
  responseFormatParam,
} from "./shared.js";

const LUA_LIKE_EXTS = new Set(["script", "gui_script", "render_script", "editor_script", "lua"]);

interface LuaOutline {
  kind: "lua_outline";
  path: string;
  line_count: number;
  functions: Array<{ name: string; params: string; line: number; local: boolean }>;
  go_properties: Array<{ name: string; default: string; line: number }>;
  requires: string[];
  messages_handled: string[];
}

function outlineLua(resourcePath: string, text: string): LuaOutline {
  const lines = text.split(/\r?\n/);
  const functions: LuaOutline["functions"] = [];
  const properties: LuaOutline["go_properties"] = [];
  const requires = new Set<string>();
  const messages = new Set<string>();

  const fnRe = /^\s*(local\s+)?function\s+([A-Za-z0-9_.:]+)\s*\(([^)]*)\)/;
  const assignFnRe = /^\s*(local\s+)?([A-Za-z0-9_.[\]"']+)\s*=\s*function\s*\(([^)]*)\)/;
  const propRe = /go\.property\s*\(\s*["']([^"']+)["']\s*,\s*([^)]*)\)/;
  const requireRe = /require\s*\(?\s*["']([^"']+)["']\s*\)?/g;
  const hashCmpRe = /message_id\s*==\s*hash\s*\(\s*["']([^"']+)["']\s*\)/g;

  lines.forEach((line, i) => {
    const fn = fnRe.exec(line);
    if (fn) functions.push({ name: fn[2], params: fn[3].trim(), line: i + 1, local: !!fn[1] });
    else {
      const afn = assignFnRe.exec(line);
      if (afn) functions.push({ name: afn[2], params: afn[3].trim(), line: i + 1, local: !!afn[1] });
    }
    const prop = propRe.exec(line);
    if (prop) properties.push({ name: prop[1], default: prop[2].trim(), line: i + 1 });
    for (const m of line.matchAll(requireRe)) requires.add(m[1]);
    for (const m of line.matchAll(hashCmpRe)) messages.add(m[1]);
  });

  return {
    kind: "lua_outline",
    path: resourcePath,
    line_count: lines.length,
    functions,
    go_properties: properties,
    requires: [...requires],
    messages_handled: [...messages],
  };
}

export function registerResourceTools(server: McpServer): void {
  server.registerTool(
    "defold_list_resources",
    {
      title: "List project resources",
      description:
        "List files in a Defold project with their resource types, with filtering and pagination. " +
        "Skips build output, .internal and VCS directories.\n\n" +
        `Known type filters include: ${[...new Set(Object.values(RESOURCE_TYPES))].sort().join(", ")}, ` +
        "game_project. Use name_contains for substring matching on the path.",
      inputSchema: {
        project_root: projectRootParam,
        type: z
          .string()
          .optional()
          .describe('Filter by resource type, e.g. "collection", "script", "atlas".'),
        name_contains: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter on the resource path, e.g. "player".'),
        limit: limitParam(100, 1000),
        offset: offsetParam,
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
        const needle = args.name_contains?.toLowerCase();
        const all: Array<{ path: string; type: string }> = [];
        for await (const rel of walkFiles(root)) {
          const resourcePath = "/" + rel;
          const type = resourceTypeOf(rel);
          if (args.type && type !== args.type) continue;
          if (needle && !resourcePath.toLowerCase().includes(needle)) continue;
          all.push({ path: resourcePath, type });
        }
        all.sort((a, b) => a.path.localeCompare(b.path));
        const page = paginate(all, args.limit, args.offset);
        if (page.total === 0 && args.type) {
          const types = new Set<string>();
          for await (const rel of walkFiles(root)) types.add(resourceTypeOf(rel));
          throw new ToolFailure(
            `No resources of type '${args.type}' found` +
              (needle ? ` matching '${args.name_contains}'` : "") +
              `. Types present in this project: ${[...types].sort().join(", ")}.`
          );
        }
        if (args.response_format === "json") {
          return textResult(toJson({ ...page, items: page.items }));
        }
        const lines = [
          ...page.items.map((r) => `- ${r.path} (${r.type})`),
          "",
          paginationFooter(page, "resources"),
        ];
        return textResult(lines.join("\n"));
      })
  );

  server.registerTool(
    "defold_parse_resource",
    {
      title: "Parse a Defold resource file",
      description:
        "Parse a Defold resource file into structured JSON.\n" +
        "- Text-format resources (.collection, .go, .gui, .atlas, .tilemap, .particlefx, .material, " +
        ".input_binding, ...) are parsed from protobuf text format; embedded component data " +
        "(embedded_components / embedded_instances) is recursively parsed up to embedded_depth.\n" +
        "- Lua files (.script, .gui_script, .render_script, .lua) return an outline: functions with " +
        "line numbers, go.property definitions, require'd modules, and message_ids compared in on_message.\n" +
        "- game.project returns all sections and keys.\n\n" +
        "Use this instead of reading raw files when you need the structure (instances, components, " +
        "nodes, images) of a Defold asset.",
      inputSchema: {
        project_root: projectRootParam,
        path: z
          .string()
          .min(1)
          .describe('Resource path, e.g. "/main/main.collection" (leading slash optional).'),
        embedded_depth: z
          .number()
          .int()
          .min(0)
          .max(5)
          .default(2)
          .describe("How many levels of embedded component data to parse (default 2)."),
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
        const resourcePath = normalizeResourcePath(args.path);
        const abs = resourceToAbsolute(root, resourcePath);
        let text: string;
        try {
          text = await readFile(abs, "utf8");
        } catch {
          throw new ToolFailure(
            `Could not read '${resourcePath}'. Use defold_list_resources to find valid paths.`
          );
        }
        const ext = path.extname(abs).replace(/^\./, "").toLowerCase();
        if (path.basename(abs) === "game.project") {
          const ini = parseIni(text);
          const all: Record<string, Record<string, string>> = {};
          for (const s of iniSections(ini)) all[s] = iniGetSection(ini, s);
          return textResult(toJson({ kind: "game_project", path: resourcePath, sections: all }));
        }
        if (LUA_LIKE_EXTS.has(ext)) {
          return textResult(toJson(outlineLua(resourcePath, text)));
        }
        const parsed = parseEmbeddedData(parseTextProto(text), args.embedded_depth);
        return textResult(
          toJson({ kind: "resource", path: resourcePath, type: resourceTypeOf(resourcePath.slice(1)), data: parsed })
        );
      })
  );

  server.registerTool(
    "defold_create_resource",
    {
      title: "Create a Defold resource from a template",
      description:
        "Create a new Defold file from a minimal valid template, creating parent directories as " +
        `needed. Supported templates: ${TEMPLATE_TYPES.join(", ")}.\n\n` +
        "The template is inferred from the file extension (e.g. \"/main/player.script\" -> script); " +
        "pass `template` explicitly when the extension is ambiguous. Fails if the file already " +
        "exists unless overwrite=true.\n\n" +
        "Notes: a .script must be attached to a game object component to run; a .gui_script must be " +
        "set as the script of a .gui scene. Use plain file editing tools for subsequent changes.",
      inputSchema: {
        project_root: projectRootParam,
        path: z.string().min(1).describe('Resource path to create, e.g. "/main/player.script".'),
        template: z
          .enum(TEMPLATE_TYPES)
          .optional()
          .describe("Template to use; inferred from the extension when omitted."),
        overwrite: z.boolean().default(false).describe("Overwrite an existing file (default false)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool(async () => {
        const root = await resolveProjectRoot(args.project_root);
        const resourcePath = normalizeResourcePath(args.path);
        const abs = resourceToAbsolute(root, resourcePath);
        const template: TemplateType | undefined = args.template ?? templateTypeFromPath(resourcePath);
        if (!template) {
          throw new ToolFailure(
            `Cannot infer a template from '${resourcePath}'. Pass template as one of: ${TEMPLATE_TYPES.join(", ")} ` +
              `(extensions: ${Object.values(TEMPLATE_EXTENSIONS).join(", ")}).`
          );
        }
        const expectedExt = TEMPLATE_EXTENSIONS[template];
        if (!resourcePath.toLowerCase().endsWith(expectedExt)) {
          throw new ToolFailure(
            `Template '${template}' files use the ${expectedExt} extension, but the path is '${resourcePath}'.`
          );
        }
        if (!args.overwrite) {
          try {
            await stat(abs);
            throw new ToolFailure(`'${resourcePath}' already exists. Pass overwrite=true to replace it.`);
          } catch (err) {
            if (err instanceof ToolFailure) throw err;
            // ENOENT: good, file does not exist
          }
        }
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, TEMPLATES[template], "utf8");
        return textResult(
          `Created ${resourcePath} (${template} template) at ${abs}.` +
            (template === "script"
              ? "\nAttach it to a game object (component in a .go file or embedded in a .collection) to run it."
              : template === "gui_script"
                ? '\nReference it from a .gui scene ("script" field) to run it.'
                : "")
        );
      })
  );

  server.registerTool(
    "defold_find_references",
    {
      title: "Find references to a resource",
      description:
        "Find files that reference a given resource path. Scans text-based project files " +
        "(collections, game objects, GUIs, scripts, materials, game.project, ...) for the resource " +
        'path string (e.g. "/main/player.go"). For Lua modules it also searches the dotted require ' +
        'form ("main.player").\n\n' +
        "Useful before renaming/deleting an asset, or to discover where a script or atlas is used.",
      inputSchema: {
        project_root: projectRootParam,
        resource_path: z
          .string()
          .min(1)
          .describe('Resource path to search for, e.g. "/main/player.script".'),
        limit: limitParam(200, 1000),
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
        const target = normalizeResourcePath(args.resource_path);
        const needles = [target];
        if (target.endsWith(".lua")) {
          needles.push(target.slice(1, -".lua".length).replace(/\//g, "."));
        }
        const matches: Array<{ file: string; line: number; text: string; matched: string }> = [];
        outer: for await (const rel of walkFiles(root)) {
          const ext = path.extname(rel).replace(/^\./, "").toLowerCase();
          const isTextResource = TEXT_RESOURCE_EXTS.has(ext) || rel === "game.project";
          if (!isTextResource) continue;
          if ("/" + rel === target) continue; // skip the file itself
          let text: string;
          try {
            text = await readFile(path.join(root, rel), "utf8");
          } catch {
            continue;
          }
          if (!needles.some((n) => text.includes(n))) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            for (const n of needles) {
              if (lines[i].includes(n)) {
                matches.push({
                  file: "/" + rel,
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200),
                  matched: n,
                });
                if (matches.length >= args.limit) break outer;
                break;
              }
            }
          }
        }
        if (args.response_format === "json") {
          return textResult(toJson({ resource: target, total: matches.length, references: matches }));
        }
        if (matches.length === 0) {
          return textResult(
            `No references to ${target} found in project text files. ` +
              "(Dynamic references built at runtime, e.g. via msg.url() strings, may not be detectable.)"
          );
        }
        const byFile = new Map<string, typeof matches>();
        for (const m of matches) {
          const arr = byFile.get(m.file) ?? [];
          arr.push(m);
          byFile.set(m.file, arr);
        }
        const lines: string[] = [`# References to ${target} (${matches.length})`, ""];
        for (const [file, ms] of byFile) {
          lines.push(`## ${file}`);
          for (const m of ms) lines.push(`- line ${m.line}: ${m.text}`);
          lines.push("");
        }
        if (matches.length >= args.limit) {
          lines.push(`(Stopped at limit=${args.limit}; there may be more references.)`);
        }
        return textResult(lines.join("\n"));
      })
  );

}
