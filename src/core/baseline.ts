import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../types.ts";
import { UsageError } from "./errors.ts";
import { assertPlainPath, safeWrite, UnsafePathError } from "./safefs.ts";

interface BaselineFile {
  schemaVersion: 1;
  createdAt: string;
  entries: Array<{ fingerprint: string; engine: string; ruleId: string; file: string }>;
}

export function loadBaseline(root: string, path: string): Set<string> | null {
  const abs = join(root, path);
  try {
    assertPlainPath(root, path); // no symlink anywhere in the path, not only at the end
  } catch (e) {
    if (e instanceof UnsafePathError)
      throw new UsageError(`Refusing to read baseline ${path}: ${e.message}`);
    throw e;
  }
  if (!existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as BaselineFile;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries))
      throw new Error("unsupported schema");
    return new Set(parsed.entries.map((e) => e.fingerprint));
  } catch {
    // Never echo the parser's message: it quotes the file's text.
    throw new UsageError(`Cannot read baseline ${path}`, ["not a valid code-intel baseline file"]);
  }
}

export function saveBaseline(root: string, path: string, findings: readonly Finding[]): number {
  const seen = new Set<string>();
  const entries = [];
  for (const f of findings) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    entries.push({ fingerprint: f.fingerprint, engine: f.engine, ruleId: f.ruleId, file: f.file });
  }
  entries.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const body: BaselineFile = { schemaVersion: 1, createdAt: new Date().toISOString(), entries };
  try {
    safeWrite(root, path, `${JSON.stringify(body, null, 2)}\n`);
  } catch (e) {
    if (e instanceof UnsafePathError) throw new UsageError(`Cannot write baseline: ${e.message}`);
    throw e;
  }
  return entries.length;
}

export function applyBaseline(
  findings: Finding[],
  baseline: Set<string> | null,
): { kept: Finding[]; suppressed: number } {
  if (!baseline) return { kept: findings, suppressed: 0 };
  const kept = findings.filter((f) => !baseline.has(f.fingerprint));
  return { kept, suppressed: findings.length - kept.length };
}
