// Portable timing for operating systems where the full benchmark cannot run (for example Windows, where
// semgrep has no native build). It times only the engines that are installed, on this repository, and
// records which engines were missing, so a result is never presented as covering a scanner that did not run.
//
//   node bench/os-timing.mjs --out results.json [--runs 3]
//
// Needs a built CLI (npm run build). Wall-clock numbers: run on an otherwise idle machine.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const cli = join(repo, "dist", "cli.js");
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const out = opt("out", "os-timing.json");
const runs = Number(opt("runs", "3"));

const cache = mkdtempSync(join(tmpdir(), "ci-os-cache-"));
const env = { ...process.env, NO_COLOR: "1", CODE_INTEL_CACHE_DIR: cache };
delete env.NODE_TEST_CONTEXT;

const run = (cmd, args) => {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { cwd: repo, env, encoding: "utf8", maxBuffer: 1 << 28 });
  return {
    ms: Math.round(performance.now() - t0),
    status: r.status,
    stdout: r.stdout ?? "",
    error: r.error,
  };
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const stats = (xs) => ({
  runs: xs,
  median: median(xs),
  min: Math.min(...xs),
  max: Math.max(...xs),
});
const repeat = (fn) => stats(Array.from({ length: runs }, () => fn()));

const doctor = run(process.execPath, [cli, "doctor", "--json"]);
const engines = JSON.parse(doctor.stdout).engines;
const available = engines.filter((e) => e.available).map((e) => e.name);
const missing = engines.filter((e) => !e.available).map((e) => e.name);

const report = {
  generatedAt: new Date().toISOString().slice(0, 10),
  machine: {
    os: `${platform()} ${release()}`,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    memGB: Math.round(totalmem() / 2 ** 30),
  },
  node: process.version,
  runsPerScenario: runs,
  repository: "this repository (small, TypeScript)",
  enginesAvailable: available,
  enginesMissing: missing,
  scenarios: {},
};

const secrets = available.includes("gitleaks");
if (secrets) {
  const report0 = join(cache, "gitleaks.json");
  report.scenarios.gitleaksByHand = repeat(
    () =>
      run("gitleaks", [
        "dir",
        ".",
        "--no-banner",
        "--redact",
        "--exit-code",
        "0",
        "--report-format",
        "json",
        "--report-path",
        report0,
      ]).ms,
  );
  report.scenarios.codeIntelSecretsOnly = repeat(
    () =>
      run(process.execPath, [
        cli,
        "scan",
        "--all",
        "--no-cache",
        "--engines",
        "secrets",
        "--format",
        "json",
      ]).ms,
  );
}
const deps = available.includes("osv-scanner") || available.includes("trivy");
if (secrets && deps) {
  report.scenarios.codeIntelSecretsAndDeps = repeat(
    () =>
      run(process.execPath, [
        cli,
        "scan",
        "--all",
        "--no-cache",
        "--engines",
        "secrets,deps",
        "--format",
        "json",
      ]).ms,
  );
}
report.scenarios.doctor = repeat(() => run(process.execPath, [cli, "doctor"]).ms);

rmSync(cache, { recursive: true, force: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.error(
  `wrote ${out}; engines available: ${available.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`,
);
