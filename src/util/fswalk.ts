import { opendir } from "node:fs/promises";
import path from "node:path";

/** Directories never considered part of the project source tree. */
export const IGNORED_DIRS = new Set([
  "build",
  ".internal",
  ".git",
  ".svn",
  ".hg",
  ".idea",
  ".vscode",
  "node_modules",
]);

/** Map of file extension (no dot) -> Defold resource type. */
export const RESOURCE_TYPES: Record<string, string> = {
  collection: "collection",
  go: "game_object",
  script: "script",
  gui_script: "gui_script",
  render_script: "render_script",
  editor_script: "editor_script",
  lua: "lua_module",
  gui: "gui",
  atlas: "atlas",
  tilesource: "tilesource",
  tilemap: "tilemap",
  particlefx: "particlefx",
  material: "material",
  font: "font",
  input_binding: "input_binding",
  render: "render",
  display_profiles: "display_profiles",
  texture_profiles: "texture_profiles",
  collisionobject: "collision_object",
  factory: "factory",
  collectionfactory: "collection_factory",
  collectionproxy: "collection_proxy",
  camera: "camera",
  label: "label",
  sprite: "sprite",
  sound: "sound",
  model: "model",
  mesh: "mesh",
  buffer: "buffer",
  animationset: "animation_set",
  gamepads: "gamepads",
  appmanifest: "app_manifest",
  vp: "vertex_program",
  fp: "fragment_program",
  cp: "compute_program",
  glsl: "shader_include",
  png: "image",
  jpg: "image",
  jpeg: "image",
  tga: "image",
  wav: "sound_data",
  ogg: "sound_data",
  opus: "sound_data",
  ttf: "font_data",
  otf: "font_data",
  fnt: "font_data",
  gltf: "model_data",
  glb: "model_data",
  dae: "model_data",
  json: "json",
  proto: "proto",
};

/** Extensions of text-based resource files that can reference other resources. */
export const TEXT_RESOURCE_EXTS = new Set([
  "collection", "go", "gui", "atlas", "tilesource", "tilemap", "particlefx",
  "material", "font", "input_binding", "render", "display_profiles",
  "texture_profiles", "collisionobject", "factory", "collectionfactory",
  "collectionproxy", "camera", "label", "sprite", "sound", "model", "mesh",
  "animationset", "gamepads", "script", "gui_script", "render_script",
  "editor_script", "lua", "appmanifest", "project", "vp", "fp", "cp", "glsl",
]);

export function resourceTypeOf(relPath: string): string {
  const base = path.posix.basename(relPath);
  if (base === "game.project") return "game_project";
  if (base === "ext.manifest") return "extension_manifest";
  const ext = path.posix.extname(base).replace(/^\./, "").toLowerCase();
  return RESOURCE_TYPES[ext] ?? (ext === "" ? "other" : `other (.${ext})`);
}

/**
 * Recursively yield project files as POSIX-style paths relative to root,
 * skipping build output, VCS metadata and hidden directories.
 */
export async function* walkFiles(root: string): AsyncGenerator<string> {
  async function* walk(dirAbs: string, dirRel: string): AsyncGenerator<string> {
    let dir;
    try {
      dir = await opendir(dirAbs);
    } catch {
      return;
    }
    for await (const entry of dir) {
      const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        yield* walk(path.join(dirAbs, entry.name), rel);
      } else if (entry.isFile()) {
        if (entry.name === ".DS_Store") continue;
        yield rel;
      }
    }
  }
  yield* walk(root, "");
}
