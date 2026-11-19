import { exec } from "../core/exec.ts";
import type { RawFinding, Severity } from "../types.ts";
import { type Engine, type EngineOutput, isLockfile, type RunContext } from "./engine.ts";
import { detectBinary, parseJson, processFailure } from "./util.ts";

interface TrivyOutput {
  Results?: Array<{
    Target: string;
    Type?: string;
    Vulnerabilities?: Array<{
      VulnerabilityID: string;
      PkgName: string;
      InstalledVersion: string;
      FixedVersion?: string;
      Severity?: string;
      Title?: string;
      PrimaryURL?: string;
    }>;
  }>;
}

const SEVERITY: Record<string, Severity> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  UNKNOWN: "low",
};

/** Fallback for the `deps` category when osv-scanner is not installed. Scans lockfiles one by one. */
export const trivy: Engine = {
  name: "trivy",
  category: "deps",
  priority: 1,
  binaryName: "trivy",
  installHint: "Install: brew install trivy (or see https://trivy.dev)",
  detect: () => detectBinary("trivy", ["--version"], trivy.installHint),
  select(target) {
    const files = target.files.filter(isLockfile);
    return files.length > 0
      ? { files, skipReason: null }
      : { files: null, skipReason: "no lockfile or manifest in scope" };
  },
  cacheable: () => false, // vulnerability DB changes over time
  cacheInputs: () => [],
  async run(ctx: RunContext): Promise<EngineOutput> {
    const findings: RawFinding[] = [];
    // One trivy process at a time: concurrent runs contend on its vulnerability DB lock.
    for (const file of ctx.files) {
      const r = await exec(
        ctx.binary,
        [
          "fs",
          "--scanners",
          "vuln",
          "--format",
          "json",
          "--quiet",
          "--skip-version-check",
          file.startsWith("-") ? `./${file}` : file,
        ],
        { cwd: ctx.root, timeoutMs: ctx.timeoutMs },
      );
      const fail = processFailure("trivy", r, [0]);
      if (fail) throw fail;
      const out = parseJson<TrivyOutput>("trivy", r.stdout);
      for (const res of out.Results ?? []) {
        for (const v of res.Vulnerabilities ?? []) {
          const fixed =
            v.FixedVersion?.split(",")
              .map((x) => x.trim())
              .filter(Boolean) ?? [];
          findings.push({
            engine: "trivy",
            ruleId: v.VulnerabilityID,
            category: "deps",
            severity: SEVERITY[(v.Severity ?? "").toUpperCase()] ?? "medium",
            file,
            line: null,
            endLine: null,
            message: `${v.PkgName}@${v.InstalledVersion}${res.Type ? ` (${res.Type})` : ""} is affected by ${v.VulnerabilityID}: ${v.Title ?? "see advisory"}`,
            remediation: fixed.length
              ? `Upgrade ${v.PkgName} to ${fixed.slice(0, 3).join(" or ")} or later.`
              : `No fixed version is published for ${v.PkgName}; replace it or mitigate the affected code path.`,
            references: v.PrimaryURL ? [v.PrimaryURL] : [],
            key: `${res.Type ?? "pkg"}:${v.PkgName}@${v.InstalledVersion}#${v.VulnerabilityID}`,
          });
        }
      }
    }
    return { findings, warnings: [] };
  },
};
