import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CHARACTER_LIMIT } from "../constants.js";

/**
 * Error whose message is intended for the calling agent: actionable,
 * self-contained, and safe to surface verbatim.
 */
export class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

/** Clip a response to CHARACTER_LIMIT with an explanatory notice. */
export function clipText(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit);
  return (
    clipped +
    `\n\n[Output truncated: showing ${clipped.length} of ${text.length} characters. ` +
    `Use limit/offset parameters or narrower filters to see the rest.]`
  );
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text: clipText(text) }] };
}

export function errorResult(message: string): CallToolResult {
  const text = message.startsWith("Error") ? message : `Error: ${message}`;
  return { isError: true, content: [{ type: "text", text: clipText(text) }] };
}

/**
 * Wrap a tool handler so that ToolFailure (and unexpected exceptions) become
 * in-band tool errors instead of protocol errors.
 */
export function runTool(
  fn: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  return fn().catch((err: unknown) => {
    if (err instanceof ToolFailure) return errorResult(err.message);
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`Unexpected error: ${msg}`);
  });
}

/** JSON stringify helper used by response_format="json" outputs. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
