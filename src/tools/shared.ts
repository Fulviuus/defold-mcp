import { z } from "zod";
import { DEFAULT_ENGINE_PORT } from "../constants.js";

export const projectRootParam = z
  .string()
  .optional()
  .describe(
    "Path to the Defold project root (the directory containing game.project). " +
      "Defaults to the DEFOLD_PROJECT_ROOT environment variable, or the nearest " +
      "ancestor of the server's working directory that contains game.project."
  );

export const versionParam = z
  .string()
  .default("stable")
  .describe(
    'Defold release to use: "stable", "beta", "alpha" or an explicit version like "1.12.4". Default "stable".'
  );

export const responseFormatParam = z
  .enum(["markdown", "json"])
  .default("markdown")
  .describe('Output format: "markdown" (human readable, default) or "json" (machine readable).');

export const hostParam = z
  .string()
  .default("localhost")
  .describe('Host/IP of the running game. Default "localhost"; use the device IP for mobile builds.');

export const portParam = z
  .number()
  .int()
  .min(1)
  .max(65535)
  .default(DEFAULT_ENGINE_PORT)
  .describe(`Engine service HTTP port of the running game (default ${DEFAULT_ENGINE_PORT}).`);

export const limitParam = (def: number, max: number) =>
  z.number().int().min(1).max(max).default(def).describe(`Maximum results to return (default ${def}).`);

export const offsetParam = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Number of results to skip, for pagination (default 0).");

export interface Page<T> {
  items: T[];
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
}

export function paginate<T>(all: T[], limit: number, offset: number): Page<T> {
  const items = all.slice(offset, offset + limit);
  const hasMore = offset + items.length < all.length;
  return {
    items,
    total: all.length,
    count: items.length,
    offset,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + items.length } : {}),
  };
}

export function paginationFooter(page: Page<unknown>, what: string): string {
  if (page.total === 0) return `No ${what} found.`;
  const range = `${page.offset + 1}-${page.offset + page.count} of ${page.total}`;
  return page.has_more
    ? `Showing ${what} ${range}. More available: pass offset=${page.next_offset}.`
    : `Showing ${what} ${range}.`;
}

/** Normalize any user-supplied path into a Defold resource path with leading slash. */
export function normalizeResourcePath(p: string): string {
  let out = p.trim().replace(/\\/g, "/");
  if (!out.startsWith("/")) out = "/" + out;
  return out;
}
