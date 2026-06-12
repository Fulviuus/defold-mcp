import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import {
  CHANNEL_CACHE_TTL_MS,
  DOWNLOAD_TIMEOUT_MS,
  D_DEFOLD_BASE,
  GITHUB_API_BASE,
  GITHUB_RELEASES_BASE,
  MIN_JAVA_MAJOR,
  RECOMMENDED_JAVA_MAJOR,
  RELEASE_CHANNELS,
} from "../constants.js";
import { ToolFailure } from "../util/errors.js";
import { downloadToFile, fetchBuffer, fetchJson } from "../util/http.js";

export interface ResolvedVersion {
  /** Concrete version, e.g. "1.12.4". */
  version: string;
  /** Engine release sha1 used in d.defold.com archive URLs. */
  sha1: string;
  /** The original spec ("stable", "beta", "alpha" or explicit version). */
  spec: string;
}

export interface JavaInfo {
  ok: boolean;
  version?: string;
  major?: number;
  message: string;
}

export function cacheDir(): string {
  return process.env.DEFOLD_MCP_CACHE_DIR ?? path.join(os.homedir(), ".defold-mcp");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Version resolution
// ---------------------------------------------------------------------------

interface VersionCacheEntry {
  version: string;
  sha1: string;
  fetchedAt: number;
}

async function readVersionCache(): Promise<Record<string, VersionCacheEntry>> {
  try {
    const text = await readFile(path.join(cacheDir(), "versions.json"), "utf8");
    return JSON.parse(text) as Record<string, VersionCacheEntry>;
  } catch {
    return {};
  }
}

async function writeVersionCache(cache: Record<string, VersionCacheEntry>): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(path.join(cacheDir(), "versions.json"), JSON.stringify(cache, null, 2));
}

function isChannel(spec: string): boolean {
  return (RELEASE_CHANNELS as readonly string[]).includes(spec);
}

/**
 * Resolve a version spec ("stable" | "beta" | "alpha" | "1.12.4") into a
 * concrete version + engine sha1. Results are cached on disk; channel specs
 * expire after CHANNEL_CACHE_TTL_MS, explicit versions never expire.
 */
export async function resolveVersion(spec = "stable"): Promise<ResolvedVersion> {
  const normalized = spec.trim().toLowerCase();
  const cache = await readVersionCache();
  const cached = cache[normalized];
  if (cached) {
    const fresh = !isChannel(normalized) || Date.now() - cached.fetchedAt < CHANNEL_CACHE_TTL_MS;
    if (fresh) return { version: cached.version, sha1: cached.sha1, spec: normalized };
  }

  let version: string;
  let sha1: string;
  if (isChannel(normalized)) {
    const info = await fetchJson<{ version: string; sha1: string }>(
      `${D_DEFOLD_BASE}/${normalized}/info.json`
    );
    if (!info.version || !info.sha1) {
      throw new ToolFailure(
        `Unexpected response from ${D_DEFOLD_BASE}/${normalized}/info.json`
      );
    }
    version = info.version;
    sha1 = info.sha1;
  } else if (/^\d+\.\d+\.\d+$/.test(normalized)) {
    sha1 = await resolveTagSha(normalized);
    version = normalized;
  } else {
    throw new ToolFailure(
      `Invalid version '${spec}'. Use "stable", "beta", "alpha" or an explicit version like "1.12.4".`
    );
  }

  cache[normalized] = { version, sha1, fetchedAt: Date.now() };
  if (cached?.version && cached.version !== version) {
    // Channel moved to a new release; nothing else to invalidate because all
    // artifact paths are keyed by concrete version.
  }
  await writeVersionCache(cache);
  return { version, sha1, spec: normalized };
}

async function resolveTagSha(version: string): Promise<string> {
  interface RefResponse {
    object?: { sha: string; type: string; url: string };
  }
  const ref = await fetchJson<RefResponse>(
    `${GITHUB_API_BASE}/repos/defold/defold/git/ref/tags/${version}`
  );
  if (!ref.object?.sha) {
    throw new ToolFailure(
      `Could not find Defold release '${version}' on GitHub. Check https://github.com/defold/defold/releases for valid versions.`
    );
  }
  if (ref.object.type === "tag") {
    const tagObj = await fetchJson<RefResponse>(ref.object.url);
    if (tagObj.object?.sha) return tagObj.object.sha;
  }
  return ref.object.sha;
}

