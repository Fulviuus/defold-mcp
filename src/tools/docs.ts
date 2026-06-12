import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  findExact,
  findNamespace,
  formatElementMarkdown,
  searchElements,
  type LanguageFilter,
} from "../services/refdoc.js";
import { ensureRefdoc } from "../services/toolchain.js";
import { runTool, textResult, toJson } from "../util/errors.js";
import { limitParam, offsetParam, paginate, paginationFooter, responseFormatParam, versionParam } from "./shared.js";

const languageParam = z
  .enum(["lua", "cpp", "c", "cs", "all"])
  .default("lua")
  .describe(
    'API language to search: "lua" (game scripting, default), "cpp"/"c" (native extension SDK), "cs" (C# SDK), or "all".'
  );

export function registerDocTools(server: McpServer): void {
  server.registerTool(
    "defold_api_search",
    {
      title: "Search the Defold API reference",
      description:
        "Search the official Defold API reference for the selected engine version. Covers every " +
        "scripting namespace (go, gui, msg, sys, sound, sprite, physics, render, resource, vmath, " +
        "timer, http, json, window, factory, collectionproxy, b2d, editor scripting API, ...) plus " +
        "the native extension SDK.\n\n" +
        'Matches against names ("go.animate"), then briefs and descriptions. Returns qualified ' +
        "names with one-line summaries; use defold_api_doc for full signatures, parameters and " +
        "examples.\n\n" +
        "Downloads and caches the reference for the version on first use (requires network once).",
      inputSchema: {
        query: z.string().min(1).describe('Search text, e.g. "animate", "play sound", "msg.post".'),
        version: versionParam,
        type: z
          .enum(["function", "message", "property", "constant", "variable", "all"])
          .default("all")
          .describe("Filter by element type (default all)."),
        language: languageParam,
        namespace: z.string().optional().describe('Restrict to one namespace, e.g. "go" or "gui".'),
        limit: limitParam(20, 100),
        offset: offsetParam,
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        const index = await ensureRefdoc(args.version);
        const scored = searchElements(index.elements, args.query, {
          type: args.type === "all" ? undefined : args.type,
          language: args.language as LanguageFilter,
          namespace: args.namespace,
        });
        const page = paginate(scored, args.limit, args.offset);
        if (args.response_format === "json") {
          return textResult(
            toJson({
              version: index.version,
              total: page.total,
              count: page.count,
              offset: page.offset,
              has_more: page.has_more,
              ...(page.next_offset !== undefined ? { next_offset: page.next_offset } : {}),
              results: page.items.map(({ element: el }) => ({
                name: el.qualified,
                type: el.type,
                namespace: el.namespace,
                language: el.language,
                brief: el.brief,
              })),
            })
          );
        }
        if (page.total === 0) {
          return textResult(
            `No API elements matched "${args.query}" (language=${args.language}` +
              (args.namespace ? `, namespace=${args.namespace}` : "") +
              `). Try a shorter query, language="all", or drop the namespace filter.`
          );
        }
        const lines = [
          `# API search: "${args.query}" (Defold ${index.version})`,
          "",
          ...page.items.map(
            ({ element: el }) =>
              `- **${el.qualified}** (${el.type.toLowerCase()}, ${el.namespace}${el.language !== "Lua" ? `, ${el.language}` : ""}) — ${el.brief.replace(/\n+/g, " ").slice(0, 140)}`
          ),
          "",
          paginationFooter(page, "results"),
          "",
          "Use defold_api_doc with a name for full documentation.",
        ];
        return textResult(lines.join("\n"));
      })
  );

  server.registerTool(
    "defold_api_doc",
    {
      title: "Get Defold API documentation",
      description:
        "Get full documentation for a Defold API element or namespace.\n" +
        '- Element: name like "go.animate", "gui.set_text", "msg.post", "sys.load" — returns the ' +
        "signature, description, parameters, return values and (optionally) code examples.\n" +
        '- Namespace: name like "go", "gui", "timer" — returns an index of all its functions, ' +
        "messages, properties and constants.\n\n" +
        "Multiple matches (overloads, same name in Lua and the native SDK) are all returned, " +
        "Lua first.",
      inputSchema: {
        name: z.string().min(1).describe('Qualified element name ("go.animate") or namespace ("go").'),
        version: versionParam,
        include_examples: z.boolean().default(true).describe("Include code examples (default true)."),
        language: z
          .enum(["lua", "cpp", "c", "cs", "all"])
          .default("all")
          .describe("Restrict matches by language (default all, Lua listed first)."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      runTool(async () => {
        const index = await ensureRefdoc(args.version);
        const langFilter = (el: { language: string }): boolean => {
          switch (args.language) {
            case "all": return true;
            case "lua": return el.language === "Lua";
            case "cpp": return el.language === "C++";
            case "c": return el.language === "C";
            case "cs": return el.language === "C#";
          }
        };
        let matches = findExact(index.elements, args.name).filter(langFilter);
        if (matches.length > 0) {
          matches = matches.sort((a, b) =>
            (a.language === "Lua" ? 0 : 1) - (b.language === "Lua" ? 0 : 1)
          );
          const docs = matches
            .slice(0, 5)
            .map((el) => formatElementMarkdown(el, args.include_examples));
          const note =
            matches.length > 5 ? `\n\n(${matches.length - 5} additional matches omitted; refine by language.)` : "";
          return textResult(`Defold ${index.version}\n\n` + docs.join("\n\n---\n\n") + note);
        }

        const nsElements = findNamespace(index.elements, args.name).filter(langFilter);
        if (nsElements.length > 0) {
          const byType = new Map<string, string[]>();
          for (const el of nsElements) {
            const arr = byType.get(el.type) ?? [];
            arr.push(`- **${el.qualified}** — ${el.brief.replace(/\n+/g, " ").slice(0, 120)}`);
            byType.set(el.type, arr);
          }
          const lines = [`# Namespace ${args.name} (Defold ${index.version}, ${nsElements.length} elements)`, ""];
          for (const [type, entries] of [...byType.entries()].sort()) {
            lines.push(`## ${type}`, ...entries.sort(), "");
          }
          lines.push("Use defold_api_doc with a specific element name for full documentation.");
          return textResult(lines.join("\n"));
        }

        // Typo tolerance: progressively shorten the query until something matches.
        const lang = args.language === "all" ? "all" : (args.language as LanguageFilter);
        let suggestions = searchElements(index.elements, args.name, { language: lang });
        let probe = args.name.trim();
        while (suggestions.length === 0 && probe.length > 3) {
          probe = probe.slice(0, -1);
          suggestions = searchElements(index.elements, probe, { language: lang });
        }
        suggestions = suggestions.slice(0, 5);
        return textResult(
          `No exact match for "${args.name}" in Defold ${index.version}.` +
            (suggestions.length > 0
              ? `\n\nDid you mean:\n${suggestions.map((s) => `- ${s.element.qualified} (${s.element.type.toLowerCase()})`).join("\n")}`
              : "\n\nTry defold_api_search to discover names.")
        );
      })
  );
}
