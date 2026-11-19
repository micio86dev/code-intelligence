import type { Config } from "../core/config.ts";
import { chunkByLength, exec } from "../core/exec.ts";
import type { RawFinding, Severity } from "../types.ts";
import { type Engine, type EngineOutput, isLockfile, type RunContext } from "./engine.ts";
import { detectBinary, parseJson, processFailure, toRel } from "./util.ts";

interface SemgrepResult {
  check_id: string;
  path: string;
  start: { line: number };
  end: { line: number };
  extra: {
    severity: string;
    message: string;
    fix?: string;
    metadata?: { references?: unknown; shortlink?: string; cwe?: unknown };
  };
}
interface SemgrepOutput {
  version?: string;
  results: SemgrepResult[];
  errors?: Array<{ level?: string; type?: unknown; path?: string }>;
}

const SEVERITY: Record<string, Severity> = { ERROR: "high", WARNING: "medium", INFO: "low" };
const ARG_BUDGET = process.platform === "win32" ? 6000 : 60_000;

const isRegistry = (c: string) => /^[pr]\//.test(c);

export const semgrep: Engine = {
  name: "semgrep",
  category: "sast",
  priority: 0,
  binaryName: "semgrep",
  installHint: "Install: brew install semgrep (or pipx install semgrep)",
  detect: () => detectBinary("semgrep", ["--version"], semgrep.installHint),
  select(target) {
    const files = target.files.filter((f) => !isLockfile(f));
    return files.length > 0
      ? { files, skipReason: null }
      : { files: null, skipReason: "no scannable files in scope" };
  },
  // Registry rulesets change remotely, so only fully local rule sets are safe to cache.
  cacheable: (c: Config) => c.engines.semgrep.configs.every((x) => !isRegistry(x)),
  cacheInputs: (c: Config) => c.engines.semgrep.configs,
  async run(ctx: RunContext): Promise<EngineOutput> {
    const base = ["scan", "--metrics=off", "--json", "--quiet", "--disable-version-check"];
    for (const c of ctx.config.engines.semgrep.configs) base.push("--config", c);

    const findings: RawFinding[] = [];
    const nonFatal: string[] = [];
    let version: string | undefined;
    // Leading "./" keeps a file named "-x" from being read as an option.
    for (const chunk of chunkByLength(
      ctx.files.map((f) => (f.startsWith("-") ? `./${f}` : f)),
      ARG_BUDGET,
    )) {
      const r = await exec(ctx.binary, [...base, ...chunk], {
        cwd: ctx.root,
        timeoutMs: ctx.timeoutMs,
        env: { SEMGREP_SEND_METRICS: "off" },
      });
      const fail = processFailure("semgrep", r, [0]);
      if (fail) throw fail;
      const out = parseJson<SemgrepOutput>("semgrep", r.stdout);
      version ??= out.version;
      for (const er of out.errors ?? []) {
        // Type and path only: semgrep error messages can quote source code.
        const type = Array.isArray(er.type)
          ? String(er.type[0])
          : typeof er.type === "string"
            ? er.type
            : "Error";
        nonFatal.push(`${type}${er.path ? ` in ${toRel(ctx.root, er.path)}` : ""}`);
      }
      for (const m of out.results) {
        const refs = Array.isArray(m.extra.metadata?.references)
          ? (m.extra.metadata.references as unknown[]).filter(
              (x): x is string => typeof x === "string",
            )
          : [];
        if (m.extra.metadata?.shortlink) refs.unshift(m.extra.metadata.shortlink);
        findings.push({
          engine: "semgrep",
          ruleId: m.check_id,
          category: "sast",
          severity: SEVERITY[m.extra.severity] ?? "medium",
          file: toRel(ctx.root, m.path),
          line: m.start.line,
          endLine: m.end.line,
          message: m.extra.message.replace(/\s+/g, " ").trim(),
          remediation: m.extra.fix ? `Suggested fix: ${m.extra.fix}` : null,
          references: [...new Set(refs)].slice(0, 3),
        });
      }
    }
    const warnings =
      nonFatal.length > 0
        ? [
            `semgrep reported ${nonFatal.length} non-fatal error(s): ${nonFatal.slice(0, 3).join("; ")}${nonFatal.length > 3 ? "; ..." : ""}`,
          ]
        : [];
    return version ? { findings, warnings, version } : { findings, warnings };
  },
};
