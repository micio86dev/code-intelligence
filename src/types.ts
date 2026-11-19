export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ["secrets", "sast", "deps", "architecture"] as const;
export type Category = (typeof CATEGORIES)[number];

export const PROFILES = ["quick", "deep"] as const;
export type ProfileName = (typeof PROFILES)[number];

export type TargetMode = "changed" | "staged" | "since" | "all";

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

/** A normalized finding as exposed to users and agents. Never contains the matched secret. */
export interface Finding {
  fingerprint: string;
  engine: string;
  ruleId: string;
  category: Category;
  severity: Severity;
  /** Repo-relative POSIX path. */
  file: string;
  line: number | null;
  endLine: number | null;
  message: string;
  remediation: string | null;
  references: string[];
  /** Other engines that independently reported the same issue at the same place (merged into this one). */
  alsoReportedBy: string[];
}

/** What an engine adapter returns; the core derives the fingerprint. */
export interface RawFinding extends Omit<Finding, "fingerprint" | "alsoReportedBy"> {
  /** Stable identity when no source line exists (e.g. "lodash@4.17.15#GHSA-xxxx"). */
  key?: string;
}

export type EngineStatus = "ok" | "findings" | "skipped" | "unavailable" | "timeout" | "error";

export interface EngineResult {
  engine: string;
  category: Category;
  version: string | null;
  status: EngineStatus;
  reason: string | null;
  warnings: string[];
  durationMs: number;
  findingCount: number;
  cached: boolean;
  /** Number of files handed to the engine (null when it scans a whole root). */
  filesScanned: number | null;
}

export interface LineRange {
  start: number;
  end: number;
}

export interface ScanTarget {
  root: string;
  mode: TargetMode;
  ref: string | null;
  isGit: boolean;
  /** Repo-relative POSIX paths after exclusions. */
  files: string[];
  /** Added/changed line ranges per file. Absent entry = whole file counts as changed. */
  changedLines: Map<string, LineRange[]>;
  excludedCount: number;
}
