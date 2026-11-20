#!/usr/bin/env node
// Reproducible benchmark.
//   node bench/run.mjs [--out bench/results/latest.json] [--repos self,express] [--runs 3]
// Needs: git, gitleaks, semgrep, osv-scanner, network (clones, semgrep registry rules, OSV API),
// and a built CLI (npm run build). Run it on an otherwise idle machine: timings are wall-clock.
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, loadavg, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../dist/cli.js");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const OUT = resolve(opt("out", join(here, "results/latest.json")));
const RUNS = Number(opt("runs", "3"));
const ONLY = (opt("repos", "") ?? "").split(",").filter(Boolean);
const WORK = process.env.BENCH_DIR ?? join(tmpdir(), "code-intel-bench");

const CORPUS = [
  { name: "self", kind: "small (TypeScript)", url: resolve(here, "..") },
  { name: "express", kind: "medium (JavaScript)", url: "https://github.com/expressjs/express.git" },
  { name: "flask", kind: "medium (Python)", url: "https://github.com/pallets/flask.git" },
  {
    name: "juice-shop",
    kind: "large, multi-language, intentionally vulnerable (TypeScript/JavaScript/HTML/YAML)",
    url: "https://github.com/juice-shop/juice-shop.git",
  },
].filter((r) => ONLY.length === 0 || ONLY.includes(r.name));

const env = { ...process.env, NO_COLOR: "1" };
delete env.NODE_TEST_CONTEXT;
// The result cache lives outside the repository; give the benchmark its own so it never touches yours.
env.CODE_INTEL_CACHE_DIR = mkdtempSync(join(tmpdir(), "ci-bench-cache-"));
process.on("exit", () => rmSync(env.CODE_INTEL_CACHE_DIR, { recursive: true, force: true }));

/** Run a command under /usr/bin/time to capture wall time and peak RSS of the process tree's largest member. */
function timed(cmd, cmdArgs, cwd) {
  const t0 = performance.now();
  const mac = platform() === "darwin";
  const wrapped = mac
    ? ["/usr/bin/time", ["-l", cmd, ...cmdArgs]]
    : existsSync("/usr/bin/time")
      ? ["/usr/bin/time", ["-v", cmd, ...cmdArgs]]
      : [cmd, cmdArgs];
  const r = spawnSync(wrapped[0], wrapped[1], { cwd, env, encoding: "utf8", maxBuffer: 1 << 28 });
  const wallMs = Math.round(performance.now() - t0);
  const err = r.stderr ?? "";
  let peakRssMb = null;
  const m1 = /(\d+)\s+maximum resident set size/.exec(err); // macOS, bytes
  const m2 = /Maximum resident set size \(kbytes\): (\d+)/.exec(err); // Linux, KiB
  if (m1) peakRssMb = Math.round(Number(m1[1]) / 1048576);
  else if (m2) peakRssMb = Math.round(Number(m2[1]) / 1024);
  return { wallMs, code: r.status, stdout: r.stdout, peakRssMb };
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { runs: xs, median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1] };
};
const maxOf = (xs) => xs.filter((x) => x !== null).reduce((a, b) => Math.max(a, b), 0) || null;
const scan = (cwd, extra = []) =>
  timed(process.execPath, [CLI, "scan", "--format", "json", ...extra], cwd);
const parse = (r) => JSON.parse(r.stdout);
const safeCount = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

function ensureRepo(r) {
  mkdirSync(WORK, { recursive: true });
  const dir = join(WORK, r.name);
  if (!existsSync(dir)) {
    const local = !r.url.startsWith("http");
    execFileSync("git", ["clone", "--quiet", ...(local ? [] : ["--depth", "1"]), r.url, dir], {
      stdio: "ignore",
    });
  }
  execFileSync("git", ["checkout", "--quiet", "."], { cwd: dir });
  execFileSync("git", ["clean", "-fdq"], { cwd: dir });
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  const files = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" })
    .split("\n")
    .filter(Boolean).length;
  return { dir, sha, files };
}

/** The existing workflow: each scanner run by hand over the whole repository, one after another. */
function runManual(dir) {
  const gl = timed(
    "gitleaks",
    [
      "dir",
      ".",
      "--no-banner",
      "--redact",
      "--exit-code",
      "0",
      "--report-format",
      "json",
      "--report-path",
      "-",
    ],
    dir,
  );
  const sg = timed(
    "semgrep",
    [
      "scan",
      "--config",
      "p/default",
      "--metrics=off",
      "--json",
      "--quiet",
      "--disable-version-check",
      ".",
    ],
    dir,
  );
  const osv = timed("osv-scanner", ["scan", "source", "-r", ".", "--format", "json"], dir);
  return {
    wallMs: gl.wallMs + sg.wallMs + osv.wallMs,
    perToolMs: { gitleaks: gl.wallMs, semgrep: sg.wallMs, "osv-scanner": osv.wallMs },
    peakRssMb: { gitleaks: gl.peakRssMb, semgrep: sg.peakRssMb, "osv-scanner": osv.peakRssMb },
    findings: {
      gitleaks: safeCount(() => (gl.stdout.trim() ? JSON.parse(gl.stdout).length : 0)),
      semgrep: safeCount(() => JSON.parse(sg.stdout).results.length),
      "osv-scanner": safeCount(() =>
        JSON.parse(osv.stdout)
          .results.flatMap((r) => r.packages ?? [])
          .reduce((a, p) => a + (p.groups?.length ?? 0), 0),
      ),
    },
  };
}

