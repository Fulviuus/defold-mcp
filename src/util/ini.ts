/**
 * Parser/serializer for Defold's game.project (INI-style config) that
 * preserves ordering, comments and unknown lines on round-trip.
 */

export interface IniLine {
  raw: string;
  type: "section" | "kv" | "blank" | "comment" | "other";
  section?: string;
  key?: string;
  value?: string;
}

export interface IniFile {
  lines: IniLine[];
  /** Line separator detected in the source ("\n" or "\r\n"). */
  eol: string;
  /** Whether the source ended with a trailing newline. */
  trailingNewline: boolean;
}

export function parseIni(text: string): IniFile {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n") || text === "";
  const rawLines = text.split(/\r?\n/);
  if (trailingNewline && rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }
  const lines: IniLine[] = [];
  let currentSection: string | undefined;
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      lines.push({ raw, type: "blank", section: currentSection });
    } else if (trimmed.startsWith(";") || trimmed.startsWith("#")) {
      lines.push({ raw, type: "comment", section: currentSection });
    } else if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      currentSection = trimmed.slice(1, -1).trim();
      lines.push({ raw, type: "section", section: currentSection });
    } else {
      const eq = raw.indexOf("=");
      if (eq > 0) {
        const key = raw.slice(0, eq).trim();
        const value = raw.slice(eq + 1).trim();
        lines.push({ raw, type: "kv", section: currentSection, key, value });
      } else {
        lines.push({ raw, type: "other", section: currentSection });
      }
    }
  }
  return { lines, eol, trailingNewline };
}

export function serializeIni(ini: IniFile): string {
  let out = ini.lines.map((l) => l.raw).join(ini.eol);
  if (ini.trailingNewline && out !== "") out += ini.eol;
  return out;
}

export function iniSections(ini: IniFile): string[] {
  const seen: string[] = [];
  for (const l of ini.lines) {
    if (l.type === "section" && l.section !== undefined && !seen.includes(l.section)) {
      seen.push(l.section);
    }
  }
  return seen;
}

/** Last value wins, matching Defold config-file semantics. */
export function iniGet(ini: IniFile, section: string, key: string): string | undefined {
  let found: string | undefined;
  for (const l of ini.lines) {
    if (l.type === "kv" && l.section === section && l.key === key) found = l.value;
  }
  return found;
}

export function iniGetSection(ini: IniFile, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of ini.lines) {
    if (l.type === "kv" && l.section === section && l.key !== undefined) {
      out[l.key] = l.value ?? "";
    }
  }
  return out;
}

/** Index just past the last meaningful line of a section (before trailing blanks). */
function sectionEndIndex(ini: IniFile, section: string): number | undefined {
  let lastIdx: number | undefined;
  for (let i = 0; i < ini.lines.length; i++) {
    const l = ini.lines[i];
    if (l.section === section && l.type !== "blank") lastIdx = i;
  }
  return lastIdx === undefined ? undefined : lastIdx + 1;
}

export function iniSet(ini: IniFile, section: string, key: string, value: string): void {
  // Update the last existing occurrence in place.
  for (let i = ini.lines.length - 1; i >= 0; i--) {
    const l = ini.lines[i];
    if (l.type === "kv" && l.section === section && l.key === key) {
      ini.lines[i] = { raw: `${key} = ${value}`, type: "kv", section, key, value };
      return;
    }
  }
  const insertAt = sectionEndIndex(ini, section);
  const kvLine: IniLine = { raw: `${key} = ${value}`, type: "kv", section, key, value };
  if (insertAt === undefined) {
    // Create the section at the end of the file.
    if (ini.lines.length > 0 && ini.lines[ini.lines.length - 1].type !== "blank") {
      ini.lines.push({ raw: "", type: "blank" });
    }
    ini.lines.push({ raw: `[${section}]`, type: "section", section });
    ini.lines.push(kvLine);
  } else {
    ini.lines.splice(insertAt, 0, kvLine);
  }
}

export function iniRemove(ini: IniFile, section: string, key: string): boolean {
  let removed = false;
  for (let i = ini.lines.length - 1; i >= 0; i--) {
    const l = ini.lines[i];
    if (l.type === "kv" && l.section === section && l.key === key) {
      ini.lines.splice(i, 1);
      removed = true;
    }
  }
  return removed;
}

/**
 * Read project dependencies from a parsed game.project. Supports the modern
 * indexed form (dependencies#0 = url) and the legacy comma-separated form.
 */
export function readDependencies(ini: IniFile): string[] {
  const section = iniGetSection(ini, "project");
  const indexed: Array<{ idx: number; url: string }> = [];
  let legacy: string[] = [];
  for (const [key, value] of Object.entries(section)) {
    const m = /^dependencies#(\d+)$/.exec(key);
    if (m && value) {
      indexed.push({ idx: parseInt(m[1], 10), url: value });
    } else if (key === "dependencies" && value) {
      legacy = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  }
  indexed.sort((a, b) => a.idx - b.idx);
  return [...indexed.map((d) => d.url), ...legacy];
}

/** Rewrite all dependency keys as the modern indexed form. */
export function writeDependencies(ini: IniFile, urls: string[]): void {
  const section = iniGetSection(ini, "project");
  for (const key of Object.keys(section)) {
    if (key === "dependencies" || /^dependencies#\d+$/.test(key)) {
      iniRemove(ini, "project", key);
    }
  }
  urls.forEach((url, i) => iniSet(ini, "project", `dependencies#${i}`, url));
}
