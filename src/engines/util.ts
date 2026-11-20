import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { EngineFailure } from "../core/errors.ts";
import { type ExecResult, exec, findBinary } from "../core/exec.ts";
import type { Detection } from "./engine.ts";

/** Run `<binary> <versionArgs>` and parse a semantic version out of the output (null if none). */
export async function readVersion(
  binary: string,
  versionArgs: readonly string[],
): Promise<string | null> {
  const r = await exec(binary, versionArgs, { cwd: process.cwd(), timeoutMs: 15_000 });
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(`${r.stdout}\n${r.stderr}`);
  return m?.[1] ?? null;
}

/**
 * Locate an engine. `withVersion: false` only looks the binary up on PATH (microseconds); asking for the
 * version spawns the tool, and for semgrep (Python) that alone takes about half a second. Scans therefore
 * locate first and read versions concurrently with the engines' own runs; `doctor` asks for versions.
 */
export async function detectBinary(
  binaryName: string,
  versionArgs: readonly string[],
  hint: string,
  withVersion = true,
): Promise<Detection> {
  const binary = findBinary(binaryName);
  if (!binary) {
    return {
      available: false,
      version: null,
      binary: null,
      reason: `'${binaryName}' not found on PATH. ${hint}`,
    };
  }
  const version = withVersion ? await readVersion(binary, versionArgs) : null;
  return { available: true, version, binary, reason: null };
}

export const firstLine = (s: string, max = 300): string =>
  (
    s
      .trim()
      .split("\n")
      .find((l) => l.trim().length > 0) ?? ""
  )
    .trim()
    .slice(0, max);

/** Absolute paths in an engine's error text would leak the machine's layout into reports; replace them. */
export function scrubPaths(s: string): string {
  return s
    .replace(/[A-Za-z]:\\(?:[^\s\\'"]+\\)+[^\s\\'"]*/g, "<path>")
    .replace(/\/(?:[\w.@+~-]+\/)+[\w.@+~-]*/g, "<path>");
}

/**
 * The most useful single line of an engine's stderr, without paths. A Python traceback starts with the
 * boilerplate line "Traceback (most recent call last):" and ends with the actual exception, so for those
 * the last line is reported instead of the first.
 */
export function errorDetail(stderr: string): string {
  const lines = stderr
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "no error output";
  const first = lines[0] ?? "";
  let pick = first;
  // Runtime boilerplate headers say nothing: a Python "Traceback (most recent call last):" or Node's
  // "node:internal/process/promises:394". Prefer the actual exception line, else the last line.
  if (/^(Traceback\b|node:internal|file:\/\/|at\s)/.test(first)) {
    pick =
      lines.find((l) => /^[\w.$]*(Error|Exception)\b.*:/.test(l)) ??
      lines[lines.length - 1] ??
      first;
  }
  // Some tools (osv-scanner) log progress first and the failure later. If the first line does not name a
  // problem, prefer the first line that does; otherwise keep the first line.
  const names = /\b(error|failed|failure|could not|cannot|unable|invalid|unexpected|not found)\b/i;
  if (pick === first && !names.test(first)) pick = lines.find((l) => names.test(l)) ?? first;
  return scrubPaths(pick).slice(0, 300);
}

/** Turn an abnormal process result into a typed failure (never includes stdout, which may hold code). */
export function processFailure(
  name: string,
  r: ExecResult,
  okCodes: readonly number[],
): EngineFailure | null {
  if (r.spawnError)
    return new EngineFailure(
      "error",
      `${name}: cannot start (${r.spawnError.code ?? r.spawnError.message})`,
    );
  if (r.timedOut)
    return new EngineFailure("timeout", `${name}: exceeded the time limit and was killed`);
  if (r.truncated) return new EngineFailure("error", `${name}: output exceeded the size limit`);
  if (r.code === null || !okCodes.includes(r.code)) {
    const detail = errorDetail(r.stderr);
    return new EngineFailure(
      "error",
      `${name}: exited with code ${r.code ?? r.signal} (${detail})`,
    );
  }
  return null;
}

const realRoots = new Map<string, string>();
function realRoot(root: string): string {
  let r = realRoots.get(root);
  if (r === undefined) {
    try {
      r = realpathSync(root);
    } catch {
      r = root;
    }
    realRoots.set(root, r);
  }
  return r;
}

const outside = (rel: string) =>
  rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");

function realPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null; // file vanished or never existed: no real path to offer
  }
}

/**
 * Repo-relative POSIX path from an absolute or already-relative engine path. Tools disagree on whether
 * they report symlink-resolved paths (macOS: /var/... vs /private/var/...): git may give one form and the
 * engine the other, in either direction. So an absolute path is tried as logical and as real, against
 * the root as logical and as real, and the first candidate that stays inside the repository wins.
 */
export function toRel(root: string, p: string): string {
  let rel = p;
  if (isAbsolute(p)) {
    const realP = realPath(p);
    const candidates = [
      relative(root, p),
      relative(realRoot(root), p),
      ...(realP ? [relative(root, realP), relative(realRoot(root), realP)] : []),
    ];
    rel = candidates.find((c) => !outside(c)) ?? candidates[0] ?? p;
  }
  return rel.split(sep).join("/").replace(/^\.\//, "");
}

export function parseJson<T>(name: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new EngineFailure("error", `${name}: produced output that is not valid JSON`);
  }
}
