import { exec } from "../core/exec.ts";
import type { RawFinding, Severity } from "../types.ts";
import { basename, type Engine, type EngineOutput, isLockfile, type RunContext } from "./engine.ts";
import { detectBinary, parseJson, processFailure, toRel } from "./util.ts";

interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { name?: string; ecosystem?: string };
    ranges?: Array<{ events?: Array<{ fixed?: string }> }>;
  }>;
}
interface OsvOutput {
  results?: Array<{
    source: { path: string };
    packages?: Array<{
      package: { name: string; version: string; ecosystem: string };
      vulnerabilities?: OsvVuln[];
      groups?: Array<{ ids: string[]; max_severity?: string }>;
    }>;
  }>;
}

export function cvssToSeverity(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

const LABEL: Record<string, Severity> = {
  LOW: "low",
  MODERATE: "medium",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
};

function fixedVersions(v: OsvVuln, pkg: string, eco: string): string[] {
  const out = new Set<string>();
  for (const a of v.affected ?? []) {
    if (a.package?.name !== pkg || a.package?.ecosystem !== eco) continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) out.add(e.fixed);
  }
  return [...out];
}

export const osvScanner: Engine = {
  name: "osv-scanner",
  category: "deps",
  priority: 0,
  binaryName: "osv-scanner",
  installHint:
    "Install: brew install osv-scanner (or go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest)",
  detect: () => detectBinary("osv-scanner", ["--version"], osvScanner.installHint),
  select(target) {
    const files = target.files.filter(isLockfile);
    return files.length > 0
      ? { files, skipReason: null }
      : { files: null, skipReason: "no lockfile or manifest in scope" };
  },
  // Vulnerability databases change daily: identical inputs can have different results.
  cacheable: () => false,
  cacheInputs: () => [],
  async run(ctx: RunContext): Promise<EngineOutput> {
    const args = ["scan", "source", "--format", "json"];
    for (const f of ctx.files) args.push("--lockfile", f.startsWith("-") ? `./${f}` : f);
    const r = await exec(ctx.binary, args, { cwd: ctx.root, timeoutMs: ctx.timeoutMs });
    // 0 = clean, 1 = vulnerabilities found, 128 = nothing parseable in the given files
    const fail = processFailure("osv-scanner", r, [0, 1, 128]);
    if (fail) throw fail;
    const warnings: string[] = [];
    if (r.code === 128 || !r.stdout.trim()) {
      warnings.push(
        `osv-scanner found no resolvable packages in: ${ctx.files.map(basename).join(", ")}`,
      );
      return { findings: [], warnings };
    }
    const out = parseJson<OsvOutput>("osv-scanner", r.stdout);
    const findings: RawFinding[] = [];
    for (const res of out.results ?? []) {
      const file = toRel(ctx.root, res.source.path);
      for (const pk of res.packages ?? []) {
        const { name, version, ecosystem } = pk.package;
        const byId = new Map((pk.vulnerabilities ?? []).map((v) => [v.id, v]));
        for (const g of pk.groups ?? []) {
          const v = g.ids.map((id) => byId.get(id)).find(Boolean);
          if (!v) continue;
          const score = Number(g.max_severity);
          const severity =
            Number.isFinite(score) && g.max_severity
              ? cvssToSeverity(score)
              : (LABEL[(v.database_specific?.severity ?? "").toUpperCase()] ?? "medium");
          const fixed = fixedVersions(v, name, ecosystem);
          const aliases = [...new Set([...g.ids, ...(v.aliases ?? [])])].filter((a) => a !== v.id);
          findings.push({
            engine: "osv-scanner",
            ruleId: v.id,
            category: "deps",
            severity,
            file,
            line: null,
            endLine: null,
            message: `${name}@${version} (${ecosystem}) is affected by ${v.id}${aliases.length ? ` (${aliases.slice(0, 3).join(", ")})` : ""}: ${v.summary ?? "see advisory"}`,
            remediation: fixed.length
              ? `Upgrade ${name} to ${fixed.slice(0, 3).join(" or ")} or later.`
              : `No fixed version is published for ${name}; replace it or mitigate the affected code path.`,
            references: [`https://osv.dev/${v.id}`],
            key: `${ecosystem}:${name}@${version}#${v.id}`,
          });
        }
      }
    }
    return { findings, warnings };
  },
};
