import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { UsageError } from "../core/errors.ts";
import { exec } from "../core/exec.ts";
import { isSafeGlob } from "../core/glob.ts";
import type { Logger } from "../core/logger.ts";
import { isPlainFileInside } from "../core/safefs.ts";
import { resolveTarget } from "../core/targets.ts";
import { ENGINES } from "../engines/registry.ts";
import { firstLine } from "../engines/util.ts";
import type { TargetMode } from "../types.ts";
import { TOOL_NAME, VERSION } from "../version.ts";
import { isTestFile } from "./impact.ts";

export interface Survivor {
  line: number;
  mutator: string;
  replacement: string | null;
}

export interface FileMutation {
  file: string;
  total: number;
  killed: number;
  survived: number;
  noCoverage: number;
  timeout: number;
  /** Percent of valid mutants the tests detected; null when there were none. */
  score: number | null;
  survivors: Survivor[];
}

export interface MutationReport {
  schemaVersion: 1;
  tool: { name: string; version: string };
  engine: "stryker";
  engineVersion: string | null;
  status: "ok" | "unavailable" | "timeout" | "error" | "skipped";
  reason: string | null;
  target: { mode: TargetMode | "files"; ref: string | null };
  files: FileMutation[];
  totals: {
    total: number;
    killed: number;
    survived: number;
    noCoverage: number;
    timeout: number;
    score: number | null;
  };
  skippedFiles: Array<{ file: string; reason: string }>;
  notes: string[];
  durationMs: number;
  minScore: number | null;
  exitCode: 0 | 1 | 3;
}

const JS_RE = /\.[cm]?[jt]sx?$/;
const OTHER_SRC_RE = /\.(?:py|go|rs|java|kt|cs|rb|php|swift)$/;
const STRYKER_BIN = ["node_modules", "@stryker-mutator", "core", "bin", "stryker.js"];
const CONFIG_NAMES = [
  "stryker.config.json",
  "stryker.config.js",
  "stryker.config.mjs",
  "stryker.config.cjs",
  "stryker.conf.json",
  "stryker.conf.js",
  "stryker.conf.mjs",
  "stryker.conf.cjs",
  ".stryker.conf.json",
];
const SURVIVOR_CAP = 25;

interface StrykerMutant {
  mutatorName: string;
  status: string;
  replacement?: string;
  location: { start: { line: number } };
}
interface StrykerReport {
  files: Record<string, { mutants: StrykerMutant[] }>;
}

const score = (detected: number, valid: number): number | null =>
  valid === 0 ? null : Math.round((detected / valid) * 1000) / 10;

function summarize(file: string, mutants: StrykerMutant[]): FileMutation {
  const c = { killed: 0, survived: 0, noCoverage: 0, timeout: 0 };
  const survivors: Survivor[] = [];
  for (const m of mutants) {
    if (m.status === "Killed") c.killed += 1;
    else if (m.status === "Timeout") c.timeout += 1;
    else if (m.status === "Survived" || m.status === "NoCoverage") {
      if (m.status === "Survived") c.survived += 1;
      else c.noCoverage += 1;
      survivors.push({
        line: m.location.start.line,
        mutator: m.mutatorName,
        replacement: m.replacement ?? null,
      });
    }
  }
  survivors.sort((a, b) => a.line - b.line);
  const valid = c.killed + c.timeout + c.survived + c.noCoverage;
  return {
    file,
    total: mutants.length,
    ...c,
    score: score(c.killed + c.timeout, valid),
    survivors,
  };
}

function totalsOf(files: FileMutation[]): MutationReport["totals"] {
  const t = { total: 0, killed: 0, survived: 0, noCoverage: 0, timeout: 0 };
  for (const f of files) {
    t.total += f.total;
    t.killed += f.killed;
    t.survived += f.survived;
    t.noCoverage += f.noCoverage;
    t.timeout += f.timeout;
  }
  return {
    ...t,
    score: score(t.killed + t.timeout, t.killed + t.timeout + t.survived + t.noCoverage),
  };
}

function pruneEmptyDirs(root: string, rels: string[]): void {
  for (const rel of rels) {
    const dir = join(root, rel);
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      /* leave it */
    }
  }
}

