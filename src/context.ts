import { realpathSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolFailure } from "./util/errors.js";

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Walk up from a directory looking for game.project. */
async function findProjectUp(startDir: string): Promise<string | undefined> {
  let dir = path.resolve(startDir);
  for (;;) {
    if (await exists(path.join(dir, "game.project"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve the Defold project root for a tool call.
 * Order: explicit parameter, DEFOLD_PROJECT_ROOT env var, search upward from cwd.
 */
export async function resolveProjectRoot(
  input?: string,
  opts: { requireGameProject?: boolean } = {}
): Promise<string> {
  const requireGameProject = opts.requireGameProject ?? true;

  let root: string | undefined;
  if (input && input.trim() !== "") {
    root = path.resolve(expandHome(input.trim()));
    if (!(await exists(root))) {
      throw new ToolFailure(`project_root '${input}' does not exist.`);
    }
    const st = await stat(root);
    if (!st.isDirectory()) {
      // Allow passing the game.project file itself.
      if (path.basename(root) === "game.project") {
        root = path.dirname(root);
      } else {
        throw new ToolFailure(`project_root '${input}' is not a directory.`);
      }
    }
  } else if (process.env.DEFOLD_PROJECT_ROOT) {
    root = path.resolve(expandHome(process.env.DEFOLD_PROJECT_ROOT));
  } else {
    root = await findProjectUp(process.cwd());
  }

  if (!root) {
    throw new ToolFailure(
      "Could not locate a Defold project (no game.project found). " +
        "Pass project_root explicitly, or set the DEFOLD_PROJECT_ROOT environment variable " +
        "in the MCP server configuration."
    );
  }
  if (requireGameProject && !(await exists(path.join(root, "game.project")))) {
    throw new ToolFailure(
      `'${root}' does not contain a game.project file, so it is not a Defold project root. ` +
        "Pass the directory that contains game.project as project_root."
    );
  }
  return root;
}

export function gameProjectPath(root: string): string {
  return path.join(root, "game.project");
}

/** realpath the nearest existing ancestor of `p`, re-appending the missing tail. */
function realpathOfNearestAncestor(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p; // hit filesystem root without resolving
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Convert a Defold resource path ("/main/player.script") or a relative path
 * into an absolute filesystem path, rejecting traversal outside the project.
 *
 * The check is both lexical (blocks ../ and absolute escapes) and
 * symlink-aware: the nearest existing ancestor of the target is realpath'd and
 * compared against the realpath'd project root, so a symlink planted inside the
 * project cannot redirect reads/writes outside it.
 */
export function resourceToAbsolute(root: string, resourcePath: string): string {
  const rel = resourcePath.replace(/^\/+/, "");
  const normalizedRoot = path.resolve(root);
  const abs = path.resolve(normalizedRoot, rel);
  const escapes = (child: string, base: string): boolean =>
    child !== base && !child.startsWith(base + path.sep);

  if (escapes(abs, normalizedRoot)) {
    throw new ToolFailure(
      `Path '${resourcePath}' escapes the project root. Use project-relative paths like "/main/player.script".`
    );
  }
  // Symlink-aware re-check on the resolved real paths.
  const realRoot = realpathOfNearestAncestor(normalizedRoot);
  const realAbs = realpathOfNearestAncestor(abs);
  if (escapes(realAbs, realRoot)) {
    throw new ToolFailure(
      `Path '${resourcePath}' resolves (via a symlink) outside the project root, which is not allowed.`
    );
  }
  return abs;
}

/** Convert an absolute path into a Defold resource path ("/main/foo.script"). */
export function absoluteToResource(root: string, abs: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  return "/" + rel.split(path.sep).join("/");
}
