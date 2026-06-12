export const SERVER_NAME = "defold-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Defold official download host (engine archives, bob, ref-doc). */
export const D_DEFOLD_BASE = "https://d.defold.com";
/** Fallback host for bob.jar / ref-doc.zip downloads by version tag. */
export const GITHUB_RELEASES_BASE =
  "https://github.com/defold/defold/releases/download";
export const GITHUB_API_BASE = "https://api.github.com";

/** Default port of the engine service exposed by debug builds of dmengine. */
export const DEFAULT_ENGINE_PORT = 8001;

/** Engine service rejects /post payloads larger than this. */
export const ENGINE_POST_MAX_BYTES = 1024;

/** Maximum characters returned by a single tool response. */
export const CHARACTER_LIMIT = 25000;

/** Maximum bytes of bob output kept in memory. */
export const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Default timeout for bob invocations (first builds download platform SDK archives). */
export const BOB_TIMEOUT_MS = 15 * 60 * 1000;

/** Default timeout for HTTP downloads of toolchain artifacts. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Default timeout for requests against the local engine service. */
export const ENGINE_HTTP_TIMEOUT_MS = 5000;

/** Release channels recognized by resolveVersion. */
export const RELEASE_CHANNELS = ["stable", "beta", "alpha"] as const;

/** How long a resolved channel -> version mapping stays fresh. */
export const CHANNEL_CACHE_TTL_MS = 60 * 60 * 1000;

/** Ring buffer capacity (lines) for game process output and engine log streams. */
export const LOG_RING_CAPACITY = 5000;

/** Java major version required by recent bob.jar releases. */
export const MIN_JAVA_MAJOR = 17;
export const RECOMMENDED_JAVA_MAJOR = 21;
