/**
 * Activity logging to stderr (stdout is reserved for the stdio transport).
 * Lines are timestamped and prefixed so GUIs (the desktop app console) and
 * humans can follow what the server is doing.
 */

export function logLine(message: string): void {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stderr.write(`[defold-mcp ${ts}] ${message}\n`);
}