function summarize(j) {
  return {
    complete: j.complete,
    exitCode: j.exitCode,
    findings: j.summary.total,
    bySeverity: j.summary.bySeverity,
    engines: Object.fromEntries(
      j.engines.map((e) => [
        e.engine,
        {
          status: e.status,
          ms: e.durationMs,
          findings: e.findingCount,
          cached: e.cached,
          warnings: e.warnings.length,
        },
      ]),
    ),
    sumEngineMs: j.engines.reduce((a, e) => a + e.durationMs, 0),
  };
}

const results = {
  generatedAt: new Date().toISOString().slice(0, 10),
  machine: {
    os: `${platform()} ${release()}`,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    memGB: Math.round(totalmem() / 2 ** 30),
  },
  node: process.version,
  runsPerScenario: RUNS,
  tools: {},
  repos: {},
};
for (const [k, c] of Object.entries({
  gitleaks: ["version"],
  semgrep: ["--version"],
  "osv-scanner": ["--version"],
})) {
  results.tools[k] = (spawnSync(k, c, { encoding: "utf8" }).stdout ?? "").trim().split("\n")[0];
}

for (const r of CORPUS) {
  console.error(`== ${r.name}`);
  const { dir, sha, files } = ensureRepo(r);
  const out = {
    kind: r.kind,
    commit: sha,
    trackedFiles: files,
    loadAvg1mAtStart: Number(loadavg()[0].toFixed(2)),
  };

  // A+B interleaved so slow drift (thermal, network) hits both sides equally.
  const manualRuns = [];
  const coldRuns = [];
  let lastCold;
  for (let i = 0; i < RUNS; i++) {
    manualRuns.push(runManual(dir));
    lastCold = scan(dir, ["--all", "--no-cache"]);
    coldRuns.push(lastCold);
  }
  const lastJson = parse(lastCold);
  out.manualSequentialFullScan = {
    wallMs: stats(manualRuns.map((m) => m.wallMs)),
    perToolMedianMs: Object.fromEntries(
      ["gitleaks", "semgrep", "osv-scanner"].map((t) => [
        t,
        stats(manualRuns.map((m) => m.perToolMs[t])).median,
      ]),
    ),
    peakRssMb: Object.fromEntries(
      ["gitleaks", "semgrep", "osv-scanner"].map((t) => [
        t,
        maxOf(manualRuns.map((m) => m.peakRssMb[t])),
      ]),
    ),
    findings: manualRuns[0].findings,
  };
  out.codeIntelFullCold = {
    wallMs: stats(coldRuns.map((c) => c.wallMs)),
    peakRssMb: maxOf(coldRuns.map((c) => c.peakRssMb)),
    ...summarize(lastJson),
  };
  out.findingList = lastJson.findings.map((f) => ({
    engine: f.engine,
    ruleId: f.ruleId,
    severity: f.severity,
    file: f.file,
    line: f.line,
  }));

  // C. Cache: populate once, then re-run. Only engines that declare themselves cacheable are reused.
  scan(dir, ["--all"]);
  const warmRuns = [];
  let lastWarm;
  for (let i = 0; i < RUNS; i++) {
    lastWarm = scan(dir, ["--all"]);
    warmRuns.push(lastWarm.wallMs);
  }
  out.codeIntelFullWarm = { wallMs: stats(warmRuns), ...summarize(parse(lastWarm)) };
  rmSync(env.CODE_INTEL_CACHE_DIR, { recursive: true, force: true }); // cold again for the next scenario

  // D. Incremental: change one source file and scan only the change.
  const target =
    execFileSync("git", ["ls-files", "*.js", "*.ts", "*.py"], { cwd: dir, encoding: "utf8" })
      .split("\n")
      .find((f) => f && !f.includes("test")) ?? null;
  if (target) {
    const orig = readFileSync(join(dir, target), "utf8");
    const runs = [];
    let last;
    for (let i = 0; i < RUNS; i++) {
      writeFileSync(join(dir, target), `${orig}\n// bench ${i}\n`);
      last = scan(dir, ["--no-cache"]);
      runs.push(last.wallMs);
    }
    writeFileSync(join(dir, target), orig);
    out.codeIntelIncrementalOneFile = {
      file: target,
      wallMs: stats(runs),
      peakRssMb: last.peakRssMb,
      ...summarize(parse(last)),
    };
  }
  out.loadAvg1mAtEnd = Number(loadavg()[0].toFixed(2));
  results.repos[r.name] = out;
  const mm = out.manualSequentialFullScan.wallMs.median;
  const cc = out.codeIntelFullCold.wallMs.median;
  console.error(
    `   manual median ${mm}ms | code-intel cold median ${cc}ms | findings ${out.codeIntelFullCold.findings}`,
  );
}

