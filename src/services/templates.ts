/**
 * Minimal valid file templates for defold_create_resource, matching what the
 * Defold editor generates for new files.
 */

export const TEMPLATE_TYPES = [
  "script",
  "gui_script",
  "render_script",
  "lua",
  "go",
  "collection",
  "gui",
  "atlas",
  "input_binding",
] as const;

export type TemplateType = (typeof TEMPLATE_TYPES)[number];

/** Extension (with dot) implied by each template type. */
export const TEMPLATE_EXTENSIONS: Record<TemplateType, string> = {
  script: ".script",
  gui_script: ".gui_script",
  render_script: ".render_script",
  lua: ".lua",
  go: ".go",
  collection: ".collection",
  gui: ".gui",
  atlas: ".atlas",
  input_binding: ".input_binding",
};

const SCRIPT_TEMPLATE = `function init(self)
	-- Add initialization code here
	-- Learn more: https://defold.com/manuals/script/
end

function final(self)
	-- Add finalization code here
end

function update(self, dt)
	-- Add update code here
end

function fixed_update(self, dt)
	-- This function is called if 'Fixed Update Frequency' is enabled in the Engine section of game.project
end

function on_message(self, message_id, message, sender)
	-- Add message-handling code here
end

function on_input(self, action_id, action)
	-- Add input-handling code here
end

function on_reload(self)
	-- Add reload-handling code here (called when the script is hot-reloaded)
end
`;

const GUI_SCRIPT_TEMPLATE = `function init(self)
	-- Add initialization code here
end

function final(self)
	-- Add finalization code here
end

function update(self, dt)
	-- Add update code here
end

function on_message(self, message_id, message, sender)
	-- Add message-handling code here
end

function on_input(self, action_id, action)
	-- Add input-handling code here
end

function on_reload(self)
	-- Add reload-handling code here
end
`;

const RENDER_SCRIPT_TEMPLATE = `-- Minimal render script stub.
-- The default Defold render pipeline lives at /builtins/render/default.render_script;
-- copy it as a starting point for real projects (see https://defold.com/manuals/render/).

function init(self)
	self.clear_color = vmath.vector4(0, 0, 0, 1)
end

function update(self)
	render.set_depth_mask(true)
	render.clear({
		[graphics.BUFFER_TYPE_COLOR0_BIT] = self.clear_color,
		[graphics.BUFFER_TYPE_DEPTH_BIT] = 1,
		[graphics.BUFFER_TYPE_STENCIL_BIT] = 0,
	})
end

function on_message(self, message_id, message)
end
`;

const LUA_TEMPLATE = `local M = {}

return M
`;

// An empty .go file is a valid game object with no components.
const GO_TEMPLATE = ``;

const COLLECTION_TEMPLATE = `name: "default"
scale_along_z: 0
`;

const GUI_TEMPLATE = `script: ""
material: "/builtins/materials/gui.material"
adjust_reference: ADJUST_REFERENCE_PARENT
`;

const ATLAS_TEMPLATE = `margin: 0
extrude_borders: 2
inner_padding: 0
`;

const INPUT_BINDING_TEMPLATE = `key_trigger {
  input: KEY_SPACE
  action: "jump"
}
mouse_trigger {
  input: MOUSE_BUTTON_1
  action: "touch"
}
`;

export const TEMPLATES: Record<TemplateType, string> = {
  script: SCRIPT_TEMPLATE,
  gui_script: GUI_SCRIPT_TEMPLATE,
  render_script: RENDER_SCRIPT_TEMPLATE,
  lua: LUA_TEMPLATE,
  go: GO_TEMPLATE,
  collection: COLLECTION_TEMPLATE,
  gui: GUI_TEMPLATE,
  atlas: ATLAS_TEMPLATE,
  input_binding: INPUT_BINDING_TEMPLATE,
};

/** Infer a template type from a file extension, if unambiguous. */
export function templateTypeFromPath(p: string): TemplateType | undefined {
  const lower = p.toLowerCase();
  for (const t of TEMPLATE_TYPES) {
    if (lower.endsWith(TEMPLATE_EXTENSIONS[t])) return t;
  }
  return undefined;
}
