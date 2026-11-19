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
  paths?: { scanned?: string[] };
}

const SEVERITY: Record<string, Severity> = { ERROR: "high", WARNING: "medium", INFO: "low" };
const ARG_BUDGET = process.platform === "win32" ? 6000 : 60_000;
/** Source files semgrep can analyze; used only to decide whether a "not scanned" warning is meaningful. */
const CODE_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|sh)$/;
/** Characters that would turn a file name into a broader glob when passed to --include. */
const GLOB_CHARS = /[*?[\]{}\\!]/;

/** Semgrep's hardcoded-credential rules live under `*.secrets.*`; they are secrets findings, not generic SAST. */
const isSecretsRule = (id: string) => id.split(".").includes("secrets");

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

    // Semgrep's own file discovery applies .gitignore, .semgrepignore and its default ignores
    // (tests, vendored and minified code). Passing explicit file paths would bypass all of that and
    // make us noisier than the tool we wrap, so we always hand it the directory and narrow it with
    // root-anchored --include patterns (a bare `index.js` would also match every nested index.js).
    const runs: string[][] = [];
    if (ctx.mode === "all") {
      runs.push([...base, ...ctx.exclude.flatMap((e) => ["--exclude", e]), "."]);
    } else {
      const plain = ctx.files.filter((f) => !GLOB_CHARS.test(f) && !f.includes("\n"));
      const special = ctx.files.filter((f) => !plain.includes(f));
      for (const chunk of chunkByLength(
        plain.map((f) => `/${f}`),
        ARG_BUDGET,
      )) {
        runs.push([...base, ...chunk.flatMap((p) => ["--include", p]), "."]);
      }
      // Rare: names with glob characters cannot be anchored safely, so pass them explicitly.
      for (const chunk of chunkByLength(
        special.map((f) => (f.startsWith("-") ? `./${f}` : f)),
        ARG_BUDGET,
      )) {
        runs.push([...base, ...chunk]);
      }
    }

    const findings: RawFinding[] = [];
    const nonFatal: string[] = [];
    const scanned = new Set<string>();
    let sawScannedList = false;
    let version: string | undefined;
    for (const args of runs) {
      const r = await exec(ctx.binary, args, {
        cwd: ctx.root,
        timeoutMs: ctx.timeoutMs,
        env: { SEMGREP_SEND_METRICS: "off" },
      });
      const fail = processFailure("semgrep", r, [0]);
      if (fail) throw fail;
      const out = parseJson<SemgrepOutput>("semgrep", r.stdout);
      version ??= out.version;
      if (out.paths?.scanned) sawScannedList = true;
      for (const p of out.paths?.scanned ?? []) scanned.add(toRel(ctx.root, p));
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
          category: isSecretsRule(m.check_id) ? "secrets" : "sast",
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

    const warnings: string[] = [];
    if (nonFatal.length > 0) {
      warnings.push(
        `semgrep reported ${nonFatal.length} non-fatal error(s): ${nonFatal.slice(0, 3).join("; ")}${nonFatal.length > 3 ? "; ..." : ""}`,
      );
    }
    if (ctx.mode !== "all" && sawScannedList) {
      const missed = ctx.files.filter((f) => CODE_RE.test(f) && !scanned.has(f));
      if (missed.length > 0) {
        warnings.push(
          `${missed.length} changed source file(s) were not scanned by semgrep because of its default ignores (for example tests/ or vendored code) or a .semgrepignore: ${missed.slice(0, 3).join(", ")}${missed.length > 3 ? ", ..." : ""}`,
        );
      }
    }
    return version ? { findings, warnings, version } : { findings, warnings };
  },
};
