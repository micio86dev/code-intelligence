import { join } from "node:path";
import { applyBaseline, loadBaseline } from "../core/baseline.ts";
import { ResultCache } from "../core/cache.ts";
import { CONFIG_FILE, type Config, describeNonDefaults, loadConfig } from "../core/config.ts";
import { UsageError } from "../core/errors.ts";
import type { Logger } from "../core/logger.ts";
import {
  filterToChangedLines,
  mergeDuplicateSecrets,
  sortFindings,
  toFindings,
} from "../core/normalize.ts";
import { plan } from "../core/planner.ts";
import { runPlan } from "../core/runner.ts";
import { lexists } from "../core/safefs.ts";
import { findGitRoot, resolveTarget } from "../core/targets.ts";
import type { Engine } from "../engines/engine.ts";
import { ENGINES } from "../engines/registry.ts";
import {
  type EngineResult,
  type Finding,
  type ProfileName,
  SEVERITIES,
  type Severity,
  severityRank,
  type TargetMode,
} from "../types.ts";
import { TOOL_NAME, VERSION } from "../version.ts";

export interface ScanOptions {
  cwd: string;
  profile: ProfileName;
  mode: TargetMode | null;
  ref: string | null;
  engines: string[] | null;
  failOn: Severity | null;
  timeoutMs: number | null;
  cache: boolean;
  newOnly: boolean;
  ignoreRepoConfig: boolean;
  allowMissing: boolean;
  log: Logger;
  /** Test seam: replace the engine set. */
  engineSet?: readonly Engine[];
}

export interface ScanReport {
  schemaVersion: 1;
  tool: { name: string; version: string };
  profile: ProfileName;
  target: {
    mode: TargetMode;
    ref: string | null;
    isGit: boolean;
    fileCount: number;
    excludedCount: number;
  };
  /** False when any planned engine could not complete (timeout, error, or missing and not allowed). */
  complete: boolean;
  durationMs: number;
  engines: EngineResult[];
  summary: {
    total: number;
    bySeverity: Record<Severity, number>;
    failOn: Severity;
    newOnly: boolean;
    suppressed: { outsideChangedLines: number; baseline: number };
  };
  findings: Finding[];
  /** Repository-supplied configuration that shaped this scan (it can weaken a scan, so it is always disclosed). */
  config: { file: string | null; ignored: boolean; inEffect: string[] };
  exitCode: 0 | 1 | 3;
}

function configDisclosure(
  root: string,
  config: Config,
  baselineInUse: boolean,
): ScanReport["config"] {
  const file = lexists(join(root, CONFIG_FILE)) ? CONFIG_FILE : null;
  if (config.repoConfigIgnored) return { file, ignored: true, inEffect: [] };
  const inEffect = describeNonDefaults(config);
  for (const f of [".gitleaks.toml", ".gitleaksignore", ".semgrepignore"]) {
    if (lexists(join(root, f))) inEffect.push(`${f} present`);
  }
  if (baselineInUse) inEffect.push("baseline in use");
  return { file, ignored: false, inEffect };
}

export const countBySeverity = (findings: readonly Finding[]): Record<Severity, number> => {
  const out = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) out[f.severity] += 1;
  return out;
};

export async function runScan(
  opts: ScanOptions,
): Promise<{ report: ScanReport; root: string; config: Config }> {
  const started = performance.now();
  const engines = opts.engineSet ?? ENGINES;
  const root = (await findGitRoot(opts.cwd)) ?? opts.cwd;
  if (opts.ignoreRepoConfig && opts.newOnly) {
    throw new UsageError(
      "--new-only needs the repository's baseline, which --ignore-repo-config discards",
    );
  }
  const config = loadConfig(
    root,
    engines.map((e) => e.name),
    { ignoreRepoConfig: opts.ignoreRepoConfig },
  );
  const profile = config.profiles[opts.profile];
  const selectors = opts.engines ?? profile.engines;
  if (selectors.length === 0) throw new UsageError("No engines selected");

  const target = await resolveTarget({
    cwd: opts.cwd,
    mode: opts.mode,
    ref: opts.ref,
    exclude: config.exclude,
  });
  opts.log.info("target resolved", {
    mode: target.mode,
    files: target.files.length,
    excluded: target.excludedCount,
  });

  const entries = await plan(engines, selectors, target, opts.profile);
  const { results, findings: raws } = await runPlan(entries, {
    root: target.root,
    config,
    mode: target.mode,
    timeoutMs: opts.timeoutMs ?? profile.timeoutMs,
    cache: new ResultCache(target.root, opts.cache),
    log: opts.log,
  });

  const allowMissing = opts.allowMissing || config.allowMissingEngines;
  const complete = results.every(
    (r) =>
      r.status === "ok" ||
      r.status === "findings" ||
      r.status === "skipped" ||
      (r.status === "unavailable" && allowMissing),
  );

  const normalized = mergeDuplicateSecrets(toFindings(raws, target.root));
  const { kept: inDiff, suppressed: outsideChangedLines } = filterToChangedLines(
    normalized,
    target,
    config.lineFilter,
  );
  const baseline = opts.newOnly ? loadBaseline(target.root, config.baseline) : null;
  if (opts.newOnly && baseline === null) {
    opts.log.warn("--new-only requested but no baseline exists; reporting every finding", {
      path: config.baseline,
    });
  }
  const { kept, suppressed: baselineSuppressed } = applyBaseline(inDiff, baseline);
  const findings = sortFindings(kept);

  const failOn = opts.failOn ?? config.failOn;
  const blocking = findings.some((f) => severityRank(f.severity) >= severityRank(failOn));
  const exitCode: 0 | 1 | 3 = blocking ? 1 : complete ? 0 : 3;

  const report: ScanReport = {
    schemaVersion: 1,
    tool: { name: TOOL_NAME, version: VERSION },
    profile: opts.profile,
    target: {
      mode: target.mode,
      ref: target.ref,
      isGit: target.isGit,
      fileCount: target.files.length,
      excludedCount: target.excludedCount,
    },
    complete,
    durationMs: Math.round(performance.now() - started),
    engines: results,
    summary: {
      total: findings.length,
      bySeverity: countBySeverity(findings),
      failOn,
      newOnly: opts.newOnly,
      suppressed: { outsideChangedLines, baseline: baselineSuppressed },
    },
    findings,
    config: configDisclosure(target.root, config, Boolean(baseline)),
    exitCode,
  };
  return { report, root: target.root, config };
}
