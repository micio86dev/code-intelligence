#!/usr/bin/env node
// Reproducible benchmark. Usage: node bench/run.mjs [--out bench/results/latest.json] [--repos a,b] [--runs 3]
// Needs: git, gitleaks, semgrep, osv-scanner, network (clones + registry rules + OSV API).
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
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../dist/cli.js");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const OUT = resolve(opt("out", join(here, "results/latest.json")));
const RUNS = Number(opt("runs", "3"));
const ONLY = opt("repos", "")?.split(",").filter(Boolean);
const WORK = process.env.BENCH_DIR ?? join(tmpdir(), "code-intel-bench");

const CORPUS = [
  { name: "self", kind: "small", url: resolve(here, "..") },
  { name: "express", kind: "medium (JavaScript)", url: "https://github.com/expressjs/express.git" },
  { name: "flask", kind: "medium (Python)", url: "https://github.com/pallets/flask.git" },
  {
    name: "juice-shop",
    kind: "large, multi-language, intentionally vulnerable (TypeScript/JS/HTML/YAML)",
    url: "https://github.com/juice-shop/juice-shop.git",
  },
].filter((r) => ONLY.length === 0 || ONLY.includes(r.name));

const env = { ...process.env, NO_COLOR: "1" };
delete env.NODE_TEST_CONTEXT;

/** Run a command under /usr/bin/time -l (macOS) to capture wall time and peak RSS. */
function timed(cmd, cmdArgs, cwd) {
  const t0 = performance.now();
  const isMac = platform() === "darwin";
  const r = isMac
    ? spawnSync("/usr/bin/time", ["-l", cmd, ...cmdArgs], {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 1 << 28,
      })
    : spawnSync(cmd, cmdArgs, { cwd, env, encoding: "utf8", maxBuffer: 1 << 28 });
  const wallMs = Math.round(performance.now() - t0);
  const m = /(\d+)\s+maximum resident set size/.exec(r.stderr ?? "");
  return {
    wallMs,
    code: r.status,
    stdout: r.stdout,
    peakRssMb: m ? Math.round(Number(m[1]) / 1048576) : null,
  };
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const scan = (cwd, extra = []) =>
  timed(process.execPath, [CLI, "scan", "--format", "json", ...extra], cwd);
const parse = (r) => JSON.parse(r.stdout);

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

function summarize(j) {
  return {
    complete: j.complete,
    exitCode: j.exitCode,
    findings: j.summary.total,
    bySeverity: j.summary.bySeverity,
    engines: Object.fromEntries(
      j.engines.map((e) => [
        e.engine,
        { status: e.status, ms: e.durationMs, findings: e.findingCount, cached: e.cached },
      ]),
    ),
    sumEngineMs: j.engines.reduce((a, e) => a + e.durationMs, 0),
    wallInternalMs: j.durationMs,
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
  runs: RUNS,
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
  const out = { kind: r.kind, commit: sha, trackedFiles: files };

  // A. The existing workflow: run each scanner by hand over the whole repo, one after another.
  const manual = {
    gitleaks: timed(
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
        "/dev/null",
      ],
      dir,
    ),
    semgrep: timed(
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
    ),
    "osv-scanner": timed("osv-scanner", ["scan", "source", "-r", ".", "--format", "json"], dir),
  };
  out.manualSequentialFullScan = {
    wallMs: Object.values(manual).reduce((a, m) => a + m.wallMs, 0),
    perToolMs: Object.fromEntries(Object.entries(manual).map(([k, v]) => [k, v.wallMs])),
  };

  // B. code-intel quick, whole repo, cold (no cache).
  const full = scan(dir, ["--all", "--no-cache"]);
  out.codeIntelFullCold = {
    wallMs: full.wallMs,
    peakRssMb: full.peakRssMb,
    ...summarize(parse(full)),
  };

  // C. Cache: second run of the same scan. Only engines that declare themselves cacheable are reused.
  scan(dir, ["--all"]);
  const warm = scan(dir, ["--all"]);
  out.codeIntelFullWarm = { wallMs: warm.wallMs, ...summarize(parse(warm)) };
  rmSync(join(dir, ".code-intel"), { recursive: true, force: true });

  // D. Incremental: change one file, scan only the change.
  const target =
    execFileSync("git", ["ls-files", "*.js", "*.ts", "*.py"], { cwd: dir, encoding: "utf8" })
      .split("\n")
      .find((f) => f && !f.includes("test")) ?? null;
  if (target) {
    const orig = readFileSync(join(dir, target), "utf8");
    const times = [];
    let last;
    for (let i = 0; i < RUNS; i++) {
      writeFileSync(join(dir, target), `${orig}\n// bench ${i}\n`);
      const inc = scan(dir, ["--no-cache"]);
      times.push(inc.wallMs);
      last = inc;
    }
    writeFileSync(join(dir, target), orig);
    out.codeIntelIncrementalOneFile = {
      file: target,
      wallMsRuns: times,
      wallMsMedian: median(times),
      peakRssMb: last.peakRssMb,
      ...summarize(parse(last)),
    };
  }
  results.repos[r.name] = out;
  console.error(
    `   manual ${out.manualSequentialFullScan.wallMs}ms | code-intel full ${out.codeIntelFullCold.wallMs}ms | findings ${out.codeIntelFullCold.findings}`,
  );
}

// E. Defect injection on a clean repo: does each planted defect get caught?
if (results.repos.express) {
  console.error("== defect injection (express copy)");
  const tmp = mkdtempSync(join(tmpdir(), "ci-inject-"));
  const dir = join(tmp, "express");
  cpSync(join(WORK, "express"), dir, { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore", env });
  git("config", "user.email", "bench@example.invalid");
  git("config", "user.name", "bench");
  const fakeKey = `AKIA${"QYLPMN5HHXWF2ZPD"}`;
  writeFileSync(
    join(dir, "lib/injected-secret.js"),
    `module.exports = { aws_access_key_id: "${fakeKey}" };\n`,
  );
  writeFileSync(
    join(dir, "lib/injected-sqli.js"),
    `const db = require("./db");\nmodule.exports = (req, res) => {\n  db.query("SELECT * FROM users WHERE id = " + req.query.id);\n  eval(req.body.code);\n  require("child_process").exec("ls " + req.query.dir);\n  res.end();\n};\n`,
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
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
  );
  const run = scan(dir, ["--no-cache"]);
  const j = parse(run);
  const has = (re, file) => j.findings.some((f) => re.test(f.ruleId) && (!file || f.file === file));
  const planted = {
    "hardcoded AWS access key": has(/aws-access-token/, "lib/injected-secret.js"),
    "SQL injection via string concatenation": has(
      /sql|code-string-concat|tainted-sql/i,
      "lib/injected-sqli.js",
    ),
    "eval of request data": has(/eval/i, "lib/injected-sqli.js"),
    "command injection via exec": has(/exec|command|child-process|shell/i, "lib/injected-sqli.js"),
    "vulnerable dependency (lodash 4.17.15)": has(/^GHSA-/, "package-lock.json"),
  };
  results.defectInjection = {
    planted,
    detected: Object.values(planted).filter(Boolean).length,
    total: Object.keys(planted).length,
    wallMs: run.wallMs,
    exitCode: run.code,
    ruleIdsReported: [...new Set(j.findings.map((f) => `${f.engine}:${f.ruleId}`))].slice(0, 30),
  };
  rmSync(tmp, { recursive: true, force: true });
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
console.error(`wrote ${OUT}`);