export async function runMutate(opts: {
  cwd: string;
  mode: TargetMode | null;
  ref: string | null;
  files: string[];
  timeoutMs: number;
  minScore: number | null;
  log: Logger;
}): Promise<MutationReport> {
  const started = performance.now();
  const probe = await resolveTarget({ cwd: opts.cwd, mode: "all", ref: null, exclude: [] }).catch(
    () => null,
  );
  const root = probe?.root ?? opts.cwd;
  const config = loadConfig(
    root,
    ENGINES.map((e) => e.name),
  );

  // 1. What to mutate: explicit files, or the changed files with their changed line ranges.
  let candidates: string[];
  let changedLines = new Map<string, Array<{ start: number; end: number }>>();
  let targetInfo: MutationReport["target"];
  if (opts.files.length > 0) {
    for (const f of opts.files) {
      if (!isSafeGlob(f) || !isPlainFileInside(root, f))
        throw new UsageError(`Cannot mutate '${f}': not a regular file inside the repository`);
    }
    candidates = opts.files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
    targetInfo = { mode: "files", ref: null };
  } else {
    const t = await resolveTarget({
      cwd: opts.cwd,
      mode: opts.mode ?? "changed",
      ref: opts.ref,
      exclude: config.exclude,
    });
    candidates = t.files;
    changedLines = t.changedLines;
    targetInfo = { mode: t.mode, ref: t.ref };
  }

  const skippedFiles: MutationReport["skippedFiles"] = [];
  const toMutate: string[] = [];
  for (const f of candidates) {
    if (isTestFile(f) || f.endsWith(".d.ts")) continue;
    if (JS_RE.test(f)) {
      if (f.includes(","))
        skippedFiles.push({
          file: f,
          reason: "file name contains a comma, which Stryker cannot select",
        });
      else toMutate.push(f);
    } else if (OTHER_SRC_RE.test(f)) {
      skippedFiles.push({
        file: f,
        reason:
          "no mutation engine for this language (supported: JavaScript/TypeScript via StrykerJS)",
      });
    }
  }

  const base = (over: Partial<MutationReport>): MutationReport => ({
    schemaVersion: 1,
    tool: { name: TOOL_NAME, version: VERSION },
    engine: "stryker",
    engineVersion: null,
    status: "ok",
    reason: null,
    target: targetInfo,
    files: [],
    totals: totalsOf([]),
    skippedFiles,
    notes: [],
    durationMs: 0,
    minScore: opts.minScore,
    exitCode: 0,
    ...over,
  });
  const finish = (r: MutationReport): MutationReport => ({
    ...r,
    durationMs: Math.round(performance.now() - started),
  });

  if (toMutate.length === 0) {
    return finish(
      base({
        status: "skipped",
        reason: "no JavaScript/TypeScript source files to mutate in scope",
      }),
    );
  }

  // 2. Is Stryker installed in the project? (It must be a project dependency: it runs the project's own tests.)
  const bin = join(root, ...STRYKER_BIN);
  if (!existsSync(bin)) {
    return finish(
      base({
        status: "unavailable",
        reason:
          "StrykerJS is not installed in this project. Install: npm install --save-dev @stryker-mutator/core",
        exitCode: 3,
      }),
    );
  }
  let engineVersion: string | null = null;
  try {
    engineVersion = (
      JSON.parse(
        readFileSync(join(root, "node_modules/@stryker-mutator/core/package.json"), "utf8"),
      ) as { version: string }
    ).version;
  } catch {
    /* version is informational */
  }

  // 3. How to run the tests: the project's Stryker config, else its `npm test` script.
  const hasConfig = CONFIG_NAMES.some((n) => existsSync(join(root, n)));
  const args = [
    bin,
    "run",
    "--reporters",
    "json",
    // `--mutate=<list>` as one argument: a file named like an option can never be read as a flag.
    `--mutate=${toMutate
      .map((f) => {
        const ranges = changedLines.get(f);
        return ranges && ranges.length > 0
          ? ranges.map((r) => `${f}:${r.start}-${r.end}`).join(",")
          : f;
      })
      .join(",")}`,
  ];
  if (!hasConfig) {
    let testScript = "";
    try {
      testScript = (
        (
          JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
            scripts?: { test?: string };
          }
        ).scripts?.test ?? ""
      ).trim();
    } catch {
      /* handled below */
    }
    if (!testScript || /no test specified/.test(testScript)) {
      return finish(
        base({
          engineVersion,
          status: "error",
          reason:
            "No Stryker config and no usable `test` script in package.json; add one or create a stryker.config.json",
          exitCode: 3,
        }),
      );
    }
    args.push(
      "--testRunner",
      "command",
      "--commandRunner.command",
      "npm test",
      "--coverageAnalysis",
      "off",
    );
  }

  const reportDir = join(root, "reports", "mutation");
  const reportFile = join(reportDir, "mutation.json");
  const hadReport = existsSync(reportFile);
  const hadReports = existsSync(join(root, "reports"));
  const hadTmp = existsSync(join(root, ".stryker-tmp"));

  opts.log.info("running stryker", { files: toMutate.length });
  const r = await exec(process.execPath, args, {
    cwd: root,
    timeoutMs: opts.timeoutMs,
    env: { CI: "1" },
  });

  let report: StrykerReport | null = null;
  try {
    if (existsSync(reportFile))
      report = JSON.parse(readFileSync(reportFile, "utf8")) as StrykerReport;
  } catch {
    report = null;
  }
  // Leave the project as we found it.
  if (!hadReport) rmSync(reportFile, { force: true });
  if (!hadTmp) rmSync(join(root, ".stryker-tmp"), { recursive: true, force: true });
  if (!hadReports) pruneEmptyDirs(root, ["reports/mutation", "reports"]);

  if (r.spawnError)
    return finish(
      base({
        engineVersion,
        status: "error",
        reason: `cannot start node: ${r.spawnError.message}`,
        exitCode: 3,
      }),
    );
  if (r.timedOut) {
    return finish(
      base({
        engineVersion,
        status: "timeout",
        reason: `mutation run exceeded ${Math.round(opts.timeoutMs / 1000)}s and was killed; no partial results are available. Narrow the scope or raise --timeout`,
        exitCode: 3,
      }),
    );
  }
  if (r.code !== 0) {
    const detail =
      firstLine(r.stderr) ||
      firstLine(
        r.stdout
          .split("\n")
          .filter((l) => /error/i.test(l))
          .join("\n"),
      );
    return finish(
      base({
        engineVersion,
        status: "error",
        reason: `stryker exited with code ${r.code}${detail ? ` (${detail.replace(/\u001b\[[0-9;]*m/g, "")})` : ""}`,
        exitCode: 3,
      }),
    );
  }

  const files = report
    ? Object.entries(report.files).map(([f, v]) => summarize(f.replace(/\\/g, "/"), v.mutants))
    : [];
  const totals = totalsOf(files);
  const notes: string[] = [];
  if (files.length === 0)
    notes.push(
      "Stryker generated no mutants for the selected code (nothing mutable in the changed lines).",
    );
  if (totals.score === 0 && totals.total > 0) {
    notes.push(
      "Score is 0%: no mutant was detected. Check that your test command really runs tests (a command that runs zero tests still exits 0).",
    );
  }
  if (changedLines.size > 0 && opts.files.length === 0)
    notes.push("Mutants were limited to the changed lines of each file.");
  if (files.some((f) => f.survivors.length > SURVIVOR_CAP))
    notes.push(
      `Only the first ${SURVIVOR_CAP} survivors per file are listed; totals are complete.`,
    );
  for (const f of files) f.survivors = f.survivors.slice(0, SURVIVOR_CAP);

  const below = opts.minScore !== null && totals.score !== null && totals.score < opts.minScore;
  return finish(base({ engineVersion, files, totals, notes, exitCode: below ? 1 : 0 }));
}

