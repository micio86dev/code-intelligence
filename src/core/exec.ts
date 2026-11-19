import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  input?: string;
  env?: Record<string, string>;
  /** Max bytes kept per stream; the process is killed when exceeded. */
  maxBytes?: number;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** Set when the process could not be spawned (e.g. ENOENT). */
  spawnError: NodeJS.ErrnoException | null;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGKILL"); // whole process group
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a binary with an argv array. Never uses a shell, so arguments cannot be
 * interpreted as shell syntax. Kills the whole process group on timeout.
 */
export function exec(cmd: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> {
  const started = performance.now();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        env: { ...process.env, NO_COLOR: "1", ...opts.env },
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 0,
        spawnError: e as NodeJS.ErrnoException,
      });
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let truncated = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);

    const collect =
      (sink: Buffer[], bytes: () => number, add: (n: number) => void) => (b: Buffer) => {
        if (bytes() >= maxBytes) {
          truncated = true;
          killTree(child);
          return;
        }
        sink.push(b);
        add(b.length);
      };
    child.stdout?.on(
      "data",
      collect(
        out,
        () => outBytes,
        (n) => {
          outBytes += n;
        },
      ),
    );
    child.stderr?.on(
      "data",
      collect(
        err,
        () => errBytes,
        (n) => {
          errBytes += n;
        },
      ),
    );

    child.on("error", (e) => {
      spawnError = e as NodeJS.ErrnoException;
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        truncated,
        durationMs: Math.round(performance.now() - started),
        spawnError,
      });
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
}

/** Locate an executable on PATH (honors PATHEXT on Windows). Returns null if absent. */
export function findBinary(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Split a list into chunks whose joined length stays under a command-line budget. */
export function chunkByLength(items: readonly string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const it of items) {
    const add = it.length + 1;
    if (cur.length > 0 && len + add > maxChars) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(it);
    len += add;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}