// ---------------------------------------------------------------------------
// Java detection
// ---------------------------------------------------------------------------

export async function javaCheck(): Promise<JavaInfo> {
  const javaCmd = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  return new Promise((resolve) => {
    const child = spawn(javaCmd, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", () => {
      resolve({
        ok: false,
        message:
          "Java was not found on this machine. bob.jar (the Defold build tool) requires a JDK " +
          `(${RECOMMENDED_JAVA_MAJOR}+ recommended). Install one, e.g. with 'brew install --cask temurin' ` +
          "on macOS or from https://adoptium.net, and make sure 'java' is on PATH or JAVA_HOME is set.",
      });
    });
    child.on("close", () => {
      const m = /version "(\d+)(?:\.(\d+))?[^"]*"/.exec(output);
      if (!m) {
        resolve({
          ok: false,
          message: `Could not parse Java version from: ${output.trim().split("\n")[0] ?? "(no output)"}`,
        });
        return;
      }
      let major = parseInt(m[1], 10);
      if (major === 1 && m[2]) major = parseInt(m[2], 10); // "1.8" style
      const versionStr = output.match(/version "([^"]+)"/)?.[1] ?? String(major);
      if (major < MIN_JAVA_MAJOR) {
        resolve({
          ok: false,
          version: versionStr,
          major,
          message:
            `Java ${versionStr} is too old for bob.jar. Recent Defold releases need JDK ${MIN_JAVA_MAJOR}+ ` +
            `(${RECOMMENDED_JAVA_MAJOR}+ recommended). Install a newer JDK from https://adoptium.net.`,
        });
      } else {
        resolve({ ok: true, version: versionStr, major, message: `Java ${versionStr} found.` });
      }
    });
  });
}

export function javaCommand(): string {
  return process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
}

// ---------------------------------------------------------------------------
// Artifact downloads
// ---------------------------------------------------------------------------

async function downloadWithFallback(urls: string[], dest: string): Promise<number> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await downloadToFile(url, dest, DOWNLOAD_TIMEOUT_MS);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ToolFailure(`All download attempts failed for ${dest}`);
}

/** Download (if needed) and return the path of bob.jar for a version spec. */
export async function ensureBob(spec = "stable"): Promise<{ jarPath: string; resolved: ResolvedVersion; downloaded: boolean }> {
  const resolved = await resolveVersion(spec);
  const jarPath = path.join(cacheDir(), "bob", resolved.version, "bob.jar");
  if (await exists(jarPath)) return { jarPath, resolved, downloaded: false };
  await downloadWithFallback(
    [
      `${D_DEFOLD_BASE}/archive/${resolved.sha1}/bob/bob.jar`,
      `${GITHUB_RELEASES_BASE}/${resolved.version}/bob.jar`,
    ],
    jarPath
  );
  // Sanity check: a jar is a zip file.
  const head = await readFile(jarPath).then((b) => b.subarray(0, 2).toString("latin1"));
  if (head !== "PK") {
    throw new ToolFailure(`Downloaded bob.jar appears corrupt (${jarPath}). Delete it and retry.`);
  }
  return { jarPath, resolved, downloaded: true };
}

/** Map the host OS/arch to a Defold engine platform identifier. */
export function hostEnginePlatform(): { platform: string; exeName: string } {
  const { platform, arch } = process;
  if (platform === "darwin") {
    return { platform: arch === "arm64" ? "arm64-macos" : "x86_64-macos", exeName: "dmengine" };
  }
  if (platform === "linux") {
    return { platform: arch === "arm64" ? "arm64-linux" : "x86_64-linux", exeName: "dmengine" };
  }
  if (platform === "win32") {
    return { platform: "x86_64-win32", exeName: "dmengine.exe" };
  }
  throw new ToolFailure(
    `Unsupported host platform '${platform}/${arch}' for running dmengine locally.`
  );
}

/** Download (if needed) and return the path of the dmengine dev binary for the host. */
export async function ensureDmengine(spec = "stable"): Promise<{ enginePath: string; resolved: ResolvedVersion; platform: string; downloaded: boolean }> {
  const resolved = await resolveVersion(spec);
  const { platform, exeName } = hostEnginePlatform();
  const enginePath = path.join(cacheDir(), "engine", resolved.version, platform, exeName);
  if (await exists(enginePath)) return { enginePath, resolved, platform, downloaded: false };
  await downloadWithFallback(
    [`${D_DEFOLD_BASE}/archive/${resolved.sha1}/engine/${platform}/${exeName}`],
    enginePath
  );
  if (process.platform !== "win32") await chmod(enginePath, 0o755);
  return { enginePath, resolved, platform, downloaded: true };
}