// E. Defect injection on a clean repository: is each planted defect caught, and does the pipeline lose anything raw semgrep reports?
if (results.repos.express) {
  console.error("== defect injection (express copy)");
  const tmp = mkdtempSync(join(tmpdir(), "ci-inject-"));
  const dir = join(tmp, "express");
  cpSync(join(WORK, "express"), dir, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore", env });
  git("config", "user.email", "bench@example.invalid");
  git("config", "user.name", "bench");
  const fakeKey = `AKIA${"QYLPMN5HHXWF2ZPD"}`; // built at runtime: no scannable secret lives in this file
  const planted = {
    "lib/injected-secret.js": `module.exports = { aws_access_key_id: "${fakeKey}" };\n`,
    "lib/injected-sqli.js": `const db = require("./db");\nmodule.exports = (req, res) => {\n  db.query("SELECT * FROM users WHERE id = " + req.query.id);\n  eval(req.body.code);\n  res.end();\n};\n`,
    "lib/injected-exec-destructured.js": `const { exec } = require("child_process");\nmodule.exports = (req) => exec("ls " + req.query.dir);\n`,
    "lib/injected-exec-inline.js": `module.exports = (req) => require("child_process").exec("ls " + req.query.dir);\n`,
    "package-lock.json": JSON.stringify({
      name: "x",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "x", version: "1.0.0", dependencies: { lodash: "4.17.15" } },
        "node_modules/lodash": {
          version: "4.17.15",
          resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz",
        },
      },
    }),
  };
  for (const [f, c] of Object.entries(planted)) writeFileSync(join(dir, f), c);
  git("add", "-f", "package-lock.json"); // express git-ignores lockfiles; force it into the change set
  const run = scan(dir, ["--no-cache"]);
  const j = parse(run);
  const has = (re, file) => j.findings.some((f) => re.test(f.ruleId) && f.file === file);
  const detection = {
    "hardcoded AWS access key": has(/aws-access-token/, "lib/injected-secret.js"),
    "SQL injection via string concatenation": has(
      /sql|code-string-concat/i,
      "lib/injected-sqli.js",
    ),
    "eval of request data": has(/eval/i, "lib/injected-sqli.js"),
    "command injection, destructured require('child_process')": has(
      /child-process|exec|command/i,
      "lib/injected-exec-destructured.js",
    ),
    "command injection, inline require('child_process').exec": has(
      /child-process|exec|command/i,
      "lib/injected-exec-inline.js",
    ),
    "vulnerable dependency (lodash 4.17.15)": has(/^GHSA-/, "package-lock.json"),
  };
  // Fidelity: what does raw semgrep say about exactly these files? Anything it reports that we do not is a pipeline loss.
  const injected = Object.keys(planted).filter((f) => f.endsWith(".js"));
  const raw = spawnSync(
    "semgrep",
    [
      "scan",
      "--config",
      "p/default",
      "--metrics=off",
      "--json",
      "--quiet",
      "--disable-version-check",
      ...injected,
    ],
    { cwd: dir, env, encoding: "utf8", maxBuffer: 1 << 28 },
  );
  const rawIds = new Set(
    JSON.parse(raw.stdout).results.map((x) => `${x.path}:${x.start.line}:${x.check_id}`),
  );
  const ours = new Set(
    j.findings
      .filter((f) => f.engine === "semgrep" || f.alsoReportedBy.includes("semgrep"))
      .map((f) => `${f.file}:${f.line}:${f.ruleId}`),
  );
  const lost = [...rawIds].filter((x) => !ours.has(x));
  results.defectInjection = {
    detection,
    detected: Object.values(detection).filter(Boolean).length,
    total: Object.keys(detection).length,
    wallMs: run.wallMs,
    exitCode: run.code,
    rawSemgrepFindingsOnInjectedFiles: rawIds.size,
    rawSemgrepFindingsMissingFromCodeIntel: lost,
    ruleIdsReported: [...new Set(j.findings.map((f) => `${f.engine}:${f.ruleId}`))],
  };
  rmSync(tmp, { recursive: true, force: true });
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
console.error(`wrote ${OUT}`);
