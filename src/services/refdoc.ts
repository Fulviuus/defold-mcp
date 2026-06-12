import type { DocElement } from "./toolchain.js";

export type LanguageFilter = "lua" | "cpp" | "c" | "cs" | "all";

export function matchesLanguage(el: DocElement, filter: LanguageFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "lua":
      return el.language === "Lua";
    case "cpp":
      return el.language === "C++";
    case "c":
      return el.language === "C";
    case "cs":
      return el.language === "C#";
  }
}

export interface ScoredElement {
  element: DocElement;
  score: number;
}

/**
 * Rank elements against a query: exact qualified name > exact short name >
 * prefix > name substring > brief substring > description substring.
 */
export function searchElements(
  elements: DocElement[],
  query: string,
  opts: { type?: string; language: LanguageFilter; namespace?: string }
): ScoredElement[] {
  const q = query.trim().toLowerCase();
  const results: ScoredElement[] = [];
  for (const el of elements) {
    if (!matchesLanguage(el, opts.language)) continue;
    if (opts.type && el.type.toLowerCase() !== opts.type.toLowerCase()) continue;
    if (opts.namespace && el.namespace.toLowerCase() !== opts.namespace.toLowerCase()) continue;
    const qualified = el.qualified.toLowerCase();
    const name = el.name.toLowerCase();
    let score = 0;
    if (qualified === q || name === q) score = 100;
    else if (qualified.startsWith(q) || name.startsWith(q)) score = 80;
    else if (qualified.includes(q) || name.includes(q)) score = 60;
    else if (el.brief.toLowerCase().includes(q)) score = 30;
    else if (el.description.toLowerCase().includes(q)) score = 15;
    if (score > 0) results.push({ element: el, score });
  }
  results.sort(
    (a, b) => b.score - a.score || a.element.qualified.localeCompare(b.element.qualified)
  );
  return results;
}

/** All elements whose qualified name matches exactly (several overloads possible). */
export function findExact(elements: DocElement[], name: string): DocElement[] {
  const q = name.trim().toLowerCase();
  return elements.filter(
    (el) => el.qualified.toLowerCase() === q || el.name.toLowerCase() === q
  );
}

/** All elements in a namespace (e.g. "go", "gui", "msg"). */
export function findNamespace(elements: DocElement[], ns: string): DocElement[] {
  const q = ns.trim().toLowerCase();
  return elements.filter((el) => el.namespace.toLowerCase() === q);
}

function formatParams(title: string, params: DocElement["parameters"]): string[] {
  if (params.length === 0) return [];
  const lines = [`**${title}:**`];
  for (const p of params) {
    const types = p.types.length > 0 ? ` (${p.types.join(" | ")})` : "";
    lines.push(`- \`${p.name}\`${types}: ${p.doc.replace(/\n+/g, " ")}`);
  }
  return lines;
}

export function formatElementMarkdown(el: DocElement, includeExamples: boolean): string {
  const lines: string[] = [];
  const signature =
    el.type === "FUNCTION"
      ? `${el.qualified}(${el.parameters.map((p) => p.name).join(", ")})`
      : el.qualified;
  lines.push(`## ${signature}`);
  lines.push(`*${el.type.toLowerCase()}* — namespace \`${el.namespace}\` (${el.language})`);
  lines.push("");
  if (el.brief && el.brief !== el.description) lines.push(el.brief, "");
  if (el.description) lines.push(el.description, "");
  lines.push(...formatParams("Parameters", el.parameters));
  lines.push(...formatParams("Returns", el.returnvalues));
  if (includeExamples && el.examples) {
    lines.push("", "**Examples:**", "```lua", el.examples, "```");
  }
  return lines.join("\n");
}
