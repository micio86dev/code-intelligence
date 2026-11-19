import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Finding } from "../types.ts";
import { UsageError } from "./errors.ts";

interface BaselineFile {
  schemaVersion: 1;
  createdAt: string;
  entries: Array<{ fingerprint: string; engine: string; ruleId: string; file: string }>;
}

export function loadBaseline(root: string, path: string): Set<string> | null {
  const abs = join(root, path);
  if (!existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as BaselineFile;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries))
      throw new Error("unsupported schema");
    return new Set(parsed.entries.map((e) => e.fingerprint));
  } catch (e) {
    throw new UsageError(`Cannot read baseline ${path}`, [(e as Error).message]);
  }
}

export function saveBaseline(root: string, path: string, findings: readonly Finding[]): number {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  const seen = new Set<string>();
  const entries = [];
  for (const f of findings) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    entries.push({ fingerprint: f.fingerprint, engine: f.engine, ruleId: f.ruleId, file: f.file });
  }
  entries.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const body: BaselineFile = { schemaVersion: 1, createdAt: new Date().toISOString(), entries };
  writeFileSync(abs, `${JSON.stringify(body, null, 2)}\n`);
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
