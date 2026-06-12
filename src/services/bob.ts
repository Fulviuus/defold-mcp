import { spawn } from "node:child_process";
import { BOB_TIMEOUT_MS, MAX_PROCESS_OUTPUT_BYTES } from "../constants.js";
import { ToolFailure } from "../util/errors.js";
import { ensureBob, javaCheck, javaCommand } from "./toolchain.js";

export interface BobDiagnostic {
  severity: "error" | "warning";
  resource?: string;
  line?: number;
  message: string;
}

export interface BobResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  bobVersion: string;
  diagnostics: BobDiagnostic[];
  /** Combined stdout+stderr, possibly tail-truncated. */
  output: string;
}

/**
 * Run bob.jar with the given arguments inside the project root.
 * Ensures Java and bob.jar are available first.
 */
export async function runBob(
  projectRoot: string,
  versionSpec: string,
  args: string[],
  timeoutMs: number = BOB_TIMEOUT_MS
): Promise<BobResult> {
  const java = await javaCheck();
  if (!java.ok) throw new ToolFailure(java.message);
  const { jarPath, resolved } = await ensureBob(versionSpec);

  const fullArgs = ["-jar", jarPath, ...args];
  const started = Date.now();
  const output = await new Promise<{ text: string; code: number | null }>((resolve, reject) => {
    const child = spawn(javaCommand(), fullArgs, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let truncated = false;
    const append = (d: Buffer) => {
      if (buf.length < MAX_PROCESS_OUTPUT_BYTES) {
        buf += d.toString();
        if (buf.length >= MAX_PROCESS_OUTPUT_BYTES) truncated = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new ToolFailure(
          `bob ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            "First builds download platform packages and can be slow; retry or raise timeout_seconds."
        )
      );
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new ToolFailure(`Failed to start java: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ text: truncated ? buf + "\n[bob output truncated]" : buf, code });
    });
  });

  return {
    ok: output.code === 0,
    exitCode: output.code,
    durationMs: Date.now() - started,
    bobVersion: resolved.version,
    diagnostics: parseBobDiagnostics(output.text),
    output: output.text,
  };
}

/**
 * Extract structured diagnostics from bob output. Bob emits lines such as:
 *   ERROR /main/player.script:12: '=' expected near 'x'
 *   WARNING /main/main.collection: some message
 *   /main/player.script:12: some message
 */
export function parseBobDiagnostics(output: string): BobDiagnostic[] {
  const diagnostics: BobDiagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: BobDiagnostic) => {
    const key = `${d.severity}|${d.resource ?? ""}|${d.line ?? ""}|${d.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(d);
    }
  };

  const lineRe =
    /^\s*(ERROR|WARNING)?[:\s]*(\/[^\s:]+?\.[A-Za-z_0-9]+):(\d+)(?::\d+)?:?\s*(.*)$/;
  const bareRe = /^\s*(ERROR|WARNING)[:\s]+(.*)$/;
  // JVM noise emitted by modern JDKs when running bob.jar; not project problems.
  const jvmNoiseRe =
    /restricted method|Restricted methods|--enable-native-access|terminally deprecated|sun\.misc\.Unsafe|java\.lang\.System::load|Please consider reporting/i;

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "" || jvmNoiseRe.test(line)) continue;
    let m = lineRe.exec(line);
    if (m) {
      push({
        severity: m[1]?.toUpperCase() === "WARNING" ? "warning" : "error",
        resource: m[2],
        line: parseInt(m[3], 10),
        message: m[4] || "(no message)",
      });
      continue;
    }
    m = bareRe.exec(line);
    if (m) {
      const msg = m[2].trim();
      // Skip bob's noisy per-file progress lines that start with INFO-like text.
      if (msg !== "") {
        push({ severity: m[1] === "WARNING" ? "warning" : "error", message: msg });
      }
      continue;
    }
    if (/^Exception in thread|^Caused by:|^java\.lang\./.test(line)) {
      push({ severity: "error", message: line.trim() });
    }
  }
  return diagnostics;
}
