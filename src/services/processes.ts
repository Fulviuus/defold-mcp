import { spawn, type ChildProcess } from "node:child_process";

/**
 * Fixed-capacity line buffer that keeps absolute line numbering so callers
 * can page through output with stable offsets.
 */
export class RingBuffer {
  private lines: string[] = [];
  private dropped = 0;

  constructor(private capacity: number) {}

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.capacity) {
      this.lines.shift();
      this.dropped++;
    }
  }

  /** Total lines ever pushed. */
  get total(): number {
    return this.dropped + this.lines.length;
  }

  /** First absolute line index still retained. */
  get firstRetained(): number {
    return this.dropped;
  }

  /**
   * Slice by absolute offset. Negative offset counts from the end
   * (-100 = last 100 lines).
   */
  slice(offset: number, limit: number): { lines: string[]; start: number; total: number } {
    const total = this.total;
    let start = offset < 0 ? Math.max(this.dropped, total + offset) : Math.max(this.dropped, offset);
    if (start > total) start = total;
    const beginIdx = start - this.dropped;
    return { lines: this.lines.slice(beginIdx, beginIdx + limit), start, total };
  }
}

/** Incrementally split a byte stream into lines. */
export function makeLineSplitter(onLine: (line: string) => void): {
  push: (chunk: Buffer) => void;
  flush: () => void;
} {
  let pending = "";
  return {
    push(chunk: Buffer) {
      pending += chunk.toString("utf8");
      for (;;) {
        const nl = pending.indexOf("\n");
        if (nl < 0) break;
        onLine(pending.slice(0, nl).replace(/\r$/, ""));
        pending = pending.slice(nl + 1);
      }
    },
    flush() {
      if (pending !== "") {
        onLine(pending.replace(/\r$/, ""));
        pending = "";
      }
    },
  };
}

export interface GameProcess {
  key: string;
  command: string;
  args: string[];
  cwd: string;
  pid?: number;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  child: ChildProcess;
  logs: RingBuffer;
}

export interface GameStatus {
  key: string;
  running: boolean;
  pid?: number;
  startedAt: string;
  uptimeSeconds?: number;
  exitCode?: number | null;
  signal?: string | null;
  logLines: number;
}

/** Manages dmengine instances launched by the defold_run tool, keyed by project root. */
export class GameProcessManager {
  private processes = new Map<string, GameProcess>();

  constructor(private logCapacity: number) {}

  isRunning(key: string): boolean {
    const p = this.processes.get(key);
    return !!p && p.exitedAt === undefined;
  }

  get(key: string): GameProcess | undefined {
    return this.processes.get(key);
  }

  launch(key: string, command: string, args: string[], cwd: string, extraEnv?: Record<string, string>): GameProcess {
    const logs = new RingBuffer(this.logCapacity);
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const proc: GameProcess = {
      key,
      command,
      args,
      cwd,
      pid: child.pid,
      startedAt: Date.now(),
      child,
      logs,
    };
    const out = makeLineSplitter((l) => logs.push(l));
    const err = makeLineSplitter((l) => logs.push(l));
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      logs.push(`[defold-mcp] failed to start process: ${e.message}`);
      proc.exitedAt = Date.now();
      proc.exitCode = null;
    });
    child.on("close", (code, signal) => {
      out.flush();
      err.flush();
      proc.exitedAt = Date.now();
      proc.exitCode = code;
      proc.signal = signal;
      logs.push(`[defold-mcp] process exited (code=${code ?? "null"}, signal=${signal ?? "none"})`);
    });
    this.processes.set(key, proc);
    return proc;
  }

  status(key: string): GameStatus | undefined {
    const p = this.processes.get(key);
    if (!p) return undefined;
    const running = p.exitedAt === undefined;
    return {
      key,
      running,
      pid: p.pid,
      startedAt: new Date(p.startedAt).toISOString(),
      uptimeSeconds: running ? Math.round((Date.now() - p.startedAt) / 1000) : undefined,
      exitCode: p.exitedAt !== undefined ? p.exitCode : undefined,
      signal: p.exitedAt !== undefined ? p.signal : undefined,
      logLines: p.logs.total,
    };
  }

  list(): GameStatus[] {
    return [...this.processes.keys()]
      .map((k) => this.status(k))
      .filter((s): s is GameStatus => s !== undefined);
  }

  /** Graceful stop: SIGTERM, then SIGKILL after gracePeriodMs. */
  async stop(key: string, gracePeriodMs = 3000): Promise<GameStatus | undefined> {
    const p = this.processes.get(key);
    if (!p) return undefined;
    if (p.exitedAt !== undefined) return this.status(key);
    p.child.kill("SIGTERM");
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), gracePeriodMs);
      p.child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      p.child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        p.child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.status(key);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.processes.keys()].map((k) => this.stop(k, 1000)));
  }
}