export function renderMutation(r: MutationReport): string {
  const L = [
    `${r.tool.name} ${r.tool.version} | mutate | ${r.engine}${r.engineVersion ? ` ${r.engineVersion}` : ""} | ${(r.durationMs / 1000).toFixed(1)}s`,
    "",
  ];
  if (r.status !== "ok")
    L.push(`Status: ${r.status.toUpperCase()}${r.reason ? `: ${r.reason}` : ""}`, "");
  for (const f of r.files) {
    L.push(
      `${f.file}: score ${f.score === null ? "n/a" : `${f.score}%`} (${f.killed + f.timeout} detected, ${f.survived} survived, ${f.noCoverage} uncovered, ${f.total} total)`,
    );
    for (const s of f.survivors)
      L.push(
        `  survived  line ${s.line}  ${s.mutator}${s.replacement ? ` -> ${s.replacement.slice(0, 60)}` : ""}`,
      );
  }
  if (r.status === "ok") {
    L.push(
      "",
      `Mutation score: ${r.totals.score === null ? "n/a" : `${r.totals.score}%`} (${r.totals.survived + r.totals.noCoverage} undetected of ${r.totals.total} mutants)`,
    );
    if (r.totals.survived + r.totals.noCoverage > 0)
      L.push(
        "A survivor is a behavior change your tests did not notice: add or strengthen a test for that line.",
      );
  }
  for (const s of r.skippedFiles) L.push(`Skipped ${s.file}: ${s.reason}`);
  for (const n of r.notes) L.push(`Note: ${n}`);
  if (r.exitCode === 1)
    L.push(`Result: FAIL (exit 1): mutation score below --min-score ${r.minScore}.`);
  else if (r.exitCode === 3)
    L.push("Result: INCOMPLETE (exit 3): mutation testing did not run to completion.");
  else if (r.status === "skipped") L.push("Result: SKIPPED (exit 0): nothing to mutate.");
  else L.push("Result: OK (exit 0)");
  return `${L.join("\n")}\n`;
}
