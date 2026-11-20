import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../core/config.ts";
import { exec } from "../core/exec.ts";
import { hashPaths } from "../core/hashing.ts";
import { isPlainFileInside } from "../core/safefs.ts";
import type { RawFinding } from "../types.ts";
import { type Engine, type EngineOutput, isLockfile, type RunContext } from "./engine.ts";
import { detectBinary, parseJson, processFailure, toRel } from "./util.ts";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface GitleaksLeak {
  RuleID: string;
  Description: string;
  StartLine: number;
  EndLine: number;
  File: string;
}

const REMEDIATION =
  "Revoke and rotate this credential now, remove it from the code and git history, and load it from a secret manager or environment variable.";

/** Stage only the files in scope into a temp dir (hardlink, copy as fallback) so gitleaks scans exactly them. */
function stage(root: string, files: readonly string[]): { dir: string; skippedLarge: number } {
  const dir = mkdtempSync(join(tmpdir(), "code-intel-gl-"));
  let skippedLarge = 0;
  for (const f of files) {
    const src = join(root, f);
    try {
      if (statSync(src).size > MAX_FILE_BYTES) {
        skippedLarge += 1;
        continue;
      }
      const dst = join(dir, f);
      mkdirSync(dirname(dst), { recursive: true });
      try {
        linkSync(src, dst);
      } catch {
        copyFileSync(src, dst);
      }
    } catch {
      /* file vanished between listing and scan */
    }
  }
  return { dir, skippedLarge };
}

export const gitleaks: Engine = {
  name: "gitleaks",
  category: "secrets",
  priority: 0,
  binaryName: "gitleaks",
  installHint:
    "Install: brew install gitleaks (or see https://github.com/gitleaks/gitleaks#installing)",
  detect: () => detectBinary("gitleaks", ["version"], gitleaks.installHint),
  select(target) {
    const files = target.files.filter((f) => !isLockfile(f));
    return files.length > 0
      ? { files, skipReason: null }
      : { files: null, skipReason: "no scannable files in scope" };
  },
  cacheable: () => true,
  cacheInputs: (c: Config, root: string) => [
    c.engines.gitleaks.configPath ?? "",
    String(c.repoConfigIgnored),
    // Results depend on the contents of the repository's gitleaks config and ignore file, not just their names.
    hashPaths(root, [c.engines.gitleaks.configPath ?? ".gitleaks.toml", ".gitleaksignore"]),
  ],
  async run(ctx: RunContext): Promise<EngineOutput> {
    // gitleaks auto-discovers <scanned dir>/.gitleaks.toml, so with --ignore-repo-config the repository's own
    // gitleaks files must not be staged into the directory it scans.
    const files = ctx.config.repoConfigIgnored
      ? ctx.files.filter((f) => f !== ".gitleaks.toml" && f !== ".gitleaksignore")
      : ctx.files;
    if (files.length === 0) return { findings: [], warnings: [] };
    const { dir, skippedLarge } = stage(ctx.root, files);
    try {
      // Scan "." with the staging directory as the working directory: gitleaks then reports repo-relative
      // paths and fingerprints (creds.txt:rule:line), exactly like a manual run, so a user's own
      // .gitleaksignore entries match.
      const args = [
        "dir",
        ".",
        "--no-banner",
        "--no-color",
        "--redact",
        "--exit-code",
        "0",
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--max-target-megabytes",
        "5",
      ];
      const repoWarnings: string[] = [];
      if (ctx.config.repoConfigIgnored) {
        // By default gitleaks reads .gitleaksignore from its working directory (the repository root).
        // Point it at the staging directory, which cannot contain one.
        args.push("--gitleaks-ignore-path", dir);
      } else {
        const cfgPath = ctx.config.engines.gitleaks.configPath;
        const cfgRel = cfgPath ?? ".gitleaks.toml";
        const cfg = join(ctx.root, cfgRel);
        if (isPlainFileInside(ctx.root, cfgRel)) {
          args.push("--config", cfg);
          repoWarnings.push(
            "using the repository's gitleaks configuration, which can allowlist paths or rules (--ignore-repo-config disables it)",
          );
        } else if (cfgPath) throw new Error(`gitleaks config not found: ${cfgPath}`);
        const ignore = join(ctx.root, ".gitleaksignore");
        if (isPlainFileInside(ctx.root, ".gitleaksignore")) {
          args.push("--gitleaks-ignore-path", ignore);
          repoWarnings.push(
            "honoring the repository's .gitleaksignore (--ignore-repo-config disables it)",
          );
        }
      }

      const r = await exec(ctx.binary, args, { cwd: dir, timeoutMs: ctx.timeoutMs });
      const fail = processFailure("gitleaks", r, [0]);
      if (fail) throw fail;
      const leaks = r.stdout.trim() ? parseJson<GitleaksLeak[] | null>("gitleaks", r.stdout) : [];
      const findings: RawFinding[] = (leaks ?? []).map((l) => ({
        engine: "gitleaks",
        ruleId: l.RuleID,
        category: "secrets",
        severity: "high",
        file: toRel(dir, l.File),
        line: l.StartLine || null,
        endLine: l.EndLine || null,
        message: l.Description,
        remediation: REMEDIATION,
        references: [],
      }));
      const warnings = [
        ...repoWarnings,
        ...(skippedLarge > 0 ? [`${skippedLarge} file(s) larger than 5 MB were not scanned`] : []),
      ];
      return { findings, warnings };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