// ---------------------------------------------------------------------------
// API reference documentation (ref-doc.zip)
// ---------------------------------------------------------------------------

export interface DocParam {
  name: string;
  doc: string;
  types: string[];
}

export interface DocElement {
  type: string;
  name: string;
  qualified: string;
  namespace: string;
  language: string;
  brief: string;
  description: string;
  parameters: DocParam[];
  returnvalues: DocParam[];
  examples: string;
}

export interface RefdocIndex {
  version: string;
  elements: DocElement[];
}

/** Strip HTML markup and decode common entities from ref-doc text. */
export function stripHtml(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/<pre[^>]*>/g, "\n")
    .replace(/<\/pre>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toDocParams(value: unknown): DocParam[] {
  if (!Array.isArray(value)) return [];
  return value.map((p) => ({
    name: typeof p?.name === "string" ? p.name : "",
    doc: stripHtml(p?.doc),
    types: Array.isArray(p?.types) ? p.types.filter((t: unknown) => typeof t === "string") : [],
  }));
}

const refdocMemo = new Map<string, RefdocIndex>();

/** Download/extract ref-doc.zip (once per version) and return a slim search index. */
export async function ensureRefdoc(spec = "stable"): Promise<RefdocIndex> {
  const resolved = await resolveVersion(spec);
  const memo = refdocMemo.get(resolved.version);
  if (memo) return memo;

  const indexPath = path.join(cacheDir(), "refdoc", resolved.version, "index.json");
  if (await exists(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, "utf8")) as RefdocIndex;
    refdocMemo.set(resolved.version, index);
    return index;
  }

  let zipData: Buffer | undefined;
  const urls = [
    `${D_DEFOLD_BASE}/archive/${resolved.sha1}/engine/share/ref-doc.zip`,
    `${GITHUB_RELEASES_BASE}/${resolved.version}/ref-doc.zip`,
  ];
  let lastErr: unknown;
  for (const url of urls) {
    try {
      zipData = await fetchBuffer(url, DOWNLOAD_TIMEOUT_MS);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!zipData) {
    throw lastErr instanceof Error
      ? lastErr
      : new ToolFailure("Failed to download ref-doc.zip from all sources.");
  }

  const files = unzipSync(new Uint8Array(zipData), {
    filter: (f) => f.name.endsWith("_doc.json"),
  });
  const elements: DocElement[] = [];
  for (const [, data] of Object.entries(files)) {
    let parsed: { info?: Record<string, unknown>; elements?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(Buffer.from(data).toString("utf8"));
    } catch {
      continue;
    }
    const info = parsed.info ?? {};
    const namespace = typeof info.namespace === "string" ? info.namespace : "";
    const language = typeof info.language === "string" ? info.language : "";
    for (const el of parsed.elements ?? []) {
      const name = typeof el.name === "string" ? el.name : "";
      if (!name) continue;
      const qualified =
        name.includes(".") || namespace === "" || name.startsWith(`${namespace}.`)
          ? name
          : `${namespace}.${name}`;
      elements.push({
        type: typeof el.type === "string" ? el.type : "UNKNOWN",
        name,
        qualified,
        namespace,
        language,
        brief: stripHtml(el.brief),
        description: stripHtml(el.description),
        parameters: toDocParams(el.parameters),
        returnvalues: toDocParams(el.returnvalues),
        examples: stripHtml(el.examples),
      });
    }
  }

  const index: RefdocIndex = { version: resolved.version, elements };
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify(index));
  refdocMemo.set(resolved.version, index);
  return index;
}

/** List artifact versions already present in the local cache. */
export async function listCachedArtifacts(): Promise<Record<string, string[]>> {
  const { readdir } = await import("node:fs/promises");
  const result: Record<string, string[]> = {};
  for (const kind of ["bob", "engine", "refdoc"]) {
    try {
      result[kind] = (await readdir(path.join(cacheDir(), kind))).filter(
        (d) => !d.startsWith(".")
      );
    } catch {
      result[kind] = [];
    }
  }
  return result;
}
