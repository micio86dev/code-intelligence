import { existsSync } from "node:fs";
import { join } from "node:path";
import { chunkByLength, exec } from "../core/exec.ts";
import type { RawFinding, Severity } from "../types.ts";
import { type Engine, type EngineOutput, isLockfile, type RunContext } from "./engine.ts";
import { detectBinary, parseJson, processFailure } from "./util.ts";

interface AstGrepMatch {
  file: string;
  ruleId: string;
  severity: string;
  message?: string;
  note?: string | null;
  range: { start: { line: number }; end: { line: number } };
}

const SEVERITY: Record<string, Severity> = {
  error: "high",
  warning: "medium",
  info: "low",
  hint: "info",
};
const CONFIGS = ["sgconfig.yml", "sgconfig.yaml"];
const ARG_BUDGET = process.platform === "win32" ? 6000 : 60_000;

/**
 * Architecture boundaries as code: runs the rules a team keeps in sgconfig.yml
 * (e.g. "src/domain must not import src/infra"). Runs only when that config exists;
 * we ship no rules of our own, so we never invent opinions about your architecture.
 */
export const astGrep: Engine = {
  name: "ast-grep",
  category: "architecture",
  priority: 0,
  binaryName: "ast-grep",
  installHint: "Install: brew install ast-grep (or npm i -g @ast-grep/cli)",
  detect: () => detectBinary("ast-grep", ["--version"], astGrep.installHint),
  select(target) {
    if (!CONFIGS.some((c) => existsSync(join(target.root, c)))) {
      return {
        files: null,
        skipReason: "no sgconfig.yml: add ast-grep rules to enforce architecture boundaries",
      };
    }
    const files = target.files.filter((f) => !isLockfile(f));
    return files.length > 0
      ? { files, skipReason: null }
      : { files: null, skipReason: "no scannable files in scope" };
  },
  // Rules live in project files that are not part of the cache key, so never reuse results.
  cacheable: () => false,
  cacheInputs: () => [],
  async run(ctx: RunContext): Promise<EngineOutput> {
    const findings: RawFinding[] = [];
    for (const chunk of chunkByLength(
      ctx.files.map((f) => (f.startsWith("-") ? `./${f}` : f)),
      ARG_BUDGET,
    )) {
      const r = await exec(ctx.binary, ["scan", "--json=compact", ...chunk], {
        cwd: ctx.root,
        timeoutMs: ctx.timeoutMs,
      });
      // 0 = clean, 1 = error-level diagnostics found (a successful scan); anything else is a failure.
      const fail = processFailure("ast-grep", r, [0, 1]);
      if (fail) throw fail;
      const matches = r.stdout.trim() ? parseJson<AstGrepMatch[]>("ast-grep", r.stdout) : [];
      for (const m of matches) {
        findings.push({
          engine: "ast-grep",
          ruleId: m.ruleId,
          category: "architecture",
          severity: SEVERITY[m.severity] ?? "medium",
          file: m.file.replace(/\\/g, "/").replace(/^\.\//, ""),
          line: m.range.start.line + 1,
          endLine: m.range.end.line + 1,
          message: m.message ?? m.ruleId,
          remediation: m.note ?? null,
          references: [],
        });
      }
    }
    return { findings, warnings: [] };
  },
};
