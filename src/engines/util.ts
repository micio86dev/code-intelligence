import { isAbsolute, relative, sep } from "node:path";
import { EngineFailure } from "../core/errors.ts";
import { type ExecResult, exec, findBinary } from "../core/exec.ts";
import type { Detection } from "./engine.ts";

export async function detectBinary(
  binaryName: string,
  versionArgs: string[],
  hint: string,
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
  const r = await exec(binary, versionArgs, { cwd: process.cwd(), timeoutMs: 15_000 });
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(`${r.stdout}\n${r.stderr}`);
  return { available: true, version: m?.[1] ?? null, binary, reason: null };
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
    const detail = firstLine(r.stderr) || "no error output";
    return new EngineFailure(
      "error",
      `${name}: exited with code ${r.code ?? r.signal} (${detail})`,
    );
  }
  return null;
}

/** Repo-relative POSIX path from an absolute or already-relative engine path. */
export function toRel(root: string, p: string): string {
  const rel = isAbsolute(p) ? relative(root, p) : p;
  return rel.split(sep).join("/").replace(/^\.\//, "");
}

export function parseJson<T>(name: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new EngineFailure("error", `${name}: produced output that is not valid JSON`);
  }
}
