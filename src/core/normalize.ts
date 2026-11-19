import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Finding, type RawFinding, type ScanTarget, severityRank } from "../types.ts";

export function hash16(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** Collapse whitespace so reformatting does not change a fingerprint. */
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

class LineReader {
  private readonly cache = new Map<string, string[] | null>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  line(file: string, n: number): string | null {
    let lines = this.cache.get(file);
    if (lines === undefined) {
      try {
        lines = readFileSync(join(this.root, file), "utf8").split("\n");
      } catch {
        lines = null;
      }
      this.cache.set(file, lines);
    }
    return lines?.[n - 1] ?? null;
  }
}

/**
 * Derive stable fingerprints (engine + rule + path + normalized source line, or the
 * adapter's explicit key) so a finding keeps its identity when lines above it move.
 * The source line is only hashed, never emitted, so secrets cannot leak through it.
 */
export function toFindings(raws: readonly RawFinding[], root: string): Finding[] {
  const reader = new LineReader(root);
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const r of raws) {
    const { key, ...rest } = r;
    const basis =
      key ??
      (r.line !== null ? squash(reader.line(r.file, r.line) ?? r.message) : squash(r.message));
    const fingerprint = hash16(r.engine, r.ruleId, r.file, basis);
    const dedupeKey = `${fingerprint}:${r.line ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ fingerprint, ...rest });
  }
  return out;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      a.file.localeCompare(b.file) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

/**
 * Drop SAST findings on lines the change did not touch. Findings with no line, in files
 * without a diff entry (untracked = whole file), or outside SAST are always kept.
 * Returns the number suppressed so reports can say so instead of hiding it.
 */
export function filterToChangedLines(
  findings: Finding[],
  target: ScanTarget,
  enabled: boolean,
): { kept: Finding[]; suppressed: number } {
  if (!enabled || target.mode === "all") return { kept: findings, suppressed: 0 };
  const kept: Finding[] = [];
  let suppressed = 0;
  for (const f of findings) {
    const ranges = target.changedLines.get(f.file);
    if (f.category !== "sast" || f.line === null || ranges === undefined) {
      kept.push(f);
      continue;
    }
    const end = Math.max(f.line, f.endLine ?? f.line); // tolerate adapters reporting endLine < line
    if (ranges.some((r) => f.line !== null && f.line <= r.end && end >= r.start)) kept.push(f);
    else suppressed += 1;
  }
  return { kept, suppressed };
}
